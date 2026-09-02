// dsh-cwl episode 标注辅助工具（任务一 3.2）——"审查+修正"模式，非从零标注
// 流程：
//   1) 运行本工具：自动推断 episode 并附证据（前一轮用户消息、工具参数、读/写路径）
//   2) 审查每段：正确的不用动；错误的在输出 JSON 里改（类型/合并/拆分/依赖）
//   3) 保存为 ground truth 文件，再跑 tools/eval-episodes.mjs 算 P/R/F1
//
// 用法：
//   node tools/annotate-episodes.mjs <session.jsonl>              # 打印证据清单
//   node tools/annotate-episodes.mjs <session.jsonl> --gt-out gt.json  # 输出预填 GT 骨架
//
// 标注规则（判断依据，保持一致）：
//   expl = 只含 read/search/list/glob/grep/find/web_search（纯探索，无副作用）
//   act  = 含任何 bash/edit/write 等动作；混合批次(read+bash)归类 act
//   边界 = 一个用户请求回合通常一段；同一回合内不同语义工作可拆多段
//   依赖 = act 触碰(写/改)的文件曾被更早的 expl 读过（路径需归一化后一致）
import { readFileSync, writeFileSync } from 'node:fs'
import { deriveEpisodes } from '../lib.js'

const file = process.argv[2]
const gtOut = process.argv.find((a, i) => process.argv[i - 1] === '--gt-out')
if (!file) { console.error('用法: node tools/annotate-episodes.mjs <session.jsonl> [--gt-out gt.json]'); process.exit(1) }

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const raw = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const events = raw.filter((e) => SURFACE_TYPES.has(e.type))

// 每条消息前的最近用户消息文本（回合上下文；跳过 cwl 驱逐 marker）
function userContext(seq) {
  let text = ''
  for (const ev of events) {
    if (ev.seq > seq) break
    if (ev.type === 'user/message') {
      const t = (ev.data?.content ?? []).map((b) => (typeof b === 'string' ? b : b.text ?? '')).join(' ').trim()
      if (t.startsWith('[cwl-evicted:')) continue // 插件 notice，非真实用户回合
      text = t.slice(0, 150)
    }
  }
  return text
}
function trunc(s, n = 90) { return s.length > n ? s.slice(0, n) + '…' : s }

const eps = [...deriveEpisodes(events)].sort((a, b) => a.startSeq - b.startSeq)
const explStartByName = new Map(eps.filter((e) => e.type === 'expl').map((e) => [e.name, e.startSeq]))
const gt = { episodes: [] }

console.log(`会话: ${file}\n== 逐段审查清单（推断结果 + 证据；正确段无需改动） ==\n`)
for (const e of eps) {
  const ctx = userContext(e.startSeq)
  console.log(`■ ${e.name}  type=${e.type}  seq=[${e.startSeq}-${e.endSeq}]  deps=[${e.deps.join(',') || '无'}]`)
  if (ctx) console.log(`  回合: ${trunc(ctx)}`)
  const touched = new Set([...e.readPaths, ...(e.touchedPaths ?? [])])
  for (const b of e.batches) {
    const args = typeof b.names !== 'undefined'
      ? '' : ''
    console.log(`  批次: ${b.names.join(' + ')}`)
  }
  if (e.readPaths.length) console.log(`  读过: ${[...new Set(e.readPaths)].join(', ')}`)
  if (e.touchedPaths?.length) console.log(`  触碰: ${[...new Set(e.touchedPaths)].join(', ')}`)
  // GT 骨架：参考已推断值，审查时只改不对的；deps 以依赖 expl 的 startSeq 引用
  const depSeqs = (e.deps ?? []).map((d) => explStartByName.get(d)).filter((s) => s !== undefined)
  gt.episodes.push({ startSeq: e.startSeq, endSeq: e.endSeq, type: e.type, ...(depSeqs.length ? { deps: depSeqs } : {}) })
  console.log('')
}
console.log('== 审查要点 ==')
console.log(' 1) 混合批次(read+bash)是否应为 act？2) 同轮多语义工作是否该拆？3) 依赖边有没有漏/多？')
console.log(' 4) 改法：GT JSON 里改 type / 拆段(改 endSeq+新增) / 合并(删段) / deps 数组')
if (gtOut) {
  writeFileSync(gtOut, JSON.stringify({ episodes: gt.episodes, _note: '编辑此文件作为 ground truth：只改与推断不符处。startSeq/endSeq 为会话绝对 seq；deps 填依赖 expl 的 startSeq' }, null, 2))
  console.log(`\nGT 骨架已写入: ${gtOut}（保存后跑 node tools/eval-episodes.mjs ${file} ${gtOut}）`)
}
