# Hermes Studio 评审问题修复记录

日期：2026-10-08。对应 [2026-10-03 评审](2026-10-03-studio-review.md)，基线为 `238d7216`。

本文件记录部署前的验证状态。用户随后授权部署，本机部署及实际浏览器检查见 [本机部署记录](2026-10-08-local-deployment.md)。

四项代码发现均已修复并同步到 `/root/code/hermes-studio` 的 `dev` 工作区。没有提交、推送、部署、重启服务或修改业务数据库；Ticket Intake 安装版本未同步。原评审文档保留历史结论。

| 问题 | 实现 | 回归证据 |
| --- | --- | --- |
| R1：跨 MCP 服务合并同 ID 草稿 | 合并键改为完整工具名与草稿 ID 的 JSON 元组；同来源仍保留稳定 iframe 绑定及最高版本 | 跨服务、不同工具、不同草稿、分隔符边界及私有 `_meta` 隔离测试；Chromium 双 iframe 各收自己的输入、结果和测试令牌，单来源更新不重建其它 iframe |
| R2：8 秒后忽略运行状态 | 超时继续加载历史，但同一次有效恢复的迟到响应仍恢复队列、审批/澄清和实时监听；HTTP 回包应用前检查是否已被 Socket 或会话切换取代 | 7 秒、8.001 秒、20 秒；旧 HTTP 晚到；切换会话后旧响应；真实浏览器停止按钮、队列、审批、后续输出 |
| R2 补充：A→B→A 响应误配 | Studio 内部 `resume` 请求带 `request_id`，服务端每次异步响应原样回传，客户端和重连按它匹配 | 实际 Socket 客户端与服务端乱序测试、浏览器返回同一会话测试；旧响应不能消耗新回调 |
| R3：失败来源重绑为成功调用 | 删除按同草稿猜测调用的 fallback，要求原始工具名和调用 ID 对应唯一成功结果 | 缺失、失败、错误工具、重复来源/候选拒绝；真实 SQLite HTTP 验证不执行工具、不覆盖其它上下文；有效旧调用仍保留原身份 |
| R4：日志实例 ID 重复 | 计数器移到 Vue 模块作用域，保持 `app-N` 格式 | 实际挂载两个组件并卸载重挂载，三次 ID 唯一，卸载日志与各自实例对应 |

恢复关联 ID 是 Studio 的内部 Socket 字段，不是新增插件/MCP 私有事件。用户/profile/session 权限检查不变。无关联 ID 的旧服务端响应仍可使用原协议；同会话的完整乱序保护需部署更新后的 Studio 服务端。

## 测试结果

| 检查 | 结果/边界 |
| --- | --- |
| 原工作区最终定向测试 | 12 文件、182 用例全部通过 |
| 新增 Chromium 回归 | 4/4 通过：慢恢复、切换会话、返回同会话、跨来源 iframe 隔离 |
| 架构检查和独立检出构建 | `harness:check`、前后端类型检查、生产构建通过 |
| 全量单元/集成测试 | 613 文件、5048 用例：5036 通过、6 失败、6 跳过；未宣称覆盖率合格 |
| 全量浏览器＋已安装 widget，修复 SSO mock 前 | 159 用例：155 通过、4 失败；失败为 3 个 SSO status 夹具遗漏和安装版缺失过期恢复按钮 |
| 补齐 SSO status mock 的登录回归 | 3/3 通过，只修改测试夹具，不修改登录逻辑 |
| 全量浏览器＋开发版 widget，最终结果 | 159/159 通过，无跳过；均为模拟 BFF/socket/MCP，不是实际模型或 Jira 验收 |

完整慢恢复浏览器测试先在未修改的 `238d7216` 上复现失败：迟到响应后没有 Stop 按钮。修复后通过。各项代码回归在修复前都已确认失败，之后完成红绿验证。新增测试来自已有真实组件/Store/HTTP/socket/iframe；不只检查源码文字。

## 尚未解决或发布

全量单测的 6 个失败仍是原评审记录的基线问题：root 下的 Ekko 权限故障模拟 3 个，session summary 旧断言 1 个，RTL 样式断言 1 个，以及全量负载下的 module-boundaries 超时 1 个。module-boundaries 单独复跑 10/10 通过。未为四项修复顺带改写这些其它模块。

已安装 Ticket Intake widget 仍缺少过期恢复 UI。最终浏览器成功使用的是 `/root/code/hose-skills/plugins/ticket-intake/assets/ticket-card-v1.html` 开发工作区产物；不能据此声称已安装版本升级或线上恢复通过。没有运行真实 AI→草稿→Jira 流程，没有 Jira 写入。

当前 `hermes-webui.service` 没有重启，未加载新的服务端恢复关联和调用证据校验。公网 Vite 读取原工作区前端源码，但这不等于全套发布已完成。下一次部署应同时核对服务端构建、插件安装资源和浏览器验收版本。

## 文件与证据

独立验证检出：`/root/code/hermes-studio/.worktrees/review-fixes-20261008`，分支 `codex/review-fixes-20261008`。修改已逐文件比对同步回原工作区，保留未提交状态。

主要实现：

- [卡片来源隔离](../../packages/client/src/utils/hermes/mcp-app-result.ts:128)
- [迟到恢复与 HTTP 竞态保护](../../packages/client/src/stores/hermes/chat.ts:1957)
- [客户端恢复关联](../../packages/client/src/api/studio/chat.ts:903)
- [服务端恢复关联](../../packages/server/src/modules/studio/sockets/chat-run.ts:714)
- [严格调用证据](../../packages/server/src/modules/studio/services/mcp-apps/interactions.ts:35)
- [独立实例 ID](../../packages/client/src/components/hermes/chat/McpAppResultCard.vue:1)

本轮测试日志保留于 `/tmp/hermes-studio-fixes-20261008/artifacts/`：

- [最终全量单测 JSON](/tmp/hermes-studio-fixes-20261008/artifacts/vitest-final.json)
- [原工作区定向回归](/tmp/hermes-studio-fixes-20261008/artifacts/primary-focused.log)
- [最终全量浏览器 JSON，开发 widget](/tmp/hermes-studio-fixes-20261008/artifacts/playwright-source.json)
- [安装 widget 对照 JSON](/tmp/hermes-studio-fixes-20261008/artifacts/playwright-final.json)
- [构建日志](/tmp/hermes-studio-fixes-20261008/artifacts/build.log)
- [架构检查](/tmp/hermes-studio-fixes-20261008/artifacts/harness.log)
- [边界测试单独复跑](/tmp/hermes-studio-fixes-20261008/artifacts/boundary-rerun.log)

浏览器结果可用 `PLAYWRIGHT_PORT=14989 MCP_APP_VISUAL_WIDGET_PATH=/root/code/hose-skills/plugins/ticket-intake/assets/ticket-card-v1.html npx playwright test --workers=2` 重跑。请在独立检出中运行构建，以免覆写当前运行服务的 `dist`。
