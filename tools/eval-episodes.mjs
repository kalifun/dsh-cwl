// dsh-cwl episode 推断质量评测工具（任务一 · 3.2）
// 目的：测量 deriveEpisodes 的 expl/act 切分、类型分类、依赖边与人工 ground truth 的吻合度。
// 用法：
//   1) 无 GT（生成待审清单 + 内部不变量检查）:
//      node tools/eval-episodes.mjs <session.jsonl>
//   2) 有 GT（计算 precision/recall/F1）:
//      node tools/eval-episodes.mjs <session.jsonl> <ground-truth.json>
// GT 格式（episodes 用绝对 seq 引用，不依赖生成的 expl-N 命名）:
//   { "episodes": [
//       { "startSeq": 100, "endSeq": 104, "type": "expl" },
//       { "startSeq": 200, "endSeq": 210, "type": "act", "deps": [100] }  // deps = 依赖的 expl 的 startSeq
//   ] }
// 输出：boundary+type 的 P/R/F1；依赖边的 P/R/F1（仅统计能配对的 act）。
import { readFileSync } from 'node:fs'
import { deriveEpisodes } from '../lib.js'

const file = process.argv[2]
const gtFile = process.argv[3]
if (!file) { console.error('用法: node tools/eval-episodes.mjs <session.jsonl> [ground-truth.json]'); process.exit(1) }

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const raw = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const events = raw.filter((e) => SURFACE_TYPES.has(e.type))

// ---- 内部不变量（无需 GT） ----
const assistantSeq = new Set()
for (const ev of events) if (ev.type === 'assistant/message') assistantSeq.add(ev.seq)
const toolCallAssistants = events.filter((ev) => {
  if (ev.type !== 'assistant/message') return false
  return (ev.data?.message?.content ?? []).some((b) => b?.type === 'tool-call')
})
const userMsgCount = events.filter((e) => e.type === 'user/message').length

const eps = deriveEpisodes(events)
const epsSorted = [...eps].sort((a, b) => a.startSeq - b.startSeq)

// 覆盖：每个含 tool-call 的 assistant 都应属于某 episode（deriveEpisodes 构造上保证）
const covered = new Set()
for (const e of epsSorted) for (const b of e.batches) covered.add(b.seq)
const uncovered = toolCallAssistants.filter((ev) => !covered.has(ev.seq))
// 重叠检查
let overlaps = 0
for (let i = 0; i < epsSorted.length; i++) {
  for (let j = i + 1; j < epsSorted.length; j++) {
    if (epsSorted[i].endSeq >= epsSorted[j].startSeq) overlaps++
  }
}

// ---- 可读清单（人工标注依据） ----
function fmtEpisode(e) {
  const read = [...new Set(e.readPaths)].slice(0, 3).join(',')
  return `  ${e.name} ${e.type} [${e.startSeq}-${e.endSeq}] batches=${e.batches.length} tools=[${e.toolNames.join(',')}]${read ? ` read={${read}}` : ''}${e.deps.length ? ` deps=[${e.deps.join(',')}]` : ''}`
}
console.log(`会话: ${file} | 轮数(user msg): ${userMsgCount} | tool-call assistant: ${toolCallAssistants.length}`)
console.log(`推断 episode: ${eps.length}（expl: ${eps.filter((e) => e.type === 'expl').length}, act: ${eps.filter((e) => e.type === 'act').length}）`)
console.log(`不变量: 覆盖率 ${(covered.size / Math.max(1, toolCallAssistants.length) * 100).toFixed(1)}%（未覆盖 ${uncovered.length}）| 重叠段 ${overlaps}`)
console.log('\n推断清单（人工标注/审查用）:')
for (const e of epsSorted) console.log(fmtEpisode(e))

if (!gtFile) {
  console.log('\n[提示] 未提供 ground truth。对存疑段做人工标注后存为 JSON，重跑本工具计算 P/R/F1。')
  process.exit(0)
}

