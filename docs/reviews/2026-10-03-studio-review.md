# Hermes Studio 代码、功能与测试评审

这是修复前的评审快照。四项代码发现的处理结果见 [修复记录](2026-10-08-studio-review-fixes.md)，部署结果见 [本机部署记录](2026-10-08-local-deployment.md)。

日期：2026-10-03。结论：**当前不建议作为正式发布验收通过**。最新提交包含两项已复现的高优先级缺陷；另外，已安装的 Ticket Intake UI 与测试使用的开发版本尚未一致。构建通过不等于功能验收完成。

## 范围与执行边界

- 深度代码评审：`238d7216cde351fda30839cbd3af2b977449e732` 相对父提交 `91926528`，26 个变更文件。
- 功能与测试：Studio 全量现有 Vitest 和 Chromium 用例；MCP App 额外做过期恢复、跨页面刷新累计的 Save/Continue 行为检查。
- 已运行全量测试不代表逐行审阅全站源码；全站人工代码评审仍需按模块分批。
- 原仓库产品代码未修改，未提交、推送、部署或重启。该文档是本轮唯一新增的原仓库文件。
- 使用独立检出 `/tmp/hermes-studio-review-20261003.FaY5Cd/checkout`；父提交对照在同目录的 `baseline`。测试使用临时状态目录、独立端口和模拟服务。
- 未调用真实 Hermes/模型完成工单流程，未调用 Jira。公网只做未登录页面和未认证接口拒绝检查。

## 代码发现

### R1 · P1 · 不同 MCP 服务的草稿可能被合并，并将私有结果交给错误 iframe

位置：[mcp-app-result.ts](../../packages/client/src/utils/hermes/mcp-app-result.ts:130)。

`latestByDraft` 和 `projectedDrafts` 仅以 `draftId` 为键；候选识别则接受任意以 `__render_ticket_card` 结尾的工具。两个 MCP 服务都返回 `dr_shared` 时，投影保留服务 A 的工具和调用 ID，却使用服务 B 的新结果，B 的 App 行被删除。`McpAppResultCard` 随后将该结果发送给 A 的 iframe。

实际函数复现使用 `mcp__alpha__render_ticket_card` 和 `mcp__beta__render_ticket_card`：保留 Alpha 行，但其中包含 Beta 的 `structuredContent` 和 `_meta.ticketEdit.editToken`。这是同一会话内跨服务的数据/凭据误投递；没有声称已发生跨用户利用。

修复方向：展示身份至少包含原始 MCP 服务/完整工具名和实体 ID；只有同一来源的结果才能合并。测试必须包含两个服务相同草稿 ID、不同资源与不同 `_meta`，并断言两张视图均保留且数据不串。

### R2 · P1 · 恢复会话超过 8 秒后丢弃运行状态

位置：[chat.ts](../../packages/client/src/stores/hermes/chat.ts:1969)。

超时后 `resumeTimedOut` 永久为 true，随后到达的 `resumed` 被直接忽略。HTTP fallback 只恢复持久化消息，没有补回 `isWorking`、队列、审批/澄清事件。新页面因此不安装正在执行任务的事件监听器，用户可能看见空闲状态，收不到后续输出或操作提示。

实际 Pinia store 配合假时钟和模拟 HTTP/socket 的对照结果：

| 恢复延迟 | streaming | 注册运行监听器 |
| --- | --- | --- |
| 7000 ms | true | 1 |
| 8001 ms，且 HTTP fallback 成功 | false | 0 |

第二个用例按“正在运行的会话应继续恢复”断言失败。修复不能仅延长超时，应在当前 session/request generation 仍有效时处理迟到的运行状态，或执行明确的状态重同步；同时防止切换会话后应用过期响应。

复现文件：[resume.test.ts](/tmp/hermes-frontend-review.PCOFTM/resume.test.ts)。

### R3 · P2 · invocation fallback 放宽了成功且唯一的来源校验

位置：[interactions.ts](../../packages/server/src/modules/studio/services/mcp-apps/interactions.ts:94)。

原始调用结果缺失、失败或重复时，fallback 从 assistant 参数中取草稿 ID，寻找另一条成功调用，并返回另一条调用的身份。它没有要求原 assistant 调用的工具名匹配，也没有重验候选结果唯一性。

父提交/当前提交的实际函数对照：原调用失败、尚无结果、属于别的工具、候选自身具有重复成功/失败结果，这四种情况都从父提交的 404 变成重绑成功。上下文写入会归到另一调用并覆盖其快照。跨用户、跨 profile 和完全未知调用仍返回 404，所以本发现是调用来源/归属边界问题，不是跨用户越权结论。

