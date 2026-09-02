// dsh-cwl 纯函数单元测试：node check.js
import assert from 'node:assert/strict'
import { deriveEpisodes, mergeRanges, pickEvictionTarget } from './lib.js'

// --- deriveEpisodes：阶段合并 + 依赖推断 ---
const events = [
  // expl：read a.js + grep（连续探索 → 合并为 expl-1）
  { type: 'assistant/message', seq: 100, data: { message: { content: [{ type: 'tool-call', name: 'read', arguments: '{"file_path":"/a/b.js"}' }] } } },
  { type: 'tool/result', seq: 101, data: {} },
  { type: 'assistant/message', seq: 102, data: { message: { content: [{ type: 'tool-call', name: 'read', arguments: '{"file_path":"/a/c.js"}' }, { type: 'tool-call', name: 'grep', arguments: '{"pattern":"TODO"}' }] } } },
  { type: 'tool/result', seq: 103, data: {} },
  { type: 'tool/result', seq: 104, data: {} },
  // act：bash 写 b.js（触碰 /a/b.js → 依赖 expl-1）
  { type: 'assistant/message', seq: 105, data: { message: { content: [{ type: 'tool-call', name: 'bash', arguments: '{"command":"echo x >> /a/b.js"}' }] } } },
  { type: 'tool/result', seq: 106, data: {} },
  // expl：读 b.md（无依赖）
  { type: 'assistant/message', seq: 107, data: { message: { content: [{ type: 'tool-call', name: 'read', arguments: '{"file_path":"/a/b.md"}' }] } } },
  { type: 'tool/result', seq: 108, data: {} },
]

const eps = deriveEpisodes(events)
const expls = eps.filter((e) => e.type === 'expl')
const acts = eps.filter((e) => e.type === 'act')

// 阶段合并：2 expl + 1 act
assert.equal(expls.length, 2, 'should merge consecutive expl batches')
assert.equal(acts.length, 1, 'should have one act episode')
assert.equal(expls[0].toolNames.join(','), 'read,read,grep', 'expl-1 should contain merged tools')
// 依赖：act-1 触碰 /a/b.js（expl-1 读过）
assert.deepEqual(acts[0].deps, ['expl-1'], 'act should depend on expl that read its touched file')

// --- pickEvictionTarget：依赖保护 + 最新尾巴保护 ---
const surface = [100, 101, 102, 103, 104, 105, 106, 107, 108]
// newestAllowed = 105（保留最新 2 个节点 107,108）→ expl-2（107-108）被保护
// expl-1 被 act-1 依赖 → 保护；act-1（105-106）可驱逐
const t1 = pickEvictionTarget(events, surface, 106)
assert.equal(t1?.label, 'act-1', 'should pick act-1 (expl-1 depended, expl-2 end=108 > 106 protected)')

// 放宽最新尾巴 → expl-2 可驱逐（优先 expl）
const t2 = pickEvictionTarget(events, surface, 108)
assert.equal(t2?.type, 'expl', 'should prefer expl when available')

// 已遮蔽段排除
const t3 = pickEvictionTarget(events, [100, 101, 107, 108], 108)
assert.notEqual(t3?.label, 'act-1', 'evicted act-1 should not be re-picked')

// --- 实验开关：order=tail（尾部优先，保前缀缓存） ---
const t4 = pickEvictionTarget(events, surface, 108, { order: 'tail' })
assert.equal(t4?.label, 'expl-2', 'tail order should prefer expl with largest endSeq (expl-2=108)')

// --- 实验开关：tailWindow（只驱逐 endSeq 落在最近 N 个 surface 节点内的段） ---
// floor = surface[len-1-N]；tailWindow=1 → floor=107 → 只有 expl-2(108) 达标
const t5 = pickEvictionTarget(events, surface, 108, { tailWindow: 1 })
assert.equal(t5?.label, 'expl-2', 'tailWindow=1 should restrict to endSeq >= 107 (expl-2)')
// tailWindow=4 → floor=104；expl-1(104) 达标但被 act-1 依赖保护 → 取 expl-2
const t6 = pickEvictionTarget(events, surface, 108, { tailWindow: 4 })
assert.equal(t6?.label, 'expl-2', 'tailWindow=4 floor=104; expl-1 protected by dep, expl-2 wins')

