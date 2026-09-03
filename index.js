// [dsh-cwl] CWL — Context Window Lifecycle：结构化上下文驱逐 for DeepSeek Harness.
// 范式：arXiv:2606.11213（Beyond Compaction: Structured Context Eviction for Long-Horizon Agents）
//
// 超越摘要压缩（ACP 路线）：把轨迹自动推导为类型化 episode 图（expl 探索 / act 动作 + 依赖），
// agent/pre-step 瀑布每次 LLM 调用前检查上下文压力，超阈值用 surface replace 确定性剥除
// （零 LLM、无摘要幻觉、保留因果结构、用户消息永不驱逐）。
//
// 分级驱逐（graduated，对齐论文实现 pi-cwl）：
//   - 优先驱逐 expl（探索段 = 纯上下文，最安全），保留"已探索"摘要（工作记忆不丢）
//   - 被后续 act 依赖的 expl 保护（依赖图）
//   - 最新尾巴保护（preserveRecent，不碰活跃工具调用）
//
// 压力计量：tokenMeter.measure().totalTokens 不含 cacheReadTokens（长会话上下文主要占用），
// 故从 session 的 assistant/message usage 事件累计真实压力（input + cacheRead + output + reasoning）。
//
// 配置（环境变量）：
//   DSH_CWL_BUDGET  — 覆盖预算（tokens）；默认 = 上下文窗口 80%
//
// 工具：cwl_recall（找回被驱逐段涉及的文件）
// HTTP：/api/cwl/evictions（驱逐记录）、/api/cwl/force（调试：强制驱逐一次）

import { defineTool } from '@deepseek-ai/dsh-tools'
import { deriveEpisodes, episodeBlock, largeResultSeqs, mergeBlocksByPos, newestEvictableBoundary, pairingBreaks, pickEvictionTarget, shadowedNodes, stubToolResultData, toolResultText } from './lib.js'

export const name = 'dsh-cwl'
export const inject = ['webServer', 'agents', 'tokenMeter', 'compaction', 'tools']

// ---------- 插件主体 ----------