修复方向：对来源调用与候选调用同时保持完整的工具名、唯一成功证据校验；确需重绑时定义可接受的旧调用状态，而不是任何校验失败都转入 fallback。

复现：[invocation-fallback-probe.mjs](/tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/invocation-fallback-probe.mjs)。

### R4 · P2 · 所有卡片实例的诊断 ID 都是 app-1

位置：[McpAppResultCard.vue](../../packages/client/src/components/hermes/chat/McpAppResultCard.vue:15)。

`let nextAppInstance = 0` 位于 `<script setup>`。Vue 编译器将计数器与递增都放入每个实例的 `setup()`，每次挂载都会重置。当前日志无法区分并存卡片或重新挂载，正好失去这次生命周期排查最需要的证据。

修复方向：模块级计数器或真实唯一 ID；用两个实际组件及一次重新挂载验证 ID 不重复。现有日志字段白名单测试不覆盖实例身份。

## 功能验收

| 功能 | 本次证据 | 结论/限制 |
| --- | --- | --- |
| 同源同草稿 v2→v3、PiP 原位更新 | 现有工具投影测试、源码 widget 浏览器用例 | 模拟服务下通过；跨服务同 ID 存在 R1 |
| PiP/inline/fullscreen 往返 | 浏览器 iframe 实例断言 | 基本路径通过；真实手机软键盘未验收 |
| 手机输入框可达 | 390×844 浏览器视口、composer focus | 基本布局通过；不是 iOS Safari 实机结论 |
| 草稿 Save/冲突/Reload | 使用已安装和源码两种 widget 的加强审计 | 两者都通过；跨 page.reload 累计只出现显式 Continue 的一次 run/message，保存未额外启动 AI |
| Continue | 加强审计检查累计 run=1、ui/message=1 | 前端触发契约通过；后续真实模型校验和 Jira 禁写由本测试无法证明 |
| 授权过期恢复 | 已安装 widget 与工作区源码分别运行 | 安装版失败，源码版通过；不能把源码成功当部署成功 |
| 断线/慢恢复 | 常规流式测试通过，新增迟到恢复探针失败 | R2 阻塞发布 |
| 用户/profile/session 隔离 | 全量现有服务端权限测试通过，补充反例探针 | 跨用户/profile探针仍拒绝；R3 的调用来源边界需修复 |
| 普通用户 UI、双标签、历史深链、分类、文件预览 | 现有 Chromium 用例 | 模拟 BFF/Socket 契约通过 |
| 公网访客行为 | 浏览器打开当前部署；无凭据请求 sessions/resolve/message | 登录表单可见，无 pageerror；三个接口均 401。未尝试登录或生成真实业务状态 |

部署证据：公网仍由 Vite 提供源码前端；`hermes-webui.service` 在本轮检查中保持原进程。`/root/.hermes/plugins/ticket-intake/assets/ticket-card-v1.html` 与 `/root/code/hose-skills/plugins/ticket-intake/assets/ticket-card-v1.html` 不同；后者来自未提交工作区。不能作为一套已发布版本验收。

## 测试结果与失败分类

| 检查 | 结果 |
| --- | --- |
| `npm run harness:check` | 通过 |
| 独立检出 `npm run build` | 通过，含前后端类型检查；存在大 bundle 提示 |
| `npm run test:coverage -- --maxWorkers=4` | 611 个测试文件，5003 个用例：4977 通过、20 失败、6 跳过 |
| 全量 Chromium，指定已安装 widget，workers=2 | 155 个用例：151 通过、4 失败、0 跳过 |
| 父提交与当前提交对照重跑原 7 个失败文件 | 当前 73/91 通过、18 失败；父提交 72/91 通过、19 失败 |
| 父提交登录浏览器用例 | 同样 3 个失败，缺失 SSO status mock |
| 已安装 widget 加强 Save 审计 | 通过；唯一 run/message 来自 Continue |
| 源码 WIP widget 可选浏览器用例 | 3/3 通过，含加强 Save 审计及显式过期恢复 |

全量覆盖命令因失败退出，未生成可作为验收依据的覆盖率报告；这里不提供虚假的覆盖率百分比。全部 mock 浏览器用例不等同于真实模型或真实 Jira 集成测试。

20 个初始 Vitest 失败的分类：

