# dsh-cwl

**CWL — Context Window Lifecycle(上下文窗口生命周期)** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
面向长时任务智能体的结构化上下文驱逐(eviction)。

> 范式论文:[*Beyond Compaction: Structured Context Eviction for Long-Horizon Agents*](https://arxiv.org/abs/2606.11213)(arXiv:2606.11213)

[English](./README.md) | **简体中文**

## 为什么不用摘要压缩(compaction)?

Compaction(上下文压力的常规应对手段)是用 LLM 把历史总结成摘要。根据 CWL 论文,它有四个结构性问题:

- **损失不可预测** —— 摘要器决定什么重要,而不是任务本身。
- **破坏结构** —— 因果链(工具调用 → 输出 → 决策 → 动作)被压平成散文。
- **阻塞性开销** —— 任务进行中、token 紧张时还要触发一次完整 LLM 调用。
- **压缩诱发幻觉** —— 在长度压力下做摘要,是已知的失败模式。

CWL 把对话记录当作**结构化的工作记录**,做确定性驱逐:智能体的轨迹被自动推导成**类型化 episode 图**(探索 `expl` / 动作 `act`,带依赖边);当上下文压力超过预算时,一个**零 LLM、确定性的策略**按分级逐步剥除内容——先驱逐探索段(纯上下文,最安全),再驱逐效果已落盘的动作段。**用户消息永不驱逐。**

## 工作原理

1. **Episode 推导(自动,无需智能体标注)**:连续的同类工具批次合并为语义段(`expl` 表示读/搜索类,`act` 表示 bash/edit/write 类);某个 `act` 触碰的文件如果之前被某个 `expl` 读过,则建立依赖边。
2. **压力计量**:真实上下文压力 = input + cacheRead + output + reasoning tokens(从 `assistant/message` usage 事件累计——`tokenMeter.measure().totalTokens` 不含 cacheRead,而 cacheRead 在长会话中占大头)。
3. **分级驱逐**(挂在 `agent/pre-step` 瀑布上,每次 LLM 调用前):
   - 先驱逐未被依赖的 `expl` 段(保留一行"已探索: …"标记)
   - 再驱逐最旧的、已完成的 `act` 段
   - 永不触碰最新尾巴(preserve-recent)和用户消息
   - 被驱逐区间用轻量标记替换(官方 surface-replace 接口;原始事件保留在日志中,`cwl_recall` 可恢复文件路径)

## 安装

```bash
dsh plugin --profile <name> add dsh-cwl                 # 从 npm 安装
dsh plugin --profile <name> add github:kalifun/dsh-cwl  # 或从 GitHub 安装
```

或者把目录放进你的 composition:

```yaml
- id: dsh-cwl
  name: ./dsh-cwl/index.js
```

## 使用

无需配置。上下文在预算内(默认模型上下文窗口的 80%)时插件完全不干预,压力超过预算才开始驱逐。

```bash
# 可选:覆盖预算(tokens)——用于测试压力行为
HELMSMAN_CWL_BUDGET=30000 dsh web
```

面向智能体的工具:

| 工具 | 用途 |
|------|------|
| `cwl_recall` | 列出被驱逐 episode 涉及的文件路径,按需重新读取 |

观测端点:

| 端点 | 用途 |
|------|------|
| `GET /api/cwl/evictions` | 驱逐日志(会话 → 被驱逐的 episode) |
| `POST /api/cwl/force` | 调试:对某个会话强制驱逐一次 |

## 验证

```bash
node check.js          # 纯函数单元检查
```

长会话压力测试(12 轮对话,约 20 万 cacheRead tokens):`baseline vs CWL`——见源码仓库 `benchmarks/` 下的脚本与报告。

| 指标 | baseline | CWL | Δ |
|--------|----------|-----|---|
| steps | 30 | 26 | −13% |
| inputTokens | 28,478 | 10,343 | **−64%** |
| cacheReadTokens | 200,576 | 178,432 | −11% |
| outputTokens | 2,809 | 2,107 | −25% |

12 轮全部正确完成;驱逐未降低任务质量。

## License

MIT