export function apply(ctx) {
  const { webServer } = ctx
  const tokenMeter = ctx.get('tokenMeter')
  const evictionLog = new Map() // sid → [{episode, start, end, readPaths, at}]

  /** 计算会话当前真实压力（input + cacheRead + output + reasoning）。 */
  function usageTokens(session) {
    try {
      const m = tokenMeter?.measure(session)
      if (m?.pressureTokens != null) return m.pressureTokens
      let input = 0, cache = 0, output = 0, reason = 0
      for (const ev of session.events) {
        if (ev?.type !== 'assistant/message') continue
        const u = ev.data?.usage
        if (!u) continue
        input += typeof u.inputTokens === 'number' ? u.inputTokens : 0
        cache += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
        output += typeof u.outputTokens === 'number' ? u.outputTokens : 0
        reason += typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0
      }
      if (input + cache + output + reason > 0) return input + cache + output + reason
      return m?.totalTokens ?? 0
    } catch { return 0 }
  }

  /** 预算：环境变量覆盖，或上下文窗口 80%。 */
  function budgetTokens(session) {
    const override = Number(process.env.DSH_CWL_BUDGET)
    if (Number.isFinite(override) && override > 0) return override
    const header = session.requestHeader?.()?.config
    const ctxWindow = header?.contextWindow ?? 128000
    return Math.floor(ctxWindow * 0.8)
  }

  /** 驱逐一段：surface replace 遮蔽，零 LLM。 */
  function evictRange(session, start, end, episode) {
    if (start == null || end == null || start > end) return null
    const summary = episode.type === 'expl' && episode.toolNames?.length
      ? `已探索：${episode.toolNames.join(', ')}${episode.readPaths?.length ? `（${episode.readPaths.slice(0, 3).join(', ')}）` : ''}`
      : `已执行动作段 ${episode.name}（效果已落盘，如需细节用 cwl_recall）`
    const marker = `[cwl-evicted:${episode.name} type=${episode.type}] ${summary}`
    // 位置切片(与引擎 fold 的 replacementRange 一致)：含区间内替换进来的 stub 节点
    const nodes = session.surface?.nodes ?? []
    const shadowed = shadowedNodes(nodes, start, end)
    // 配对完整性防御：窗口若切开 tool-call/result 对(驱逐后产生孤儿消息 → LLM 400)，
    // 跳过本次驱逐(结构性安全；fold 校验发现不了这种失败)。
    const breaks = pairingBreaks(session.events, nodes, start, end)
    if (breaks.length > 0) {
      const list = evictionLog.get(session.id) ?? []
      list.push({ episode: episode.name, kind: 'skipped-pairing', start, end, broke: breaks[0].callId, at: Date.now() })
      evictionLog.set(session.id, list)
      console.warn(`[dsh-cwl] 跳过驱逐 ${episode.name}（配对破坏 ${breaks.length} 对，首 id ${breaks[0].callId.slice(0, 20)}…）`)
      return null
    }
    const ev = session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: marker }],
      source: { kind: 'plugin', plugin: 'dsh-cwl', form: 'notice', summary: marker },
    }, {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: shadowed.length > 0 ? shadowed : [start],
    })
    const list = evictionLog.get(session.id) ?? []
    list.push({ episode: episode.name, start, end, readPaths: episode.readPaths ?? [], at: Date.now() })
    evictionLog.set(session.id, list)
    if (list.length > 50) list.shift()
    return ev
  }

  // 驱逐策略（确定性重放验证：驱逐价值 -24% cacheRead 策略无关；batch 均值最优 -24.7%，
  // 7 会话 6 优方向一致 → 默认 tail+batch，可用环境变量回退/覆盖）：
  //   DSH_CWL_EVICT_ORDER       tail（默认）| oldest（最老优先）
  //   DSH_CWL_EVICT_BATCH       默认开；0|false|off 关闭（逐段 replace）
  //   DSH_CWL_EVICT_TAIL_WINDOW N：只驱逐 endSeq 落在最近 N 个 surface 节点内的段（0=不限制）
  const evictOrder = process.env.DSH_CWL_EVICT_ORDER === 'oldest' ? 'oldest' : 'tail'
  const evictBatchRaw = process.env.DSH_CWL_EVICT_BATCH
  const evictBatch = evictBatchRaw === undefined ? true : !['0', 'false', 'off'].includes(evictBatchRaw)
  const evictTailWindow = Math.max(0, Number(process.env.DSH_CWL_EVICT_TAIL_WINDOW) || 0)
  // 细粒度裁剪开关：expl 大结果先内容裁剪(细)，整段驱逐(粗)兜底；默认开
  const stripBig = process.env.DSH_CWL_STRIP === '0' ? false : true
  const stripThreshold = Number(process.env.DSH_CWL_STRIP_THRESHOLD) || 1500
  // 已裁剪的 tool/result seq（sid → Set<seq>）；事件流不变，需运行态记忆
  const strippedSeqs = new Map()

  /** 裁剪一个 tool/result 节点的内容（surface 内容改写，保持工具配对与结构）。 */
  function stripResult(session, resultSeq) {
    const sid = session.id
    const ev = session.events.find((e) => e.seq === resultSeq && e.type === 'tool/result')
    if (!ev) return false
    const text = toolResultText(ev)
    const stubText = `[cwl-stub: 工具结果 ${text.length} 字符已裁剪，需要时可用原工具重跑]`
    const rewritten = stubToolResultData(ev, stubText)
    session.append('tool/result', rewritten, {
      surfaceOp: { op: 'replace', start: resultSeq, end: resultSeq },
      sourceEventSeqs: [resultSeq],
    })
    if (!strippedSeqs.has(sid)) strippedSeqs.set(sid, new Set())
    strippedSeqs.get(sid).add(resultSeq)
    const list = evictionLog.get(sid) ?? []
    list.push({ episode: ev.data.message?.content?.[0]?.toolCallId ? `result:${resultSeq}` : `result:${resultSeq}`, kind: 'strip', start: resultSeq, end: resultSeq, chars: text.length, at: Date.now() })
    evictionLog.set(sid, list)
    if (list.length > 50) list.shift()
    return true
  }

  /** 收集本轮动作：{toEvict: 整段驱逐, toStrip: expl 大结果内容裁剪}。
   *  分级：expl 有未裁剪大结果 → 先细粒度裁剪(留结构)；无大结果/已裁 → 整段驱逐(粗)。
   */
  function collectTargets(session, surface, newestAllowed) {
    const toEvict = []
    const toStrip = []
    const excluded = new Set() // 本步已裁剪的 expl，不整段驱逐
    const episodes = deriveEpisodes(session.events, { surface })
    const byStart = new Map(episodes.map((e) => [e.startSeq, e]))
    const sid = session.id
    const stripped = strippedSeqs.get(sid) ?? new Set()
    let guard = 0
    while (guard++ < 20) {
      if (usageTokens(session) <= budgetTokens(session)) break
      const occupied = [...toEvict, ...toStrip]
      const liveSurface = surface.filter((s) => !occupied.some((p) => s >= p.start && s <= p.end))
      const target = pickEvictionTarget(session.events, liveSurface, newestAllowed, { order: evictOrder, tailWindow: evictTailWindow, exclude: excluded })
      if (!target) break
      const ep = byStart.get(target.start)
      if (ep?.type === 'expl' && stripBig) {
        const big = largeResultSeqs(session.events, ep, liveSurface, stripThreshold)
        const todo = big.filter((x) => !stripped.has(x.seq))
        if (todo.length) {
          toStrip.push({ start: target.start, end: target.end, seqs: todo.map((x) => x.seq) })
          excluded.add(target.start)
          continue
        }
      }
      toEvict.push({ ...target, posStart: ep?.posStart, posEnd: ep?.posEnd })
    }
    return { toEvict, toStrip }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent
    const session = agent?.session
    if (!session) return next()
    const used = usageTokens(session)
    const budget = budgetTokens(session)
    if (used <= budget) return next() // 预算内零干预

    try {
      const surface = session.surface?.nodes ?? []
      // 自适应最新边界(3.3)：保护正在进行的工具调用链(最后一个未完成段)，
      // 而非固定 2 节点；其之前的位置为可驱逐边界
      const epsNow = deriveEpisodes(session.events, { surface })
      const newestAllowed = newestEvictableBoundary(surface, epsNow)
      const { toEvict, toStrip } = collectTargets(session, surface, newestAllowed)
      let strippedCount = 0
      for (const s of toStrip) for (const seq of s.seqs) if (stripResult(session, seq)) strippedCount++
      if (toEvict.length) {
        // 位置区间驱逐(根治)：surface 经 strip/marker replace 后 seq 不再与位置有序对应，
        // 驱逐一律按段在 surface 中的位置块执行；位置靠后的段先驱逐(前面段位置保持有效)。
        const withPos = toEvict.filter((t) => t.posStart != null && t.posEnd != null)
        const units = evictBatch
          ? mergeBlocksByPos(withPos.map((t) => ({ posStart: t.posStart, posEnd: t.posEnd, label: t.label, type: t.type, readPaths: t.readPaths ?? [] })))
          : withPos.map((t) => ({ posStart: t.posStart, posEnd: t.posEnd, labels: [t.label], type: t.type, readPaths: t.readPaths ?? [] }))
        units.sort((a, b) => b.posStart - a.posStart)
        for (const u of units) {
          const live = session.surface?.nodes ?? []
          if (u.posEnd >= live.length) continue
          const block = live.slice(u.posStart, u.posEnd + 1)
          if (!block.length) continue
          evictRange(session, block[0], block[block.length - 1], { name: u.labels.join('+'), type: u.type, readPaths: u.readPaths })
        }
      }
      console.log(`[dsh-cwl] ${session.id} 驱逐后 ${usageTokens(session)}/${budget} tokens（order=${evictOrder} batch=${evictBatch}，整段驱逐 ${toEvict.length}，内容裁剪 ${strippedCount}）`)
    } catch (e) {
      console.warn('[dsh-cwl] 驱逐失败（不阻断）:', e?.message ?? e)
    }
    return next()
  })

  // 工具：cwl_recall（恢复被驱逐文件）
  try {
    ctx.tools.register(defineTool({
      name: 'cwl_recall',
      description: '找回被驱逐的工作段涉及的文件路径（驱逐后按需重读）。',
      parameters: { query: { type: 'string', description: '关键词过滤（可选）' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args, exec) {
        const sid = exec?.agent?.session?.id
        const list = sid ? (evictionLog.get(sid) ?? []) : []
        const q = (args?.query ?? '').toLowerCase()
        const hits = list.filter((e) => !q || e.episode.toLowerCase().includes(q) || e.readPaths.join(' ').toLowerCase().includes(q))
        const paths = [...new Set(hits.flatMap((e) => e.readPaths))]
        return paths.length ? '被驱逐段涉及的文件：\n' + paths.join('\n') : '无匹配的驱逐记录'
      },
    }))
  } catch (e) {
    console.warn('[dsh-cwl] 工具注册失败（不阻断）:', e?.message ?? e)
  }

  // HTTP：驱逐记录（调试/观测）
  if (webServer?.register) {
    webServer.register({
      kind: 'exact',
      path: '/api/cwl/evictions',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([...evictionLog.entries()].map(([sid, list]) => ({ sid, evicted: list }))))
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/api/cwl/force',
      handler: (req, res) => {
        let buf = ''
        req.on('data', (c) => { buf += c })
        req.on('end', () => {
          try {
            const body = JSON.parse(buf || '{}')
            const agent = ctx.get('agents')?.get?.(body.sid)
            const session = agent?.session
            if (!session) {
              res.writeHead(404, { 'content-type': 'application/json' })
              return res.end(JSON.stringify({ error: 'session not live' }))
            }
            const surface = session.surface?.nodes ?? []
            const episodes = deriveEpisodes(session.events, { surface })
            const newestAllowed = newestEvictableBoundary(surface, episodes)
            const target = pickEvictionTarget(session.events, surface, newestAllowed, { order: evictOrder, tailWindow: evictTailWindow })
            if (!target) {
              res.writeHead(200, { 'content-type': 'application/json' })
              return res.end(JSON.stringify({ ok: true, evicted: 0, note: 'no evictable episode' }))
            }
            evictRange(session, target.start, target.end, { name: target.label, type: target.type, readPaths: target.readPaths })
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, evicted: 1, episode: target.label, range: [target.start, target.end] }))
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: e?.message ?? String(e) }))
          }
        })
      },
    })
  }

  console.log('[dsh-cwl] 结构化上下文驱逐已挂载（pre-step 压力检查 + 分级驱逐）')
}

export default { name, inject, apply }