| 数量 | 文件/原因 | 对照结果 |
| ---: | --- | --- |
| 13 | `studio-mcp-autoinject` 将 cwd 下的 launcher 当作稳定安装；本轮 cwd 在 `/tmp`，产品正确拒绝自动注入 | 父提交同样失败；测试环境假设 |
| 3 | Ekko recovery/manager 通过 chmod 模拟无权限；以 root 运行仍能修复数据库 | 父提交同样失败；权限故障模拟不足 |
| 1 | `sessions-db` 精确期望缺少实际的 `parent_session_id:null` | 父提交同样失败；既有断言不同步 |
| 1 | `rtl-logical-css` 发现 3 处物理方向样式 | 父提交同样失败；不是本提交新增失败 |
| 1 | Windows/Pi runtime 测试漏 mock `addUserMessage`，触及无 schema 数据库 | 父提交复现；当前串行重跑通过，存在夹具/顺序依赖 |
| 1 | module-boundaries 测试超过默认 5 秒 | 独立架构检查和串行重跑通过；负载敏感 |

4 个浏览器失败：

- `auth.spec.ts` 的三个用例：`/api/auth/sso/status` 未注册 mock，被记录为 unexpected route；父提交复现。不能据此认定线上登录损坏。
- `mcp-app-result.spec.ts` 的过期恢复：安装版在收到 `edit_authorization_expired` 后没有“重新展示草稿”按钮。这是可复现的安装版功能缺口。

完整 155 个浏览器用例覆盖：聊天流式 17、双标签 3、历史深链 8、群聊深链/分享 36、工作流 28、桌面窗口外观 14、MCP 11，以及登录、导航、普通用户页面、分类、渠道、文件预览、provider、skills、主题和语音等。本轮没有验证真实 Electron 安装包、macOS/Windows 桌面运行、Safari/WebKit、手机软键盘、真实第三方服务授权。

## 测试与文档维护缺口

1. 三个真实 Ticket widget 用例默认依赖 `MCP_APP_VISUAL_WIDGET_PATH`，CI 未指定，默认会跳过。应固定版本的可复现插件测试资源，再将关键编辑/过期用例列为必跑。
2. 现有编辑测试到 Save/conflict/reload 之后才记录 `runsBefore`，可能漏掉 Save 意外启动 AI。本轮临时探针跨刷新累计 run/messages，验证当前两版 widget 无该问题；应把这种断言纳入正式测试。
3. 缺少跨服务同 ID、>8s 迟到 resume、失败/重复来源 fallback、同版本换授权、连续过期恢复、切换 session 期间 ui/message 响应的正式回归。
4. 文档仍有边界冲突：设计声称 Studio 不解析 `draft_id`，实际已解析；文档称通用默认 PiP，实际只识别 `ui://ticket-intake/`；“模型上下文不含草稿 ID”与实际使用 `ticketDraft.draftId` 不符。应选定真实约定后更新文档，避免后续再添相反实现。
5. 手机 fullscreen 是模态 dialog，composer 会 inert；留出底部空间不等于可继续输入。这里作为产品取舍记录，不将标准 fullscreen 的模态行为单独认定为 bug。当前已验证的是 PiP 中可输入。

## 建议修复顺序与验收条件

| 顺序 | 工作 | 完成标准 |
| --- | --- | --- |
| 1 | R1：按来源隔离卡片合并 | 跨服务器同 draft ID 保持两张独立视图，`_meta` 不跨 iframe |
| 2 | R2：恢复超时仍能重同步运行状态 | 7s/8.001s/更晚响应、切换会话、队列/审批/流式状态都有确定结果 |
| 3 | R3、R4：调用证据与日志身份 | 无效/重复来源保持拒绝；不同挂载实例日志 ID 唯一 |
| 4 | 统一插件发布资源和 Studio 验收对象 | 已安装 widget 的过期恢复通过；版本、源码提交和运行时来源可核对 |
| 5 | 修复测试基线及正式补测 | 处理 root/tmp/mock 假设；CI 固定插件资源；Save 零 AI 等反例进入正式回归 |
| 6 | 真实环境验收 | 隔离测试账户/profile：建草稿→修改→刷新→过期恢复→切换用户；确认没有 Jira 提交请求。另做真实手机键盘测试 |

本轮只评审与测试，不自动执行上述修复或部署。

## 逐文件评审覆盖

OCR preview：`total_files=26`、`reviewable_files=14`、默认排除 12 个文档/测试；本轮额外审阅所有排除项，最终 `reviewed_files=26`、`skipped_files=0`、`coverage_rate=100%`（仅指该提交文件覆盖，非代码测试覆盖率）。

