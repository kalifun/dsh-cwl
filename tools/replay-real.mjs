// dsh-cwl 回归/预测工具：用真实压力会话回放 pre-step 驱逐决策
// 背景：tail 模式曾出现驱逐 1-3 段后 pickEvictionTarget 持续返回 null（压力失控）——
// 根因：episode 跨 user-message 边界未关闭 + newestAllowed 取自未排序 surface。
//
// 两种模式：
//   默认（回归检测）: 每个超预算 pre-step 检查是否至少能选出候选
//     stall=0 且 picks>0 = 驱逐可持续（修复生效）；stall>0 = 回归（仍会停摆）
//   --realistic [--batch]: 模拟真实引擎循环 —— 每次驱逐后追加 marker、重测压力、
//     低于预算即停，统计"驱逐动作数"（--batch 时合并相邻段，对齐 E2 的 replace 次数），
//     可与引擎实际驱逐动作数对比（回放预测 vs 引擎实际，差距主要来自预算停止与合并）。
//   --apply: apply 层回归 —— 从干净事件流(丢弃历史 replace 产物)镜像引擎完整循环
//     (决策 + strip 内容裁剪 + 整段驱逐)，每次 append 后用真实 @deepseek-ai/dsh-session
//     foldSurface 校验(事件构造/端点/shadowed sourceEventSeqs 合法性)；
//     校验失败按类型分类计数(end-not-found / shadowed-mismatch / provenance / ...)并回滚。
//     能抓住纯决策层重放测不出的 apply 层 bug(如 strip 后整段驱逐端点丢失、
//     shadowed 按 seq 过滤漏 stub 等历史缺陷)。需真实 surface 模块：
//     自动探测 helmsman 仓库，或设 DSH_SESSION_SURFACE 指向 surface.js。
//
// 用法:
//   node tools/replay-real.mjs <session.jsonl> [order=tail] [budget=30000] [sorted] [--realistic] [--batch]
//     order   oldest | tail
//     budget  压力阈值（tokens）
//     sorted  用排序后的 newestAllowed（修复后算法；不传 = 旧算法对照）
import { readFileSync } from 'node:fs'
import { deriveEpisodes, episodeBlock, largeResultSeqs, mergeBlocksByPos, mergeRanges, pickEvictionTarget, shadowedNodes, stubToolResultData } from '../lib.js'

// 轻量 fold：与 surface.ts 的 applySurfacePlan 语义等价（append 推尾 / replace 原位替换）
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
function fold(events) {
  const nodes = []
  for (const ev of events) {
    if (!SURFACE_TYPES.has(ev.type)) continue
    const op = ev.surfaceOp
    if (op === undefined || op === 'append') { nodes.push(ev.seq); continue }
    if (op && op.op === 'replace') {
      const si = nodes.indexOf(op.start)
      const ei = nodes.indexOf(op.end)
      if (si >= 0 && ei >= 0 && si <= ei) nodes.splice(si, ei - si + 1, ev.seq)
    }
  }
  return nodes
}

const file = process.argv[2]
const ORDER = process.argv[3] ?? 'tail'
const BUDGET = Number(process.argv[4] ?? 30000)
const PRESERVE_RECENT = 2
const REALISTIC = process.argv.includes('--realistic') || process.argv.includes('--apply') // --apply 隐含 realistic 执行
const BATCH = process.argv.includes('--batch')
const APPLY = process.argv.includes('--apply')   // 真实 apply 层回归: 执行 + 真实 foldSurface 校验
const DO_STRIP = !process.argv.includes('--no-strip')
const STRIP_THRESHOLD = Number(process.argv.find((a, i) => process.argv[i - 1] === '--strip-threshold')) || 1500

const raw = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

