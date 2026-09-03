// dsh-cwl 纯函数（无依赖，可独立测试）
// 范式：arXiv:2606.11213 Structured Context Eviction

// ---------- 纯函数：episode 推导 + 驱逐策略 ----------

/** 从工具参数提取被读的文件路径（供驱逐后可恢复）。 */
function collectReadPaths(toolName, argsRaw) {
  if (toolName !== 'read' && toolName !== 'search') return []
  try {
    const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw
    const p = args?.file_path ?? args?.path ?? args?.pattern
    return typeof p === 'string' ? [p] : []
  } catch {
    return []
  }
}

/** 从工具参数提取 act 触碰的文件路径（file_path 或 command 里引用的路径）。 */
function collectTouchedPaths(toolName, argsRaw) {
  try {
    const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw
    const p = args?.file_path ?? args?.path
    if (typeof p === 'string') return [p]
    if (typeof args?.command === 'string') {
      const m = args.command.matchAll(/[\w./-]+\.[a-z]+/g)
      return [...new Set([...m].map((x) => x[0]).filter((x) => x.includes('/')))].slice(0, 5)
    }
    return []
  } catch { return [] }
}

/** 从工具调用参数判断该调用是否为"只读"（无副作用）。 */
const EXPL_TOOLS = new Set(['read', 'search', 'list', 'ls', 'glob', 'grep', 'find', 'web_search'])
// bash 写特征（宽松：宁当 act 不当 expl——误剥纯上下文比晚驱逐危险）
const BASH_WRITE_RE = />>|>|\bsed\s+-i\b|\brm\b|\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\bchmod\b|\bchown\b|\bln\b|\btee\b|\binstall\b|git\s+(add|commit|push|rm|mv)\b|(npm|pnpm|yarn)\s+(i|install|add)\b|curl\s+-[a-z]*o|wget\s+-O/
function isReadOnlyCall(name, argsRaw) {
  if (EXPL_TOOLS.has(name)) return true
  if (name !== 'bash') return false // edit/write/str_replace_editor 等一律视为写
  try {
    const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw
    const cmd = args?.command ?? ''
    return !BASH_WRITE_RE.test(cmd)
  } catch { return false }
}

/** 从命令里尽力提取只读 bash 引用到的路径（供依赖推断/召回；尽力而为）。 */
function collectCommandPaths(argsRaw) {
  try {
    const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw
    if (typeof args?.command !== 'string') return []
    const m = args.command.matchAll(/[\w./-]+\.[a-z]+/g)
    return [...new Set([...m].map((x) => x[0]).filter((x) => x.includes('/')))].slice(0, 5)
  } catch { return [] }
}

/**
 * 从事件流推导 episode 图（阶段合并 + 依赖）。
 * 基础单元：每条含 tool-call 的 assistant/message → 一个 tool-batch；
 * 阶段合并：连续同类型合并为 expl（探索）/ act（动作）语义段；
 * 依赖推断：act 触碰的文件若之前 expl 读过 → deps 边（驱逐时保护）。
 */
