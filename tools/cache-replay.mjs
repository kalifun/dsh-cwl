// dsh-cwl 确定性 cacheRead 重放工具（任务二 · 方案 A）
// 目的：消除活体 agent 的轮间行为噪声，隔离"驱逐策略对前缀缓存的影响"。
// 方法：加载真实压力会话 → 按策略(none/oldest/tail/tail+batch)重放驱逐决策，
//       在每次 pre-step 边界快照"模型可见转录"(surface 投影)，然后按顺序
//       逐请求打 DeepSeek API(max_tokens=1，只读 usage)，累计 cacheRead。
//       每策略前置唯一 system 前缀 → 策略间缓存互不污染，组内前缀自然累积。
//
// 用法：
//   node tools/cache-replay.mjs <session.jsonl> [budget=30000] [--strategies none,oldest,tail,batch]
//     [--model deepseek-v4-flash] [--dry-run] [--limit N]
//   密钥：DEEPSEEK_API_KEY 环境变量或 ~/.dsh/.env
// 输出：每策略总 cacheRead(hit) / cacheMiss / 每 pre-step 明细 + 对比表
import { readFileSync } from 'node:fs'
import { readFileSync as readEnv } from 'node:fs'
import { mergeRanges, pickEvictionTarget } from '../lib.js'

const file = process.argv[2]
const BUDGET = Number(process.argv.find((a, i) => process.argv[i - 1] === '--budget') ?? 30000)
const strategiesArg = (process.argv.find((a, i) => process.argv[i - 1] === '--strategies') ?? 'none,oldest,tail,batch')
const STRATEGIES = strategiesArg.split(',')
const MODEL = process.argv.find((a, i) => process.argv[i - 1] === '--model') ?? 'deepseek-v4-flash'
const DRY = process.argv.includes('--dry-run')
const LIMIT = Number(process.argv.find((a, i) => process.argv[i - 1] === '--limit') ?? 0)
if (!file) { console.error('用法: node tools/cache-replay.mjs <session.jsonl> [--budget N] [--strategies none,oldest,tail,batch] [--dry-run]'); process.exit(1) }

// ---- 密钥 ----
function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const env = readEnv(`${process.env.HOME}/.dsh/.env`, 'utf8')
    const m = env.match(/^DEEPSEEK_API_KEY=(.+)$/m)
    if (m) return m[1].trim()
  } catch { /* ignore */ }
  console.error('缺少 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.env）')
  process.exit(1)
}

// ---- 事件加载与 seq 重基线（同 replay-real.mjs） ----
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const raw = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const seqMap = new Map()
let counter = 0
for (const ev of raw) if (typeof ev.seq === 'number') seqMap.set(ev.seq, counter++)
const events = []
for (const ev of raw) {
  if (!SURFACE_TYPES.has(ev.type)) continue
  const copy = { ...ev, seq: events.length, data: ev.data }
  if (ev.surfaceOp && typeof ev.surfaceOp === 'object') {
    copy.surfaceOp = { ...ev.surfaceOp, start: seqMap.get(ev.surfaceOp.start), end: seqMap.get(ev.surfaceOp.end) }
  }
  if (Array.isArray(ev.sourceEventSeqs)) copy.sourceEventSeqs = ev.sourceEventSeqs.map((s) => seqMap.get(s)).filter((s) => typeof s === 'number')
  events.push(copy)
}

// ---- 轻量 fold（等价 surface.ts applySurfacePlan） ----
function fold(log) {
  const nodes = []
  for (const ev of log) {
    if (!SURFACE_TYPES.has(ev.type)) continue
    const op = ev.surfaceOp
    if (op === undefined || op === 'append') { nodes.push(ev.seq); continue }
    if (op && op.op === 'replace') {
      const si = nodes.indexOf(op.start); const ei = nodes.indexOf(op.end)
      if (si >= 0 && ei >= 0 && si <= ei) nodes.splice(si, ei - si + 1, ev.seq)
    }
  }
  return nodes
}
const usageTokens = (log) => {
  const inSurface = new Set(fold(log))
  return log.reduce((a, ev) => {
    if (ev.type !== 'assistant/message' || !inSurface.has(ev.seq)) return a
    const u = ev.data?.usage ?? {}
    return a + (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0) + (u.reasoningTokens ?? 0)
  }, 0)
}

// ---- 转录序列化：surface 节点 → API 消息 ----
function serializeNode(ev) {
  const d = ev.data ?? {}
  const blocks = (d.message?.content ?? d.content ?? []).map ? (d.message?.content ?? d.content ?? []) : []
  const text = blocks
    .map((b) => {
      if (typeof b === 'string') return b
      if (b.type === 'text' || b.type === 'tool-result' || b.type === 'tool_result') return b.text ?? ''
      if (b.type === 'tool-call') {
        const args = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})
        return `[tool-call: ${b.name} ${args}]`
      }
      if (b.type === 'reasoning') return '' // 推理不进缓存测量（与请求投递一致地省略）
      return ''
    })
    .filter(Boolean)
    .join('\n')
  if (!text && ev.type !== 'user/message') return null // 空 assistant 跳过（同 deriveEventMessage）
  return text || '[empty]'
}
function toMessage(ev) {
  const t = serializeNode(ev)
  if (t === null) return null
  const role = ev.type === 'assistant/message' ? 'assistant' : ev.type === 'user/message' ? 'user' : 'user'
  return { role, content: role === 'user' && ev.type === 'tool/result' ? `[tool-result]\n${t}` : t }
}
function snapshotMessages(log) {
  const nodes = fold(log)
  const msgs = []
  for (const seq of nodes) {
    const ev = log.find((e) => e.seq === seq)
    if (!ev) continue
    const m = toMessage(ev)
    if (m) msgs.push(m)
  }
  return msgs
}