// 只保留 surface 事件，seq 重基线为连续 0..n（surfaceOp 的 start/end 同步重映射）
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
  if (Array.isArray(ev.sourceEventSeqs)) {
    copy.sourceEventSeqs = ev.sourceEventSeqs.map((s) => seqMap.get(s)).filter((s) => typeof s === 'number')
  }
  events.push(copy)
}
if (APPLY) {
  // apply 回归从"干净事件流"开始：丢弃历史 replace 产物(旧版本插件的驱逐 marker/stub
  // 自身可能不满足当前 fold 校验——那正是被测对象的历史 bug)，只保留 append 事件，
  // 重基线为连续 seq；驱逐/裁剪由模拟的当前引擎逻辑从头执行并逐次校验。
  const clean = events
    .filter((e) => e.surfaceOp === undefined || e.surfaceOp === 'append')
    .map((e, i) => ({ ...e, seq: i, sourceEventSeqs: undefined }))
  events.length = 0
  events.push(...clean)
}
console.log(`surface events: ${events.length} | 真实驱逐 marker: ${events.filter((e) => JSON.stringify(e.data?.content ?? '').includes('cwl-evicted')).length}${APPLY ? ' | [apply 模式: 已清理历史 replace 产物]' : ''}`)

// 加载真实 @deepseek-ai/dsh-session 的 foldSurface(apply 校验用):
// 顺序: 环境变量 DSH_SESSION_SURFACE → helmsman 仓库常见位置。找不到则 apply 模式退出。
async function loadRealFold() {
  const home = process.env.HOME ?? ''
  const candidates = [
    process.env.DSH_SESSION_SURFACE,
    `${home}/Code/github/opensource/helmsman/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js`,
    `${home}/Code/github/opensource/helmsman/dsh/node_modules/.pnpm/@deepseek-ai+dsh-session@*/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js`,
  ].filter(Boolean)
  for (const c of candidates) {
    try { const m = await import(c); if (m.foldSurface) return m.foldSurface } catch { /* 下一个 */ }
  }
  try {
    const m = await import('@deepseek-ai/dsh-session/surface')
    if (m.foldSurface) return m.foldSurface
  } catch { /* 未在可解析路径 */ }
  return null
}
function classifyApplyError(e) {
  const msg = e?.message ?? String(e)
  if (/end seq .* not found in surface/.test(msg)) return 'end-not-found'
  if (/sourceEventSeqs must include every shadowed/.test(msg)) return 'shadowed-mismatch'
  if (/sourceEventSeqs must reference earlier events/.test(msg)) return 'provenance'
  if (/not contiguous/.test(msg)) return 'contiguity'
  if (/start seq .* not found in surface/.test(msg)) return 'start-not-found'
  return 'other'
}

const log = []
const usageTokens = (l) => {
  const inSurface = new Set(fold(l))
  return l.reduce((a, ev) => {
    if (ev.type !== 'assistant/message' || !inSurface.has(ev.seq)) return a
    const u = ev.data?.usage ?? {}
    return a + (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0) + (u.reasoningTokens ?? 0)
  }, 0)
}
const sortedBoundary = (surface) =>
  surface.length > PRESERVE_RECENT ? [...surface].sort((a, b) => a - b)[surface.length - 1 - PRESERVE_RECENT] : -1
const positionalBoundary = (surface) =>
  surface.length > PRESERVE_RECENT ? surface[surface.length - 1 - PRESERVE_RECENT] : -1

let preStep = 0
let stalls = 0
let exhausted = 0
let picksTotal = 0
let actionsTotal = 0
let stallDetail = []

