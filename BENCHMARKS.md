# dsh-cwl 基准蓝本(Benchmark Blueprint)

> **用途**:证明 dsh-cwl 的能力,为每次行为变更提供对照基线。
> **维护规则**:
> - **方案变更**(场景/指标/方法)→ 修改本文件"测试方案"部分(需讨论确认)
> - **行为变更**(代码改动/新版本)→ **不改方案**,由 helmsman 平台按方案复测,更新"数据记录"表
> - 原始详细报告留存于 helmsman 仓库 `benchmarks/`(审计轨迹);本文件只存结论级数据

---

## 1. 测试方案(固定)

### 1.1 环境

- 引擎:DeepSeek Harness(helmsman `dsh/` 组合),宿主 `@deepseek-ai/* 0.1.2-alpha.x / 0.1.2-rc.1`
- LLM:DeepSeek API(真实)
- 插件:被测 dsh-cwl 版本以本地 `file:` 引用接入(pnpm install 后需 `diff -q` 确认与本地 main 一致,勿信 pnpm 输出)
- ⚠️ 压力口径(宿主 rc.1 起):`usageTokens = measure().surfaceTokens`(**当前占用**,驱逐后下降)。
  预算即上下文保护线。旧 `DSH_CWL_BUDGET=30000` 对应累计口径(会话历史支出,已随 rc.1 弃用);
  新口径下场景 A/B surface 峰值 ~21K,3 万永不触发。**机制验证预算建议 ~12000**(触发 B、不触发 A,
  同时演示"小会话不驱逐是正确语义")。预算数字属测试方案,变更需讨论(见 §0 维护规则)。

### 1.2 场景 A:长会话压力(对话类)

- 驱动:`benchmarks/run-context-pressure.mjs cwl 12` —— 同一会话连续 12 轮"读 items.json + 写 round-N.txt"
- 内容特征:每轮内容小(<1500 字符),天然不触发内容裁剪 → 测整段驱逐与长会话
- 指标:完成轮数 / finalUsage(input/cacheRead/output)/ 驱逐持续性(stall=0)/ 与历史基线对比

### 1.3 场景 B:单请求自主长任务(核心场景)

- 驱动:chat 单条 brief(822 字符,**7 阶段**:探索 → 逐文件精读 10 个大文件 → 逐模块评审 → 数据统计 → 修复 3 处 → 验证 → 汇总);turns=1,无后续用户消息
- fixture:8 个 2-3KB 模块 + ~3KB CSV/JSON(触发 >1500 字符裁剪阈值)
- 指标:完成状态 / 步骤数 / 耗时 / 驱逐记录(strip 裁剪 + 整段,及失败/跳过/孤儿计数)/ 交付物完整性(review ×8 + data-notes + SUMMARY)
- 每次行为变更:**至少 3 次运行取一致性**(agent 行为有方差,单次不足为凭)

### 1.4 确定性 cacheRead 重放(消除 agent 噪声)

- 工具:`tools/cache-replay.mjs <session.jsonl> --budget 30000 --strategies none,tail,batch`
- 多会话取均值(单会话噪声大);报告 Δ vs none
- 说明:重放不含裁剪粒度、绝对 cacheRead 低于真实(无 system/tools 前缀)——**相对 Δ 才是策略效应**

### 1.5 兜底回归(秒级,每次提交前)

- `node check.js`(纯函数单测)
- `node tools/replay-real.mjs <会话> tail 30000 sorted --apply`(真实 surface fold + 配对断言,0 失败)

---

## 2. 数据记录(随版本更新)

### 2.1 场景 A(12 轮,期望 12/12 Done)

| 版本 | 完成 | 整段驱逐 | finalUsage(input/cacheRead/output) | 状态 |
|------|------|---------|------|------|
| 0.1.x(历史基线) | 12/12 | 19-23 | 28.5K / 200.6K / 2.8K | 输入 −64% vs 无驱逐 |
| **0.2.0-alpha.1** | 12/12 | 15 | 5.9K / 11.8K / 0.3K | 与历史同量级,无回归 |
| **0.2.0(3.3)** | 12/12 | 14 | 5.9K / 11.8K / 0.3K | ✅ 与 alpha.1 一致(±1%),驱逐持续、0 失败 |
| **0.2.1(rc.1 口径)** | 12/12 | 0(surface <12K) | 同量级 | ✅ 小会话不触发 = 新口径正确语义(预算 12000 验证) |

