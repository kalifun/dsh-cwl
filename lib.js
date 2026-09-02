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
  const episodes = []
  let explCount = 0
  let actCount = 0
  let cur = null

  const flush = () => {
    if (cur) { cur.completed = true; episodes.push(cur); cur = null }
  }

  for (const ev of events) {
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
        cur.toolNames.push(...names)
        cur.readPaths.push(...readPaths)
        if (!isExpl) cur.touchedPaths.push(...touchedPaths)
      } else {
        flush()
        if (isExpl) {
          explCount += 1
          cur = { name: `expl-${explCount}`, type: 'expl', startSeq: ev.seq, endSeq: ev.seq,
                  batches: [{ seq: ev.seq, names, readPaths, touchedPaths: [] }], toolNames: [...names],
                  readPaths: [...readPaths], deps: [], touchedPaths: [], resultSeqs: [], completed: false }
        } else {
          actCount += 1
          cur = { name: `act-${actCount}`, type: 'act', startSeq: ev.seq, endSeq: ev.seq,
                  batches: [{ seq: ev.seq, names, readPaths, touchedPaths }], toolNames: [...names],
                  readPaths: [...readPaths], deps: [], touchedPaths: [...touchedPaths], resultSeqs: [], completed: false }
        }
      }
    } else if (type === 'tool/result') {
      // 记录段内所有 tool/result 节点 seq(供细粒度内容裁剪定位)
      if (cur) { cur.endSeq = ev.seq; cur.resultSeqs.push(ev.seq) }
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
  const episodes = deriveEpisodes(events)
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
