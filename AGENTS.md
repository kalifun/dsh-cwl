# AGENTS.md — dsh-cwl 开发约定(给 AI agent 与协作者)

## 项目

dsh-cwl:DeepSeek Harness 的 CWL(结构化上下文驱逐)插件 —— 自动推导 expl/act episode
图,上下文超预算时零 LLM 确定性驱逐。范式 arXiv:2606.11213。详见 README.md(中英双语)。

## 结构

- `lib.js` — 纯函数(episode 推导 / 驱逐选择 / 区间合并),**必须保持无依赖可独立测试**
- `index.js` — 插件主体(pre-step 压力检查、驱逐执行、cwl_recall 工具、HTTP 端点)
- `check.js` — 单元测试(`node check.js` 提交前必须通过)
- `tools/` — 分析/评测/回放工具(通用代码,零数据依赖)
- `README*.md` — 中英文双语文档,改动需同步

## 硬性约定(违反即事故)

1. **隐私红线:禁止把真实会话/聊天内容、用户数据、凭据、运行产物提交进本仓库。**
   包括但不限于:session.jsonl(含 `.zstd` 多帧压缩格式)、对话文本、团队内部报告、
   含本地路径/命令/输出的工具结果、任何密钥/token。**数据一律本地化**
   (`~/.dsh/sessions/`、helmsman `.sessions/`、`/tmp/`),仓库只放代码 + 通用工具 + 文档。
2. 需要真实数据验证时:用 `tools/` 的通用脚本跑**本地**会话
   (如 `node tools/eval-episodes.mjs <本地会话> <本地GT>`),结论(数字/发现)可进文档,
   **原始数据不进仓库**。
3. 拿不准就 ask:任何"真实运行产物 / 他人内容 / 内部数据"入库前,先征求用户明确同意,
   并确认已脱敏。提交信息同样不得内嵌数据内容(会话 id、路径、片段)。
4. `node check.js` 必须通过才能提交;改动 `lib.js` 后除单测外,可用本地会话跑
   `tools/eval-episodes.mjs` / `tools/replay-real.mjs` 做回归(数据留本地)。
5. 版本与发布:main 默认驱逐策略 tail+batch(env 可覆盖,见 README);
   发布走 `npm version` + `npm publish --tag alpha`(prerelease 线),
   **未转正前不得动 `latest` 线**;alpha 包发布需 OTP,由仓库所有者执行。
6. 文件权限与历史:任何误提交的敏感内容,立即从历史清除(reset/filter-repo + force push),
   不要只删当前版本。