### 2.2 场景 B(单请求自主长任务,3 次取一致)

| 版本 | 运行 | 结果 | 步骤 | 耗时 | 驱逐(strip/整段) | 失败/跳过/孤儿 | 交付物 |
|------|------|------|------|------|------|------|------|
| **0.2.0-alpha.1** | #1 | Done | 83 | ~9min | 29/21 | 0/0/0 | 10 docs |
| | #2 | Done | 179 | ~24min | 40/10 | 0/0/0 | 10 docs |
| | #3 | Done | 54 | ~7min | — | 0/0/0 | 10 docs |
| **0.2.0(3.3 修复后 92903b7)** | #1 | ✅ Done | 87 | ~11min | 33/17 | 0/0/0 | 10 docs |
| | #2 | ⚠️ 功能完成未收尾 | 215+(cancel) | 40min | — | 0/0/0 | 10 docs(agent 过度详读,非驱逐缺陷) |
| | #3 | ✅ Done | 38 | ~6min | — | 0/0/0 | 10 docs |
| | #4 | ✅ Done | 116 | ~17min | — | 0/0/0 | 10 docs |

> 3.3 循环回归修复验证(92903b7 恢复最近完成段硬保护):3/3 Done(87/38/116 步),cwl_recall 回到 **2-4 次**
> (回归期 61-420 次),0 fold 失败、0 孤儿、交付物 10/10 → **场景 B 验收通过**。

**rc.1 兼容(0.2.1 待发,预算 12000,新 surfaceTokens 口径)**

| 版本 | 运行 | 结果 | 步骤 | 驱逐干预 | 失败/孤儿/循环 | 交付物 |
|------|------|------|------|---------|------|------|
| **0.2.1(rc.1)** | #1 | ✅ Done | 51 | 9 次(压力 8946→3186,落到预算内) | 0/0/0 | 10 docs |
| | #2 | ✅ Done | 30 | 12 条(strip+整段) | 0/0/0 | 10 docs |
| | #3 | ✅ Done | 28 | 17 条 | 0/0/0 | 10 docs |

> 新口径关键改进:驱逐后压力降到预算内(旧累计口径永远降不下来);边界保护(92903b7)在 rc.1 仍有效。

中途驱逐证据(alpha.1,任务进行中):整段驱逐 8 区间覆盖动作+探索段;18 次内容裁剪共 **40,470 字符**(单次 2050-2559);一次整段驱逐后下一请求 cacheRead **28.4K→8.1K(−72%)**。
alpha.1 #2 观察:驱逐活跃期 input 214K/cacheRead 691K——agent 重读成本偏高,列为后续观察点。

### 2.3 确定性 cacheRead(多会话均值)

| 版本 | 会话数 | 驱逐 vs 无驱逐 | oldest/tail/batch | 状态 |
|------|--------|--------------|------------------|------|
| 0.2.0-alpha.1(历史口径) | 7 | **−24%**(区间 −18~−39%) | −23.7 / −24.1 / −24.7 | 策略差异 <2pp,batch 略优 |
| **0.2.0(3.3)** | 4 | 方向全负,强于历史 | tail −16.2~−82.7% / batch 同向 | 同向即过;单会话噪声大,方向为据 |

单会话示例(场景 A 会话):tail −15.9%、batch −16.8%(会话较小,低估口径)。

### 2.4 复测步骤(checklist)

```bash
# 1. 本地引用接入 + 确认安装内容与本地 main 一致
cd <helmsman> && git diff dsh/package.json   # dsh-cwl: file:../../dsh-cwl
diff -q dsh/node_modules/dsh-cwl/index.js <dsh-cwl-repo>/index.js

# 2. 兜底回归
cd <dsh-cwl> && node check.js
node tools/replay-real.mjs <本地会话> tail 30000 sorted --apply

# 3. 场景 A
DSH_CWL_BUDGET=30000 node dsh/launcher.mjs dsh/cordis.yml &
node benchmarks/run-context-pressure.mjs cwl 12

# 4. 场景 B ×3(同 driver/brief)
# 5. cacheRead 重放(3-5 会话)
node tools/cache-replay.mjs <session.jsonl> --budget 30000 --strategies none,tail,batch

# 6. 更新 2.1-2.3 表 + 报告留 helmsman benchmarks/
```

---