export function deriveEpisodes(events, opts = {}) {
  // 段内最大批次：长任务(单请求连续几十个工具调用)在无用户消息/类型转换时
  // 也会被强制关段，避免整个任务塌缩成一个永不完成的巨型 act。
  const MAX_BATCHES = opts.maxBatches ?? 6
  // surface 模式：传入当前 surface 时，按 surface 顺序(模型可见顺序)重推，
  // 而非日志顺序。内容裁剪/整段驱逐后事件历史不可变，但 surface 已更新：
  // 被遮蔽的原节点(如被 stub 替换的大 tool/result)从重推中消失，段的边界
  // 落到仍在 surface 的节点上(stub 或相邻节点)——整段驱逐的 replace
  // [start,end] 才能找到端点，不会抛 "end seq not found in surface"。
  const episodes = []
  let explCount = 0
  let actCount = 0
  let cur = null

  const flush = () => {
    if (cur) { cur.completed = true; episodes.push(cur); cur = null }
  }
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  // surface 模式：位置区间 = surface 数组下标(驱逐/合并的唯一可靠不变量；
  // strip/marker replace 后 seq 不再与位置有序对应，seq 端点会错位)。
  const hasPos = Array.isArray(opts.surface)
  const stream = hasPos
    ? opts.surface.map((seq) => bySeq.get(seq)).filter(Boolean)
    : events
  let pos = -1

  for (const ev of stream) {
    if (hasPos) pos++
    const type = ev?.type
    const data = ev.data ?? {}
    if (type === 'user/message') {
      // 用户消息是天然的工作段边界：关掉当前 episode，避免跨轮同类型工具
      // 批次无限合并成永不完成的巨型段（其 endSeq 随每个 tool/result 增长，
      // 永远 > newestAllowed 导致零驱逐）。修复后每个用户回合 = 独立 episode。
      flush()
      continue
    }
    if (type === 'assistant/message') {
      const content = data.message?.content ?? []
      const toolCalls = content.filter((b) => b?.type === 'tool-call')
      if (toolCalls.length === 0) continue
      // 读写意图分类：read/grep/只读 bash = expl(纯上下文)；edit/write/写 bash = act
      const isExpl = toolCalls.every((b) => isReadOnlyCall(b.name, b.arguments))
      const readPaths = toolCalls.flatMap((b) =>
        EXPL_TOOLS.has(b.name)
          ? collectReadPaths(b.name, b.arguments)
          : isReadOnlyCall(b.name, b.arguments) ? collectCommandPaths(b.arguments) : [],
      )
      const names = toolCalls.map((b) => b.name)
      const touchedPaths = isExpl ? [] : toolCalls.flatMap((b) => collectTouchedPaths(b.name, b.arguments))
      const inCap = cur && cur.batches.length < MAX_BATCHES
      if (cur && cur.type === (isExpl ? 'expl' : 'act') && inCap) {
        cur.batches.push({ seq: ev.seq, names, readPaths, touchedPaths })
        cur.endSeq = ev.seq
        if (hasPos) cur.posEnd = pos
        cur.toolNames.push(...names)
        cur.readPaths.push(...readPaths)
        if (!isExpl) cur.touchedPaths.push(...touchedPaths)
      } else {
        flush()
        if (isExpl) {
          explCount += 1
          cur = { name: `expl-${explCount}`, type: 'expl', startSeq: ev.seq, endSeq: ev.seq, posStart: hasPos ? pos : undefined, posEnd: hasPos ? pos : undefined,
                  batches: [{ seq: ev.seq, names, readPaths, touchedPaths: [] }], toolNames: [...names],
                  readPaths: [...readPaths], deps: [], touchedPaths: [], resultSeqs: [], completed: false }
        } else {
          actCount += 1
          cur = { name: `act-${actCount}`, type: 'act', startSeq: ev.seq, endSeq: ev.seq, posStart: hasPos ? pos : undefined, posEnd: hasPos ? pos : undefined,
                  batches: [{ seq: ev.seq, names, readPaths, touchedPaths }], toolNames: [...names],
                  readPaths: [...readPaths], deps: [], touchedPaths: [...touchedPaths], resultSeqs: [], completed: false }
        }
      }
    } else if (type === 'tool/result') {
      // 记录段内所有 tool/result 节点 seq(供细粒度内容裁剪定位)
      if (cur) { cur.endSeq = ev.seq; cur.resultSeqs.push(ev.seq); if (hasPos) cur.posEnd = pos }
    }
  }
  flush()

  // 依赖推断：act 触碰（读写）的文件若之前 expl 读过 → deps 边
  const expls = episodes.filter((e) => e.type === 'expl')
  const readSets = expls.map((e) => new Set(e.readPaths))
  for (const ep of episodes) {
    if (ep.type !== 'act') continue
    const touched = new Set([...ep.readPaths, ...(ep.touchedPaths ?? [])])
    for (let i = 0; i < expls.length; i++) {
      if (expls[i].endSeq < ep.startSeq && [...touched].some((p) => readSets[i].has(p))) {
        ep.deps.push(expls[i].name)
      }
    }
  }
  return episodes
}

/**
 * 分级驱逐选择：选下一个可驱逐的 episode。
 * 优先级：expl（纯上下文）> act；被依赖 expl 保护；已遮蔽/最新尾巴跳过。
 * opts（实验开关，默认 = 现状行为）：
 *   order      'oldest'（默认，最老优先）| 'tail'（尾部优先，保前缀缓存）
 *   tailWindow 仅考虑 endSeq 落在最近 N 个 surface 节点内的 episode（0 = 不限制）
 */