// ---- 与 GT 对比 ----
const gt = JSON.parse(readFileSync(gtFile, 'utf8')).episodes.sort((a, b) => a.startSeq - b.startSeq)
const byType = (arr, t) => arr.filter((e) => e.type === t)
const gtExpls = byType(gt, 'expl')
const gtActs = byType(gt, 'act')
const prExpls = byType(eps, 'expl')
const prActs = byType(eps, 'act')

// 区间重叠度（两个 episode 的交集 / 较短者）
function overlapRatio(a, b) {
  const inter = Math.max(0, Math.min(a.endSeq, b.endSeq) - Math.max(a.startSeq, b.startSeq) + 1)
  const shorter = Math.min(a.endSeq - a.startSeq + 1, b.endSeq - b.startSeq + 1)
  return inter / shorter
}
// 最佳配对：GT episode → 预测 episode（类型必须相同且重叠 >= 0.5）
function matchPairs(gtList, prList) {
  const used = new Set()
  const pairs = []
  for (const g of gtList) {
    let best = null, bestOv = 0.49
    for (let i = 0; i < prList.length; i++) {
      if (used.has(i)) continue
      const ov = overlapRatio(g, prList[i])
      if (ov > bestOv) { bestOv = ov; best = i }
    }
    if (best !== null) { used.add(best); pairs.push([g, prList[best]]) }
  }
  return pairs
}
function scoreType(gtList, prList) {
  const pairs = matchPairs(gtList, prList)
  const tp = pairs.length
  const fp = prList.length - tp
  const fn = gtList.length - tp
  const p = tp / Math.max(1, tp + fp)
  const r = tp / Math.max(1, tp + fn)
  const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0
  return { tp, fp, fn, p: +p.toFixed(3), r: +r.toFixed(3), f1: +f1.toFixed(3), pairs }
}
function report(label, s) {
  console.log(`\n[${label}] TP=${s.tp} FP=${s.fp} FN=${s.fn} | P=${s.p} R=${s.r} F1=${s.f1}`)
  return s
}

console.log('\n== 评测 ==')
const rExpl = report('expl 段', scoreType(gtExpls, prExpls))
const rAct = report('act 段', scoreType(gtActs, prActs))
const allS = scoreType(gt, eps)
report('全部段', allS)

// 依赖边：只统计 act 配对成功者；pred deps 是 expl 名 → 映射到 startSeq 与 GT 对齐比较
const explStartByName = new Map(prExpls.map((e) => [e.name, e.startSeq]))
const predEdges = new Set() // "actStart->explStart"
const gtEdges = new Set()
const matchedActs = new Set([...rAct.pairs, ...rExpl.pairs].filter(([g, p]) => p.type === 'act' && g.type === 'act').map(([, p]) => p.startSeq))
const gtByStart = new Map(gtActs.map((g) => [g.startSeq, g]))
for (const [g, p] of rAct.pairs) {
  for (const d of p.deps ?? []) predEdges.add(`${p.startSeq}->${explStartByName.get(d) ?? '?'}`)
  for (const d of g.deps ?? []) gtEdges.add(`${g.startSeq}->${d}`)
}
let edgeTp = 0
for (const e of predEdges) if (gtEdges.has(e)) edgeTp++
const edgeFp = predEdges.size - edgeTp
const edgeFn = gtEdges.size - edgeTp
const ep = edgeTp / Math.max(1, edgeTp + edgeFp)
const er = edgeTp / Math.max(1, edgeTp + edgeFn)
console.log(`\n[依赖边] TP=${edgeTp} FP=${edgeFp} FN=${edgeFn} | P=${ep.toFixed(3)} R=${er.toFixed(3)} F1=${(ep + er > 0 ? (2 * ep * er) / (ep + er) : 0).toFixed(3)}（基于 ${matchedActs.size} 个配对 act）`)
console.log(`  预测边: ${[...predEdges].join(' ')}`)
console.log(`  GT 边:  ${[...gtEdges].join(' ')}`)
