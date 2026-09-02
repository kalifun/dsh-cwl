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
//
// 用法:
//   node tools/replay-real.mjs <session.jsonl> [order=tail] [budget=30000] [sorted] [--realistic] [--batch]
//     order   oldest | tail
//     budget  压力阈值（tokens）
//     sorted  用排序后的 newestAllowed（修复后算法；不传 = 旧算法对照）
import { readFileSync } from 'node:fs'
import { mergeRanges, pickEvictionTarget } from '../lib.js'

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
const REALISTIC = process.argv.includes('--realistic')
const BATCH = process.argv.includes('--batch')

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
console.log(`surface events: ${events.length} | 真实驱逐 marker: ${events.filter((e) => JSON.stringify(e.data?.content ?? '').includes('cwl-evicted')).length}`)

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

  // 真实模拟：驱逐直到压力回落到预算内（每次驱逐后追加 marker 并重测）
  const picks = []
  let live = [...surface]
  if (nextSeq === undefined) var nextSeq = events.length
  for (let g = 0; g < 20; g++) {
    if (usageTokens(log) <= BUDGET) break
    const t = pickEvictionTarget(log, live, boundary, { order: ORDER })
    if (!t) {
      // 区分"真 stall"(有候选但被边界/依赖过滤)与"正常耗尽"(可驱逐段已全部驱逐)
      const { deriveEpisodes } = await import('../lib.js')
      const epsRemain = deriveEpisodes(log).filter((e) => e.completed && live.includes(e.startSeq))
      if (epsRemain.length > 0) { stalls++; if (stallDetail.length < 3) stallDetail.push({ preStep, remaining: epsRemain.map((e) => `${e.name}(end=${e.endSeq})`) }) }
      else exhausted++
      break
    }
    picks.push(t)
    live = live.filter((s) => s < t.start || s > t.end)
    // 追加模拟 marker（user/message + surface replace），与引擎 evictRange 一致
    log.push({
      type: 'user/message',
      seq: nextSeq++, // 连续递增的新 seq（与真实引擎一致：append-only 单调 seq）
      data: { role: 'user', content: [{ type: 'text', text: `[cwl-evicted:${t.label} type=${t.type}]` }] },
      surfaceOp: { op: 'replace', start: t.start, end: t.end },
      sourceEventSeqs: surface.filter((s) => s >= t.start && s <= t.end),
    })
  }
  picksTotal += picks.length
  // 动作数：--batch 时合并相邻段（对齐 E2 的 replace 次数），否则逐段
  actionsTotal += BATCH ? mergeRanges(picks.map((p) => ({ start: p.start, end: p.end, label: p.label }))).length : picks.length
}

console.log(`\n== order=${ORDER} ${REALISTIC ? 'realistic' + (BATCH ? '+batch' : '') : 'regression'} ==`)
console.log(`总 pre-step: ${preStep} | 真 stall: ${stalls} 次 | 正常耗尽: ${exhausted} 次 | 总 picks: ${picksTotal}${REALISTIC ? ` | 驱逐动作数: ${actionsTotal}` : ''}`)
if (stallDetail.length) console.log('stall 详情:', JSON.stringify(stallDetail, null, 1))