export function pickEvictionTarget(events, surface, newestAllowed, opts = {}) {
  const { order = 'oldest', tailWindow = 0, exclude = null } = opts
  const episodes = deriveEpisodes(events, { surface })
  const surfaceSet = new Set(surface)
  const depended = new Set()
  for (const ep of episodes) if (ep.type === 'act') for (const d of ep.deps ?? []) depended.add(d)
  // surface 在 replace 后不再按 seq 有序（marker 的新 seq 被 splice 进中间），
  // 边界/tailFloor 一律按排序后的节点取（位置取值会落到任意低 seq 节点上，
  // 把候选全部过滤掉 → 零驱逐）。
  const sorted = [...surface].sort((a, b) => a - b)
  const tailFloor = tailWindow > 0 && sorted.length > tailWindow
    ? sorted[sorted.length - 1 - tailWindow]
    : -1
  let best = null
  for (const ep of episodes) {
    if (!ep.completed) continue
    if (exclude && exclude.has(ep.startSeq)) continue
    if (!surfaceSet.has(ep.startSeq)) continue
    if (ep.endSeq > newestAllowed) continue
    if (ep.type === 'expl' && depended.has(ep.name)) continue
    if (tailFloor >= 0 && ep.endSeq < tailFloor) continue
    // 分数越低越优先：expl(0) < act(10)；order=tail 时 endSeq 越大越优先
    const score = order === 'tail'
      ? (ep.type === 'expl' ? 0 : 10) - ep.endSeq / 1e9
      : (ep.type === 'expl' ? 0 : 10) + ep.startSeq / 1e9
    if (best === null || score < best.score) best = { ...ep, score }
  }
  if (!best) return null
  return { start: best.startSeq, end: best.endSeq, label: best.name, type: best.type, readPaths: best.readPaths ?? [] }
}

/**
 * 找出段内"大的 tool/result 节点"(细粒度内容裁剪的候选)。
 * 只返回仍在 surface 中、且文本内容超过阈值的 tool/result seq。
 * @param events 会话事件
 * @param episode deriveEpisodes 输出的段(需含 resultSeqs)
 * @param surface 当前 surface 节点(seq 数组)
 * @param threshold 文本长度阈值(默认 1500 字符)
 */
export function largeResultSeqs(events, episode, surface, threshold = 1500) {
  const inSurface = new Set(surface)
  const bySeq = new Map(events.filter((e) => e.type === 'tool/result').map((e) => [e.seq, e]))
  const out = []
  for (const seq of episode.resultSeqs ?? []) {
    if (!inSurface.has(seq)) continue
    const ev = bySeq.get(seq)
    const text = toolResultText(ev)
    if (text && text.length >= threshold) out.push({ seq, chars: text.length })
  }
  return out
}

/** 提取 tool/result 节点的文本内容(兼容两种内容包裹结构)。 */
export function toolResultText(ev) {
  try {
    const content = ev?.data?.message?.content ?? []
    const block = content[0]
    const inner = block?.content ?? []
    const text = inner.filter((b) => typeof b === 'string' || b?.type === 'text').map((b) => (typeof b === 'string' ? b : b.text ?? '')).join('')
    return text
  } catch { return '' }
}

/**
 * 把 tool/result 事件的 data 改造成"仅替换内容"的合法同构体：
 * harness surface 校验(assertToolResultRewrite)只允许改 message.content[0].content，
 * 其余字段必须深度相等。
 */
export function stubToolResultData(originalEvent, stubText) {
  const d = originalEvent.data
  const block = d.message.content[0]
  return {
    ...d,
    message: {
      ...d.message,
      content: [{ ...block, content: [{ type: 'text', text: stubText }] }],
    },
  }
}

/**
 * 取段在 surface 中的完整位置块(连续节点,含中间替换进来的 stub)。
 * 位置区间是驱逐的唯一可靠不变量——seq 端点经 strip/marker replace 后会错位。
 */
export function episodeBlock(surface, ep) {
  if (!ep || ep.posStart == null || ep.posEnd == null) return []
  if (ep.posStart < 0 || ep.posEnd >= surface.length || ep.posStart > ep.posEnd) return []
  return surface.slice(ep.posStart, ep.posEnd + 1)
}

/**
 * 驱逐目标按 surface 位置相邻合并(batch)：只合并位置连续(posEnd+1 === posStart)
 * 的段——位置连续意味着之间无其他节点(用户消息不会被包进驱逐窗口)。
 */
