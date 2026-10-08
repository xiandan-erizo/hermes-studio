# Hermes Studio 本机部署记录

时间：2026-10-08 13:09:19 Asia/Shanghai。用户明确要求部署在本机。

版本标记：`airs-studio-mcp-apps-v0.2`，固定本机已验证的 Studio 修复基线；不包含 Ticket Intake 源码工作区中的后续业务改造。

已部署 [评审修复记录](2026-10-08-studio-review-fixes.md) 中的四项修复：卡片来源隔离、迟到恢复与请求关联、严格调用证据校验、唯一日志实例 ID。

## 实际加载路径

- 源码：`/root/code/hermes-studio`，`dev` 工作区，修复基线 `238d7216`。部署时修复未提交，随后按用户指令提交并打上述 tag。
- 构建：已验证的 `.worktrees/review-fixes-20261008/dist`；部署前确认原工作区与验证检出的修改文件一致。
- 本机服务：`hermes-webui.service`，PID `2694013`，入口 `/root/code/hermes-studio/dist/server/index.js`，后端 `8647`。
- 公网入口：`https://hermes.airs-dev.ekuaibao.net/` 仍通过本机 Vite `8649` 读取同一工作区前端。
- Studio 托管 bridge：`2694013 → 2694199 → 2694550`；Ticket Intake MCP：`2694550 → 2694651 → 2694677`，入口 `/root/.hermes/plugins/ticket-intake/mcp/server.cjs`。

Ticket Intake 只同步 `mcp/src/widget.mjs`、`mcp/src/ticket-view.mjs`、`assets/ticket-card-v1.html`、`mcp/server.cjs`。预先审计确认业务 Python 文件、MCP 工作流入口与依赖一致；同步后的 bundle 等于使用已安装服务源码和新版 UI 重建的结果。保留 MCP Apps URI `ui://ticket-intake/ticket-card-v2.html`。新增界面为编辑授权过期后的显式重新展示操作，沿用 `ui/message`。

服务重启前，Studio 的 default profile 活跃运行快照为空。现有数据库未删除或迁移。原 dist 与四个 UI 文件保留在 `/root/.hermes-web-ui/backups/studio-local-20261008-review-fixes/`。

## 部署后检查

| 检查 | 结果 |
| --- | --- |
| systemd、启动日志 | active/running；新 bridge/MCP 进程；启动错误匹配 0 |
| 本机 `/livez`、公网页面、隔离 sandbox | 200 |
| 未登录会话接口 | 401 |
| 真实 Socket.IO 恢复 | 150 条历史消息；回传 `request_id=deploy-live-smoke`；非运行状态 |
| 实际 MCP discovery | Ticket Intake 10 个标准工具可发现 |
| 实际 MCP App resolve | 200；返回新版 HTML，含 `ticket-redisplay-draft` |
| 不存在的调用证据 | 404，`App invocation is not available`；未执行工具 |
| 真实公网页面，Chromium 1440×1000 和 390×844 | 两个尺寸均显示历史卡片和过期恢复按钮；输入框可实际填字；页面异常 0 |
| 浏览器真实 App 请求 | resolve、get draft 的 call-tool、model-context 均为 200；一个 widget，外层/内层共两个 iframe |

浏览器未模拟 API/socket/MCP，未发送 AI 消息或点击重新展示；未执行 prepare/edit/dry_run/submit，没有 Jira 调用。移动检查使用 Chromium 的手机尺寸，不代表真实 iOS Safari 验收。

部署前定向测试 182/182、全量模拟浏览器 159/159、架构检查和构建通过。全量单测仍有原修复记录中的 6 个基线失败，未扩大本次修复范围。

实际浏览器证据：

- [检查结果 JSON](/tmp/hermes-studio-fixes-20261008/artifacts/local-deployed-browser.json)
- [桌面截图](/tmp/hermes-studio-fixes-20261008/artifacts/local-deployed-1440.png)
- [手机尺寸截图](/tmp/hermes-studio-fixes-20261008/artifacts/local-deployed-390.png)