// ---- 单策略重放：返回该策略的请求转录序列 ----
function replayStrategy(order, batch, evict = true) {
  const log = []
  let nextSeq = events.length
  const requests = []
  for (const ev of events) {
    if (ev.type === 'assistant/message' && ev.data?.usage) {
      // pre-step：超预算则按策略驱逐。与真实引擎 collectTargets 一致：
      // 先收集候选（预算在收集期间不变），再统一追加 marker；batch 合并相邻段。
      if (evict && usageTokens(log) > BUDGET) {
        const surface = fold(log)
        let live = [...surface]
        const picks = []
        for (let g = 0; g < 20; g++) {
          const t = pickEvictionTarget(log, live, sortedBoundary(fold(log)), { order })
          if (!t) break
          picks.push(t)
          live = live.filter((s) => s < t.start || s > t.end)
        }
        const ranges = batch
          ? mergeRanges(picks.map((p) => ({ start: p.start, end: p.end, label: p.label })))
          : picks.map((p) => ({ start: p.start, end: p.end, labels: [p.label], type: p.type }))
        for (const r of ranges) {
          const shadowed = surface.filter((s) => s >= r.start && s <= r.end)
          log.push({
            type: 'user/message', seq: nextSeq++,
            data: { content: [{ type: 'text', text: `[cwl-evicted:${r.labels.join('+')}]` }] },
            surfaceOp: { op: 'replace', start: r.start, end: r.end },
            sourceEventSeqs: shadowed,
          })
        }
      }
      // 本 pre-step 的请求 = 当前 committed log 的转录（不含即将到来的 assistant）
      requests.push(snapshotMessages(log))
    }
    log.push(ev)
    if (LIMIT > 0 && requests.length >= LIMIT) break
  }
  return requests
}
function sortedBoundary(surface) {
  const s = [...surface].sort((a, b) => a - b)
  return s.length > 2 ? s[s.length - 2 - 1] : -1
}

// ---- 策略定义 ----
const POLICIES = {
  none: () => replayStrategy('oldest', false, false),
  oldest: () => replayStrategy('oldest', false),
  tail: () => replayStrategy('tail', false),
  batch: () => replayStrategy('tail', true),
}

// ---- API 调用 ----
async function callApi(apiKeyValue, messages, strategyTag) {
  const body = {
    model: MODEL,
    max_tokens: 1,
    messages: [{ role: 'system', content: strategyTag }, ...messages],
  }
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKeyValue}` },
    body: JSON.stringify(body),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(`API ${res.status}: ${JSON.stringify(j?.error ?? j).slice(0, 300)}`)
  const u = j.usage ?? {}
  return { hit: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0, miss: u.prompt_cache_miss_tokens ?? u.prompt_tokens ?? 0 }
}

// ---- 主流程 ----
const key = DRY ? null : apiKey()
console.log(`会话: ${file} | 策略: ${STRATEGIES.join(',')} | budget=${BUDGET} | model=${MODEL}${DRY ? ' | DRY-RUN' : ''}\n`)
const results = {}
for (const s of STRATEGIES) {
  const tag = `dsh-cwl-cache-replay ${s} ${Date.now()}` // 每策略唯一且稳定：组内共享前缀，组间隔离
  const requests = POLICIES[s]?.() ?? (() => { throw new Error(`未知策略 ${s}`) })()
  const totalTokens = requests.reduce((a, r) => a + r.reduce((x, m) => x + (m.content?.length ?? 0), 0), 0)
  console.log(`策略 ${s}: ${requests.length} 个请求 | 转录约 ${totalTokens} 字符`)
  if (DRY) { results[s] = { requests: requests.length, chars: totalTokens }; continue }
  let hit = 0, miss = 0
  const rows = []
  for (let i = 0; i < requests.length; i++) {
    const r = await callApi(key, requests[i], tag)
    hit += r.hit; miss += r.miss
    if (i < 3 || i % 5 === 4) rows.push(`  req#${i + 1}: hit=${r.hit} miss=${r.miss}`)
  }
  results[s] = { requests: requests.length, hit, miss, total: hit + miss, rows }
  console.log(`  cacheRead(hit): ${hit} | miss: ${miss}`)
  if (s !== 'none') console.log(rows.join('\n'))
  // 每组之间冷却：让唯一 system 前缀保证组间隔离（无需等待，前缀不同即隔离）
}
if (!DRY) {
  console.log('\n== 对比 ==')
  const base = results.none?.hit ?? 0
  for (const s of STRATEGIES) {
    if (s === 'none') continue
    const delta = base > 0 ? (((results[s].hit - base) / base) * 100).toFixed(1) : 'n/a'
    console.log(`  ${s.padEnd(7)}: cacheRead=${results[s].hit} (Δ vs none: ${delta}%)`)
  }
  console.log('\n注: 绝对 cacheRead 低于真实会话(无 system/tools 前缀);相对 Δ 才是策略效应。')
}