export function mergeBlocksByPos(blocks) {
  const sorted = [...blocks].sort((a, b) => a.posStart - b.posStart)
  const merged = []
  for (const b of sorted) {
    const last = merged[merged.length - 1]
    if (last && last.posEnd + 1 === b.posStart) {
      last.posEnd = b.posEnd
      last.labels.push(b.label)
    } else {
      merged.push({ posStart: b.posStart, posEnd: b.posEnd, labels: [b.label] })
    }
  }
  return merged
}

/**
 * 配对完整性校验：驱逐窗口 [start,end] 的位置切片是否会切开 tool-call/result 配对。
 * 若窗口内含某 tool-call 但它的某个 result 在窗口外(或反之)，驱逐后 surface 将出现
 * 孤儿消息 → LLM API 400(任务级失败，fold 校验发现不了)。返回被切开的配对描述。
 * @returns [{callId, seq, side}] 破坏配对的节点；空数组 = 窗口配对完整可驱逐
 */
export function pairingBreaks(events, surface, start, end) {
  const win = shadowedNodes(surface, start, end)
  if (!win.length) return []
  const winSet = new Set(win)
  const bySeq = new Map(events.filter((e) => e.type === 'assistant/message' || e.type === 'tool/result').map((e) => [e.seq, e]))
  // 窗口内 call id → 窗口外它的 result；窗口内 result id → 窗口外它的 call
  const breaks = []
  const callInWin = new Map() // id -> seq
  const resultInWin = new Map() // id -> seq
  for (const s of win) {
    const ev = bySeq.get(s)
    if (!ev) continue
    if (ev.type === 'assistant/message') {
      for (const b of ev.data?.message?.content ?? []) {
        if (b?.type === 'tool-call' && b.id) callInWin.set(b.id, s)
        // 并行批次: call 的 result 在窗口外 → 破坏
      }
    } else if (ev.type === 'tool/result') {
      const id = ev.data?.message?.content?.[0]?.toolCallId
      if (id) resultInWin.set(id, s)
    }
  }
  // 窗口外的 result/call 是否引用了窗口内的 id
  for (const [id, seq] of callInWin) {
    // 找该 call 的所有 result 是否都在窗口内(通过扫描全 surface 对应 id)
  }
  // 简化但可靠: 扫描全 surface,统计每对 id 的 call/result 是否同侧
  const allIds = new Map() // id -> {calls: [seq], results: [seq]}
  for (const s of surface) {
    const ev = bySeq.get(s)
    if (!ev) continue
    if (ev.type === 'assistant/message') {
      for (const b of ev.data?.message?.content ?? []) if (b?.type === 'tool-call' && b.id) {
        const rec = allIds.get(b.id) ?? { calls: [], results: [] }
        rec.calls.push(s); allIds.set(b.id, rec)
      }
    } else if (ev.type === 'tool/result') {
      const id = ev.data?.message?.content?.[0]?.toolCallId
      if (id) { const rec = allIds.get(id) ?? { calls: [], results: [] }; rec.results.push(s); allIds.set(id, rec) }
    }
  }
  for (const [id, rec] of allIds) {
    if (!rec.calls.length || !rec.results.length) continue
    const callIn = rec.calls.some((s) => winSet.has(s))
    const callOut = rec.calls.some((s) => !winSet.has(s))
    const resIn = rec.results.some((s) => winSet.has(s))
    const resOut = rec.results.some((s) => !winSet.has(s))
    if ((callIn && resOut) || (resIn && callOut)) breaks.push({ callId: id, calls: rec.calls, results: rec.results })
  }
  return breaks
}

/**
 * 计算 surface replace [start,end] 实际遮蔽的节点(与引擎 surface fold 的
 * replacementRange 语义一致：按位置 indexOf 切片，而非 seq 范围过滤)。
 * 驱逐/裁剪后 surface 不再按 seq 有序(stub/marker 的新 seq 插入中间)，
 * seq 范围过滤会漏掉区间内替换进来的 stub → sourceEventSeqs 校验失败。
 */
export function shadowedNodes(surface, start, end) {
  const si = surface.indexOf(start)
  const ei = surface.indexOf(end)
  if (si >= 0 && ei >= 0 && si <= ei) return surface.slice(si, ei + 1)
  return []
}

/** 合并相邻/重叠区间（E2 批处理：多个 episode 合并为一次 surface replace，
 * 减少对前缀缓存的打断次数）。纯函数，可独立测试。
 */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end)
      last.labels.push(r.label)
    } else {
      merged.push({ start: r.start, end: r.end, labels: [r.label] })
    }
  }
  return merged
}
