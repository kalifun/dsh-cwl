// dsh-cwl 会话分析工具（任务二 cache 优化用）
// 输入：dsh-session-persistence-jsonl 的会话文件（含 assistant/message usage 事件）
// 输出：逐轮 usage 明细 + 驱逐时间线 + 关键指标"驱逐后下一轮 cacheRead"对比
// 用法：node tools/analyze-session.mjs <session.jsonl> [--json]
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const asJson = process.argv.includes('--json')
if (!file) {
  console.error('用法: node tools/analyze-session.mjs <session.jsonl> [--json]')
  process.exit(1)
}

const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

// ---- 逐轮 usage 分桶（按 data.turn）+ 驱逐时间线（按 seq 归属轮次） ----
const rounds = new Map() // turn -> {turn, input, cache, output, reason, steps}
const evictions = [] // {seq, turn, text}
let currentTurn = null

for (const ev of events) {
  const d = ev.data ?? {}
  if (ev.type === 'assistant/message') {
    currentTurn = d.turn ?? currentTurn
    const turn = currentTurn ?? 0
    const u = d.usage
    const r = rounds.get(turn) ?? { turn, input: 0, cache: 0, output: 0, reason: 0, steps: 0 }
    if (u) {
      r.input += u.inputTokens ?? 0
      r.cache += u.cacheReadTokens ?? 0
      r.output += u.outputTokens ?? 0
      r.reason += u.reasoningTokens ?? 0
    }
    r.steps += 1
    rounds.set(turn, r)
  } else if (ev.type === 'user/message') {
    const text = (d.content ?? []).map((b) => b.text ?? '').join('')
    if (text.startsWith('[cwl-evicted:')) {
      evictions.push({ seq: ev.seq, turn: currentTurn, text: text.slice(0, 140) })
    }
  }
}

const list = [...rounds.values()].sort((a, b) => a.turn - b.turn)

// ---- 关键指标：驱逐发生在轮 T 之后 → 轮 T+1 的 cacheRead ----
const evictedBeforeTurn = new Set(evictions.map((e) => e.turn + 1))
const afterEviction = list.filter((r) => evictedBeforeTurn.has(r.turn))
const normal = list.filter((r) => !evictedBeforeTurn.has(r.turn))
const avg = (arr, k) => (arr.length ? Math.round(arr.reduce((a, r) => a + r[k], 0) / arr.length) : 0)

const summary = {
  file,
  turns: list.length,
  total: list.reduce(
    (a, r) => ({ input: a.input + r.input, cache: a.cache + r.cache, output: a.output + r.output, reason: a.reason + r.reason }),
    { input: 0, cache: 0, output: 0, reason: 0 },
  ),
  evictions: evictions.length,
  metric: {
    avgCacheReadAfterEviction: avg(afterEviction, 'cache'),
    avgCacheReadNormal: avg(normal, 'cache'),
    roundsAfterEviction: afterEviction.length,
    roundsNormal: normal.length,
  },
  evictionTimeline: evictions,
}

if (asJson) {
  console.log(JSON.stringify({ ...summary, rounds: list }, null, 2))
} else {
  console.log(`会话: ${file}`)
  console.log(`轮次: ${list.length} | 驱逐: ${evictions.length} 次`)
  console.log('\n逐轮 usage:')
  console.log(' 轮次 | input | cacheRead | output | reasoning | steps | 前轮有驱逐')
  for (const r of list) {
    const flag = evictedBeforeTurn.has(r.turn) ? ' ◀' : ''
    console.log(`  ${String(r.turn).padEnd(4)}| ${String(r.input).padEnd(6)}| ${String(r.cache).padEnd(10)}| ${String(r.output).padEnd(7)}| ${String(r.reason).padEnd(9)}| ${String(r.steps).padEnd(5)}|${flag}`)
  }
  console.log('\n合计:', JSON.stringify(summary.total))
  console.log('\n关键指标（驱逐后下一轮 cacheRead vs 普通轮）:')
  console.log(`  驱逐后轮均 cacheRead: ${summary.metric.avgCacheReadAfterEviction}（${afterEviction.length} 轮）`)
  console.log(`  普通轮均 cacheRead:   ${summary.metric.avgCacheReadNormal}（${normal.length} 轮）`)
  const ratio = summary.metric.avgCacheReadNormal > 0
    ? ((summary.metric.avgCacheReadAfterEviction - summary.metric.avgCacheReadNormal) / summary.metric.avgCacheReadNormal * 100).toFixed(1)
    : 'n/a'
  console.log(`  差异: ${ratio}%`)
  if (evictions.length) {
    console.log('\n驱逐时间线:')
    for (const e of evictions) console.log(`  seq=${e.seq} turn=${e.turn} → 影响下一轮: ${e.text}`)
  }
}