// --- tailWindow floor 语义（无依赖 fixture，排除依赖保护干扰） ---
const events2 = [
  { type: 'assistant/message', seq: 200, data: { message: { content: [{ type: 'tool-call', name: 'read', arguments: '{"file_path":"/x/a.js"}' }] } } },
  { type: 'tool/result', seq: 201, data: {} },
  { type: 'assistant/message', seq: 202, data: { message: { content: [{ type: 'tool-call', name: 'bash', arguments: '{"command":"echo hi"}' }] } } },
  { type: 'tool/result', seq: 203, data: {} },
  { type: 'assistant/message', seq: 204, data: { message: { content: [{ type: 'tool-call', name: 'read', arguments: '{"file_path":"/x/b.js"}' }] } } },
  { type: 'tool/result', seq: 205, data: {} },
]
const surface2 = [200, 201, 202, 203, 204, 205]
const t7 = pickEvictionTarget(events2, surface2, 205, { tailWindow: 1 })
assert.equal(t7?.label, 'expl-2', 'tailWindow=1 floor=204 excludes expl-1(end=201) and act-1(end=203)')
const t8 = pickEvictionTarget(events2, surface2, 205, { tailWindow: 4 })
assert.equal(t8?.label, 'expl-1', 'tailWindow=4 floor=201 allows expl-1; oldest order picks it')

// --- mergeRanges：相邻合并、间隔分开 ---
const mr = mergeRanges([
  { start: 100, end: 104, label: 'expl-1' },
  { start: 105, end: 106, label: 'act-1' },
  { start: 108, end: 108, label: 'expl-2' },
])
assert.equal(mr.length, 2, '100-106 adjacent merged, 108 separate (gap at 107)')
assert.deepEqual(mr[0], { start: 100, end: 106, labels: ['expl-1', 'act-1'] }, 'merged range covers 100-106 with both labels')
assert.deepEqual(mr[1], { start: 108, end: 108, labels: ['expl-2'] }, 'non-adjacent range stays separate')

// --- 用户消息关段：跨轮同类型工具批次不得合并成永不完成的巨型段 ---
const events3 = [
  // 轮 1：bash → result
  { type: 'user/message', seq: 300, data: { content: [{ type: 'text', text: '轮1' }] } },
  { type: 'assistant/message', seq: 301, data: { message: { content: [{ type: 'tool-call', name: 'bash', arguments: '{"command":"echo a > /x/1.txt"}' }] } } },
  { type: 'tool/result', seq: 302, data: {} },
  // 轮 2：又是 bash（同类型，但被用户消息隔开 → 必须分属两个 episode）
  { type: 'user/message', seq: 303, data: { content: [{ type: 'text', text: '轮2' }] } },
  { type: 'assistant/message', seq: 304, data: { message: { content: [{ type: 'tool-call', name: 'bash', arguments: '{"command":"echo b > /x/2.txt"}' }] } } },
  { type: 'tool/result', seq: 305, data: {} },
]
const eps3 = deriveEpisodes(events3)
const acts3 = eps3.filter((e) => e.type === 'act')
assert.equal(acts3.length, 2, 'user/message boundary should split same-type batches into separate act episodes')
assert.equal(acts3[0].endSeq, 302, 'first act should close at its own tool result, not extend into round 2')
assert.equal(acts3[1].startSeq, 304, 'second act starts after the second user message')

console.log('✓ dsh-cwl 纯函数检查通过：episode 合并 / 依赖推断 / 分级选择 / 遮蔽排除 / tail顺序 / tailWindow / mergeRanges / 用户消息关段')