| 文件 | 结论 |
| --- | --- |
| `packages/client/src/api/hermes/mcp.ts` | 已审，消息校验 API |
| `packages/client/src/components/hermes/chat/ChatPanel.vue` | 已审，布局 observer；实机键盘待验 |
| `packages/client/src/components/hermes/chat/McpAppResultCard.vue` | 已审，R4；标准模式与模态边界 |
| `packages/client/src/stores/hermes/chat.ts` | 已审，R2 |
| `packages/client/src/utils/hermes/mcp-app-diagnostics.ts` | 已审，日志 opt-in/字段白名单 |
| `packages/client/src/utils/hermes/mcp-app-message.ts` | 已审，单 user 文本限制 |
| `packages/client/src/utils/hermes/mcp-app-pip.ts` | 已审，claim/release |
| `packages/client/src/utils/hermes/mcp-app-result.ts` | 已审，R1 |
| `packages/server/src/modules/hermes/controllers/mcp-app-interactions.ts` | 已审，调用新 validator |
| `packages/server/src/modules/hermes/routes/mcp.ts` | 已审，scoped profile 中间件 |
| `packages/server/src/modules/hermes/services/bridge/python/bridge_mcp_interactions.py` | 已审，变动仅 annotations 赋值位置 |
| `packages/server/src/modules/studio/public/mcp-apps.ts` | 已审，facade 导出 |
| `packages/server/src/modules/studio/services/mcp-apps/interactions.ts` | 已审，R3 |
| `tests/e2e/fixtures.ts` | 已审，mock listener helper |
| `tests/client/mcp-app-diagnostics.test.ts` | 已审，缺真实多实例测试 |
| `tests/client/mcp-app-message.test.ts` | 已审 |
| `tests/client/mcp-app-pip.test.ts` | 已审，helper 级测试 |
| `tests/client/mcp-app-result.test.ts` | 已审，缺跨服务身份反例 |
| `tests/e2e/mcp-app-result.spec.ts` | 已审，外部资源跳过/Save 审计缺口 |
| `tests/server/mcp-app-interaction-http.test.ts` | 已审，真实 SQLite 配合模拟 auth/bridge |
| `tests/server/mcp-app-interaction.test.ts` | 已审，缺新增 fallback 分支反例 |
| `docs/mcp-app-interactions.md` | 已审，默认 PiP 描述不符 |
| `docs/superpowers/plans/2026-09-21-ticket-draft-edit-continue.md` | 已审 |
| `docs/superpowers/plans/2026-09-23-ticket-intake-standard-pip-mobile.md` | 已审，与实际业务字段解析边界不符 |
| `docs/superpowers/specs/2026-09-21-ticket-draft-edit-continue-design.md` | 已审 |
| `docs/superpowers/specs/2026-09-23-ticket-intake-standard-pip-mobile-design.md` | 已审，通用性/隐私/移动端承诺需同步 |

## 证据与复跑入口

临时证据目录：`/tmp/hermes-studio-review-20261003.FaY5Cd/`，保留便于复查，未自动清理。

- [全量 Vitest JSON](/tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/vitest-results.json)
- [全量 Playwright JSON](/tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/playwright-results.json)
- [父提交失败对照](/tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/parent-baseline.json)
- [当前提交单独复跑](/tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/failed-rerun.json)
- [跨服务投影与 Vue 实例 ID 复现](/tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/frontend-probes.mjs)
- [迟到会话恢复复现日志](/tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/late-resume-repro.log)
- [构建日志](/tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/build.log)
- [架构检查日志](/tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/harness.log)
- [Save/过期安装版与源码对照、命令和截图](/tmp/hermes-studio-review-20261003.FaY5Cd/browser-probes/evidence.md)
- [公网访客登录页面](/tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/public-login.png)

执行入口（均从独立检出目录运行；原命令设置了独立 HERMES_HOME/端口/结果路径）：

```sh
npm run harness:check
npm run build
npm run test:coverage -- --maxWorkers=4 --reporter=json --outputFile=/tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/vitest-results.json
PLAYWRIGHT_PORT=14173 MCP_APP_VISUAL_WIDGET_PATH=/root/.hermes/plugins/ticket-intake/assets/ticket-card-v1.html npx playwright test --workers=2
node /tmp/hermes-studio-review-20261003.FaY5Cd/artifacts/invocation-fallback-probe.mjs
```
