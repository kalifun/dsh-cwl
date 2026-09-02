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
import { deriveEpisodes, mergeRanges, pickEvictionTarget } from './lib.js'

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
    const shadowed = (session.surface?.nodes ?? []).filter((seq) => seq >= start && seq <= end)
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

  // 核心：agent/pre-step 瀑布 —— 每次 LLM 调用前检查压力，超阈值分级驱逐
  // 实验开关（任务二 cache 优化，默认 = 现状行为）：
  //   DSH_CWL_EVICT_ORDER       oldest（默认，最老优先）| tail（尾部优先，保前缀缓存）
  //   DSH_CWL_EVICT_BATCH       1|true：合并相邻 episode 为一次 surface replace（减缓存打断）
  //   DSH_CWL_EVICT_TAIL_WINDOW N：只驱逐 endSeq 落在最近 N 个 surface 节点内的段（0=不限制）
  const evictOrder = process.env.DSH_CWL_EVICT_ORDER === 'tail' ? 'tail' : 'oldest'
  const evictBatch = process.env.DSH_CWL_EVICT_BATCH === '1' || process.env.DSH_CWL_EVICT_BATCH === 'true'
  const evictTailWindow = Math.max(0, Number(process.env.DSH_CWL_EVICT_TAIL_WINDOW) || 0)

  /** 收集本轮要驱逐的 episode（预算内停止；逐次过滤已选段，避免重复驱逐）。 */
  function collectTargets(session, surface, newestAllowed) {
    const picks = []
    let guard = 0
    while (guard++ < 20) {
      const current = usageTokens(session)
      if (current <= budgetTokens(session)) break
      const liveSurface = surface.filter((s) => !picks.some((p) => s >= p.start && s <= p.end))
      const target = pickEvictionTarget(session.events, liveSurface, newestAllowed, { order: evictOrder, tailWindow: evictTailWindow })
      if (!target) break
      picks.push(target)
    }
    return picks
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent
    const session = agent?.session
    if (!session) return next()
    const used = usageTokens(session)
    const budget = budgetTokens(session)
    if (used <= budget) return next() // 预算内零干预

    try {
      const PRESERVE_RECENT = 2
      const surface = session.surface?.nodes ?? []
      // surface 在 replace 后无序（marker 的新 seq 插入中间），边界必须按排序取
      const sorted = [...surface].sort((a, b) => a - b)
      const newestAllowed = sorted.length > PRESERVE_RECENT ? sorted[sorted.length - 1 - PRESERVE_RECENT] : -1
      const picks = collectTargets(session, surface, newestAllowed)
      if (picks.length) {
        if (evictBatch) {
          // E2：合并相邻段为一次 replace，减少缓存打断次数
          for (const { start, end, labels } of mergeRanges(picks)) {
            evictRange(session, start, end, {
              name: labels.join('+'),
              type: picks[0].type,
              readPaths: picks.flatMap((p) => p.readPaths ?? []),
            })
          }
        } else {
          for (const t of picks) evictRange(session, t.start, t.end, { name: t.label, type: t.type, readPaths: t.readPaths })
        }
      }
      console.log(`[dsh-cwl] ${session.id} 驱逐后 ${usageTokens(session)}/${budget} tokens（order=${evictOrder} batch=${evictBatch} tailWindow=${evictTailWindow}，驱逐 ${picks.length} 段）`)
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
            const episodes = deriveEpisodes(session.events)
            const surface = session.surface?.nodes ?? []
            const sorted = [...surface].sort((a, b) => a - b)
            const newestAllowed = sorted.length > 2 ? sorted[sorted.length - 3] : -1
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