for (const ev of events) {
  log.push(ev)
  if (ev.type !== 'assistant/message' || !ev.data?.usage) continue
  preStep++
  const used = usageTokens(log)
  if (used <= BUDGET) continue

  const surface = fold(log)
  const boundary = process.argv.includes('sorted') ? sortedBoundary(surface) : positionalBoundary(surface)
  if (!REALISTIC) {
    // 回归检测：统计每个超预算 pre-step 能选出几个候选（不模拟 marker）
    let picks = 0
    let live = [...surface]
    for (let g = 0; g < 20; g++) {
      const t = pickEvictionTarget(log, live, boundary, { order: ORDER })
      if (!t) break
      picks++
      live = live.filter((s) => s < t.start || s > t.end)
    }
    picksTotal += picks
    if (picks === 0) {
      stalls++
      if (stalls <= 4) console.log(`[STALL] pre-step#${preStep} used=${used} boundary=${boundary} surface.len=${surface.length} 尾=[${surface.slice(-6).join(',')}]`)
    }
    continue
  }

  if (!APPLY) {
    // 真实模拟(无 apply 校验)：驱逐直到压力回落到预算内
    const picks = []
    let live = [...surface]
    if (nextSeq === undefined) var nextSeq = events.length
    for (let g = 0; g < 20; g++) {
      if (usageTokens(log) <= BUDGET) break
      const t = pickEvictionTarget(log, live, boundary, { order: ORDER })
      if (!t) {
        const epsRemain = deriveEpisodes(log).filter((e) => e.completed && live.includes(e.startSeq))
        if (epsRemain.length > 0) { stalls++; if (stallDetail.length < 3) stallDetail.push({ preStep, remaining: epsRemain.map((e) => `${e.name}(end=${e.endSeq})`) }) }
        else exhausted++
        break
      }
      picks.push(t)
      live = live.filter((s) => s < t.start || s > t.end)
      log.push({
        type: 'user/message', seq: nextSeq++,
        data: { role: 'user', content: [{ type: 'text', text: `[cwl-evicted:${t.label} type=${t.type}]` }] },
        surfaceOp: { op: 'replace', start: t.start, end: t.end },
        sourceEventSeqs: surface.filter((s) => s >= t.start && s <= t.end),
      })
    }
    picksTotal += picks.length
    actionsTotal += BATCH ? mergeRanges(picks.map((p) => ({ start: p.start, end: p.end, label: p.label }))).length : picks.length
    continue
  }

  // ---- apply 层回归：镜像引擎 collectTargets + 执行 + 真实 foldSurface 校验 ----
  // 模拟在隔离副本 work 上进行(append 会推进 log.length，不能污染外层真实事件流)
  const work = [...log]
  // 基础日志自身必须先通过真实 fold(历史会话可能含旧 bug 产物)
  if (!applyReady) {
    var applyReady = false
    const foldSurface = await loadRealFold()
    if (!foldSurface) { console.error('--apply 需要真实 @deepseek-ai/dsh-session surface(设 DSH_SESSION_SURFACE 或 helmsman 仓库)'); process.exit(1) }
    applyReady = true
    globalThis.__fold = foldSurface
    try { foldSurface(log) } catch (e) {
      console.error(`[apply] 基础日志自身不满足 fold 校验(${classifyApplyError(e)})，apply 回归跳过(旧 bug 产物会话)`); process.exit(0)
    }
  }
  const foldSurface = globalThis.__fold
  const stripped = new Set()
  const applyErr = {}
  const applyErrDetail = []
  const actLog = { strip: 0, evict: 0, applyFail: 0 }

  // 决策(与 index.js collectTargets 一致)：collect 完再统一执行
  const toEvict = []
  const toStrip = []
  const excluded = new Set()
  const surfaceSnap = [...foldSurface(work).nodes]
  const episodes = deriveEpisodes(work, { surface: surfaceSnap })
  const byStart = new Map(episodes.map((e) => [e.startSeq, e]))
  for (let g = 0; g < 20; g++) {
    if (usageTokens(work) <= BUDGET) break
    const occupied = [...toEvict, ...toStrip]
    const liveS = surfaceSnap.filter((s) => !occupied.some((p) => s >= p.start && s <= p.end))
    const t = pickEvictionTarget(work, liveS, boundary, { order: ORDER, exclude: excluded })
    if (!t) break
    const ep = byStart.get(t.start)
    if (ep?.type === 'expl' && DO_STRIP) {
      const todo = largeResultSeqs(work, ep, liveS, STRIP_THRESHOLD).filter((x) => !stripped.has(x.seq))
      if (todo.length) {
        toStrip.push({ start: t.start, end: t.end, seqs: todo.map((x) => x.seq) })
        excluded.add(t.start)
        continue
      }
    }
    toEvict.push({ ...t, posStart: ep?.posStart, posEnd: ep?.posEnd })
  }
  // 执行：先 strip 后 evict(镜像引擎)
  // 工具配对断言：每个 in-surface tool/result 的 toolCallId 必须存在对应的
  // in-surface assistant tool-call(LLM API 以 400 强制此不变量；孤儿消息是
  // fold 发现不了的任务级失败——整段驱逐位置性漏节点所致)。
  const pairingCheck = () => {
    const nodes = foldSurface(work).nodes
    const bySeq = new Map(work.map((e) => [e.seq, e]))
    const callIds = new Set()
    for (const seq of nodes) {
      const ev = bySeq.get(seq)
      if (ev?.type !== 'assistant/message') continue
      for (const b of ev.data?.message?.content ?? []) if (b?.type === 'tool-call' && b.id) callIds.add(b.id)
    }
    const orphans = []
    for (const seq of nodes) {
      const ev = bySeq.get(seq)
      if (ev?.type !== 'tool/result') continue
      const id = ev.data?.message?.content?.[0]?.toolCallId
      if (id && !callIds.has(id)) orphans.push({ seq, id })
    }
    if (orphans.length) {
      applyErr['orphan-tool'] = (applyErr['orphan-tool'] ?? 0) + orphans.length
      if (applyErrDetail.length < 5) applyErrDetail.push({ preStep, what: 'evict', kind: 'orphan-tool', msg: `孤儿 tool/result seq=${orphans[0].seq} id=${orphans[0].id}(共${orphans.length})` })
      return false
    }
    return true
  }
  const applyOne = (evt, what) => {
    work.push(evt)
    try { foldSurface(work) } catch (e) {
      work.pop() // 校验失败=引擎 append 拒绝,事件未提交 → 回滚
      const kind = classifyApplyError(e)
      applyErr[kind] = (applyErr[kind] ?? 0) + 1
      actLog.applyFail++
      if (applyErrDetail.length < 5) applyErrDetail.push({ preStep, what, kind, msg: (e?.message ?? '').slice(0, 140) })
      return false
    }
    if (what === 'evict' && !pairingCheck()) {
      work.pop() // 配对被破坏(孤儿 tool/result)→ 回滚,防止 LLM 400 级失败
      actLog.applyFail++
      return false
    }
    actLog[what]++
    return true
  }
  for (const s of toStrip) {
    for (const seq of s.seqs) {
      const orig = work.find((e) => e.seq === seq && e.type === 'tool/result')
      if (!orig) continue
      const evt = { type: 'tool/result', seq: work.length, time: Date.now(), surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq], data: stubToolResultData(orig, '[cwl-stub]') }
      if (!applyOne(evt, 'strip')) break
      stripped.add(seq)
    }
  }
  // 位置块驱逐(镜像新引擎: 位置区间端点 + posStart 降序; 不再用 seq 端点)
  const withPos = toEvict.filter((t) => t.posStart != null && t.posEnd != null)
  const units = BATCH
    ? mergeBlocksByPos(withPos.map((t) => ({ posStart: t.posStart, posEnd: t.posEnd, label: t.label, type: t.type })))
    : withPos.map((t) => ({ posStart: t.posStart, posEnd: t.posEnd, labels: [t.label], type: t.type }))
  units.sort((a, b) => b.posStart - a.posStart)
  for (const u of units) {
    if (actLog.applyFail > 0) break // 引擎失败即中止本 pre-step 后续动作
    const live = [...foldSurface(work).nodes]
    if (u.posEnd >= live.length) continue
    const block = live.slice(u.posStart, u.posEnd + 1)
    if (!block.length) continue
    const evt = { type: 'user/message', seq: work.length, time: Date.now(), data: { role: 'user', content: [{ type: 'text', text: `[cwl-evicted:${u.labels.join('+')}]` }] }, surfaceOp: { op: 'replace', start: block[0], end: block[block.length - 1] }, sourceEventSeqs: block }
    applyOne(evt, 'evict')
  }
  picksTotal += toEvict.length
  actionsTotal += units.length
  var applyStats = { strip: actLog.strip, evict: actLog.evict, err: applyErr, detail: applyErrDetail }
  continue
}
// 汇总行在 apply 模式下追加
if (typeof applyStats !== 'undefined' && applyStats) {
  const errStr = Object.entries(applyStats.err).map(([k, v]) => `${k}:${v}`).join(' ') || '无'
  console.log(`apply 层: strip=${applyStats.strip} evict=${applyStats.evict} | 校验失败: ${errStr}`)
  for (const d of applyStats.detail) console.log(`  [apply-fail] pre-step#${d.preStep} ${d.what} ${d.kind}: ${d.msg}`)
}

console.log(`\n== order=${ORDER} ${REALISTIC ? 'realistic' + (BATCH ? '+batch' : '') : 'regression'} ==`)
console.log(`总 pre-step: ${preStep} | 真 stall: ${stalls} 次 | 正常耗尽: ${exhausted} 次 | 总 picks: ${picksTotal}${REALISTIC || APPLY ? ` | 驱逐动作数: ${actionsTotal}` : ''}`)
if (stallDetail.length) console.log('stall 详情:', JSON.stringify(stallDetail, null, 1))
