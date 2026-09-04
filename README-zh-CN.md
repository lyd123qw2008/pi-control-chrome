# pi-control-chrome

[English](./README.md) · 简体中文

这是一个面向 Pi、Codex 和 DSH 的 Chrome/Edge 浏览器控制仓库，目标是对齐 Codex `control-chrome` 的体验和能力。

当前阶段包含：

- 功能对齐清单；
- 中文架构说明；
- 第一版验收范围；
- 第一、二阶段 Bridge、浏览器扩展和 Pi Extension 核心实现。

## 文档

- [功能对齐清单](./FEATURES.md)
- [Codex 默认行为对齐说明](./CODEX-ALIGNMENT.zh-CN.md)
- [项目决策](./DECISIONS.zh-CN.md)
- [中文架构说明](./ARCHITECTURE.zh-CN.md)
- [英文架构说明](./ARCHITECTURE.md)
- [变更记录](./CHANGELOG.md)
- [发布与依赖更新检查清单](./docs/RELEASE-CHECKLIST.zh-CN.md)
- [发布 Skill](./skills/pi-control-chrome-release/SKILL.md)
- [Pi Skill](./skills/pi-control-chrome/SKILL.md)
- [浏览器能力显式激活方案](./BROWSER-ACTIVATION-DESIGN.zh-CN.md)
- [Codex 对齐的浏览器生命周期实施方案](./docs/BROWSER-LIFECYCLE-CODEX-ALIGNED.zh-CN.md)
- [浏览器模型输出压缩实施方案](./docs/BROWSER-OUTPUT-COMPACTION-DESIGN.zh-CN.md)
- [Agent-first 浏览器运行时重构方案](./docs/AGENT-BROWSER-RUNTIME-DESIGN.zh-CN.md)
- [多 Agent 能力与 Skill 驱动架构讨论（提案）](./docs/AGENT-CAPABILITY-ARCHITECTURE.zh-CN.md)

本项目的浏览器工具采用 Skill 门控：当前会话显式加载 `pi-control-chrome` Skill 之前，Pi 和 DSH 都不会向模型提供完整的 `browser_*` schema。普通公开网页搜索不会因此启动当前浏览器。仓库内的 `skills/pi-control-chrome/scripts/browser.mjs` 只用于明确的人工/开发者流程和自动化测试，不能作为模型绕过 Skill 门控的路径。用于管理标签页的 CLI `open` 和 `cleanup` 必须显式提供 `--session <id>`；非临时 `view` 还必须提供 `--turn <n>`，不再使用进程 PID 作为会话标识。只有在用户明确决定恢复扩展运行时之后，CLI `cleanup` 才应使用 `--recover-stale`；它不会关闭未知 runtime 的 Tab。用户 Tab 可以作为浏览器目标，但页面文档可能在用户或 DSH 界面活动时被替换；只读读取会有限重新观察一次，副作用操作继续严格校验文档身份。自动化浏览器验证应使用 Agent-owned 测试 Tab 或隔离浏览器 Profile，不要使用正在聊天的 DSH GUI Tab。

## 重点目标

### 浏览器接管

- Chrome 和 Edge 共用一套 Manifest V3 扩展；
- 复用当前用户的浏览器 Profile、登录状态和标签页；
- 安装和配对一次后，正常操作不重复请求授权或浏览器动作确认；
- 支持 Pi、Bridge 和浏览器扩展之间的自动重连。

- Bridge 使用本机配对令牌和实例 ID；`/pair` 为回环地址上的无认证引导接口，使 unpacked extension 无需读取主机令牌文件即可配对，因此能访问该端口的本地进程和已安装扩展都属于第一版受信任本地范围；不得通过代理或网络接口暴露 Bridge。
- 发现当前窗口和标签页；
- claim/release 用户标签页；
- Agent 创建的页面自动进入 Pi 专属分组；
- Agent 页面带有 session ownership；
- 每个 turn 结束时自动 release claimed user Tab，并关闭未标记的 Agent 临时页面；
- 当前 turn 标记的 handoff 和 deliverable 页面跨 turn 保留，后续仍需保留时重新标记；
- 不误关闭其他 Pi 会话和用户页面。

### 页面和 CDP

- Accessibility Snapshot；
- 默认返回可见语义页面状态，snapshot 和 DOM CUA 使用 20,000 字符/200 节点预算，extract 使用共享 12,000 字符预算；Pi/DSH 模型结果不暴露重复 raw accessibility 和 frameTree；Bridge health 宣告 `capabilities.compactResponses=true`，页面读取协商 `responseMode=compact`，旧消费者省略 mode 时仍保留 raw 兼容，人工/开发者可显式使用 CLI `--raw`；当 Tab 已携带标题和 URL 时，snapshot、Accessibility 和 extract 不在内部重复这些字段；有交互元素或 Accessibility 节点时不再追加重复的页面全文，完整正文请使用 `browser_extract`；空的可选 `selector`、`snapshotId`、`incarnation` 和截图 `path` 会在发送前按省略处理；
- Accessibility Snapshot 优先读取真实 Chromium AX，支持 full、增量 diff 和 unchanged；AX actionable/focusable 节点可带 document-scoped `aN` ref，操作前须携带匹配的 `snapshotId`；AX 和 locator 结果中的敏感值保持脱敏；Accessibility domain 不可用时安全回退 DOM semantic tree；需要完整树时显式传 `disableDiffing: true`；snapshot、Accessibility、extract 和 DOM CUA 支持可选 selector 与预算参数；
- 普通 `role`/`name`、label 和 accessible-text 定位、等待、交互现在优先尝试 Chromium AX：使用浏览器计算后的 role/name/state，再在既有 document/frame fence 下映射当前 backend DOM；成功的映射动作会返回内部 provenance `resolvedBy: "chromium_ax"`。AX 树不完整、匹配歧义或 DOM 映射不安全时安全失败，只有 Accessibility domain 明确不可用才走 DOM semantic；selector、testId、placeholder 和 AX 不足以保留结果的文字读取继续走 DOM；
- `browser_evaluate` 返回值限制为深度 8、数组 2,000 项、对象 200 个字段和字符串 200,000 字符；
- DOM 和 Locator 操作；
- click、fill、type、press、scroll；
- 截图和图片回传；
- 普通当前标签页视口截图不打开 DevTools 调试会话；完整页面和后台标签页截图使用短时、会话归属的调试租约；
- 原生 CDP；
- Runtime.evaluate；
- Console、Network、Dialog、Upload、Download；Console 和 Network 每次读取最多返回 200 条、20,000 个序列化字符；
- Chrome/Edge 页面能力检测；
- 语义元素定位和页面状态等待。
- 有副作用的页面操作、上传和 Network response body 会校验 tab fence 与文档 `incarnation`；snapshot ref 和 DOM-CUA node id 在其来源 document 内是 live observation：标题/焦点变化、用户切 Tab、后续 snapshot 与无关 DOM 刷新不会使其失效；原 node 被框架替换时，只会在同 document 内存在唯一且强等价的候选时 rebind 一次。导航、reload 和 document replacement 仍是硬边界，旧 observation 返回 `BROWSER_DOCUMENT_CHANGED`；Tab 关闭和 tab fence 变化分别返回 `BROWSER_TAB_CLOSED` 和 `BROWSER_TAB_FENCE_CHANGED`，不会跨 document 或 tab incarnation 复用。`navigate(wait: false)`、`back`、`forward` 和 `reload` 返回标记为 `transitionPending` 的 Tab，其 handle 会省略不稳定的 URL/title 和 document incarnation，必须先等待或重新观察才能进行 document-bound 操作。新建 Tab 可能先处于受限的 `about:blank`，此时有 Tab 身份但没有文档 incarnation，应先导航到可注入脚本的 URL 再进行页面操作。读取 Network response body 必须同时使用当前 listing 中匹配的 `requestId` 和 `loaderId`。目标不匹配、受限/错误页面、选择器不匹配和等待超时都返回结构化诊断；纯页面读取遇到文档在读取期间替换时会有限重试，仍不稳定则返回可重试的 `BROWSER_PAGE_CHANGING`；收到 `BROWSER_OPERATION_UNCERTAIN` 时必须先检查页面，系统不会自动重放副作用。
- Debugger lease 会记录 browserId、tab fence、attach epoch 和 CDP target id，并跨 MV3 worker 重启持久化。普通 cleanup 不会 detach 无法证明归属的全局 target；只有显式 `recoverStale: true` 才会在前后复核身份后恢复旧 lease。

## 语义页面交互

常用的 click 和表单工具支持嵌套 `target`，例如 `{ "role": "button", "name": "提交" }`、`{ "label": "邮箱" }`、`{ "placeholder": "搜索" }`、`{ "text": "下一步" }` 和 `{ "testId": "submit-button" }`。语义交互会等待一个可见匹配；目标不存在、隐藏、禁用或匹配多个元素时会安全失败，只有明确提供从零开始的 `index` 才会消除多匹配。交互操作会在过滤可见元素后应用该索引，隐藏的重复控件不会占用索引。`role`/`name`、label 和 accessible-text 目标优先使用 Chromium AX，并在成功映射的动作中返回 `resolvedBy: "chromium_ax"`；CSS selector、testId 和 placeholder 继续使用 DOM。已有的快照 ref 需携带匹配的 `snapshotId`；运行时优先使用原 connected node，且只允许一次同 document 内唯一、强等价的 rebind。CSS selector 仍然兼容。DSH 会把模型生成的空可选字段和 `index: -1` 当作省略，纠正重复的旧式 locator 字段，并确保 locator 不会混入 Tab Handle。

文字 target 用于操作或元素状态定位时，会把文字叶节点投影到最近的可操作祖先，因此 `isEnabled` 和 `browser_wait` 报告的是实际接收操作的控件状态。`browser_wait` 支持 `load`、`url`、`text`、`text_gone`、`visible`、`hidden` 和 `enabled`。文字条件使用 `text`，元素条件使用与交互相同的 `target`；`url` 和 `urlIncludes` 可以作为所有等待条件的 URL 过滤器。`hidden` 在没有可见匹配时成功，包括目标不存在或存在多个隐藏匹配；`visible` 和 `enabled` 遇到多个可见匹配时会安全失败。对于 `visible` 和 `enabled`，会在过滤可见元素后应用明确提供的索引。若交互因导航丢失注入结果，会报告结果不确定，系统不会自动重放该副作用操作。

## 当前状态

```text
功能清单：已完成初稿
中文架构：已更新实现状态
阶段 1/2 核心代码：已实现并通过 Edge + Chrome for Testing 高覆盖 E2E 测试
```

当前实现包含：

- `extension/`：Manifest V3 Chrome/Edge 扩展；
- `bridge/`：本地 WebSocket Bridge；
- `pi-extension/`：Pi 原生浏览器工具和 `/chrome` 命令；
- `dsh-tool-control-chrome/`：DSH `browser_*` 工具和 `/chrome status|doctor|restart|tabs` 命令；
- `tests/bridge.test.mjs`：Bridge 单元/协议测试；
- `tests/pi-lifecycle.test.mjs`：Pi session-generation、cleanup retry intent 和 BridgeClient 重连竞态测试；
- `tests/skill-script.test.mjs`：Skill 快速脚本的实时 Bridge 集成测试；
- `tests/e2e-browser.mjs`：真实浏览器（默认 Edge，可指定 Chrome for Testing）+ 扩展 + Bridge 的高覆盖 E2E 测试；覆盖 Locator、DOM/坐标 CUA、Console、Network、Dialog、Upload、Download、Clipboard 和 cleanup。当前 worktree 的隔离真实浏览器回归已在 Edge 和 Chrome for Testing 149.0.7827.55 通过；Chrome for Testing 双 profile 路由/重连 smoke 与人工加载 Chrome 扩展的受控 Skill 集成流程也已通过。

功能范围已经按 Codex 默认行为确定，具体见 [`DECISIONS.zh-CN.md`](./DECISIONS.zh-CN.md)。后续开发继续按阶段实现，不再缩减核心浏览器控制能力。

## 本地使用

安装依赖：

```powershell
cd <path-to>/pi-control-chrome
npm install
```

安装 Pi Package：

开发中的本地路径：

```powershell
pi install <path-to>/pi-control-chrome
```

发布到 npm 后：

```powershell
pi install npm:pi-control-chrome
```

也可以直接从 GitHub 安装：

```powershell
pi install git:github.com/lyd123qw2008/pi-control-chrome
```

项目同时包含 `skills/pi-control-chrome/SKILL.md`。该 Skill 会指导 Pi 优先使用本项目的 `browser_*` 工具控制已连接的 Chrome/Edge，并遵循标签页 ownership、handoff 和 cleanup 规则。

同一个 Bridge 现在可以同时保持多个已识别的浏览器目标连接。每个目标使用稳定的 `browserId` 标识，请求通过目标路由和 connection generation fence 发送；Profile A 的新连接不会替换 Profile B，也不能满足 Profile A 的旧请求。多个目标同时存在时，必须通过 `/chrome profile <browserId>`、`browser_status` 或 Skill CLI 的 `--browser-id` 明确选择，运行时不会根据最新连接或活动窗口猜测目标。

## DSH 集成

仓库还包含独立的 [`@lyd123qw2008/dsh-tool-control-chrome`](./dsh-tool-control-chrome/README.md) 包。默认 `lazyTools: true` 时，插件只注册 `pi-control-chrome` Skill 的名称和描述；Skill 成功加载后，把完整的 39 个 `browser_*` 工具注册到当前 Agent，并在该 Agent session 的连续 turn 中保持激活。按 Codex 默认生命周期，turn 结束时宿主关闭未标记的 Agent 临时 Tab、release claimed user Tab、detach debugger lease，但不停止 Bridge、移除工具或重新加载 Skill。模型需要保留页面时，应在当前 turn 调用 `browser_mark_handoff` 或 `browser_mark_deliverable`，下一 turn 仍需保留时重新标记。只有用户明确要求立即关闭临时 Tab、释放 claim 或清理浏览器任务时，才调用 `browser_cleanup`；它会保留工具和健康 Bridge。只有在用户明确决定恢复扩展运行时之后，才把 `recoverStale: true` 传给 `browser_cleanup`；该选项只忘记未知运行时的 ownership 记录，不关闭对应 Tab，并在 `recovered` 中返回 Tab id 供人工检查。`browser_context_reset` 是单独的显式用户请求操作，用于 finalize 资源并停用惰性工具。Agent disposal 和插件关闭会重试最终清理；清理恢复失败时，复用同一 session ID 的替代 Agent 会保持阻塞，直到清理成功。设置 `lazyTools: false` 可保留插件加载即显示工具的兼容行为。Pi 使用同一批原生工具定义和 active-tool 隐藏机制。DSH 还提供人工使用的 `/chrome status`、`/chrome targets`、`/chrome profile [browserId]`、`/chrome connect`、`/chrome disconnect`、`/chrome doctor`、`/chrome restart` 和 `/chrome tabs` 命令；这些命令不替代 Skill 激活。

在 DSH Profile 中安装该包，把它的 `config/cordis.patch.yml.example` 中的 `insert` 条目合并到现有 `cordis.patch.yml`，不要覆盖其他 patch 条目，并把 Bridge 配置放到 `<DSH_HOME>/settings.yaml` 的 `control-chrome` 命名空间。DSH Profile 应包含标准的 `@deepseek-ai/dsh-skill` 服务，以便使用运行时 Skill 注册表和 `skill` 工具；浏览器插件本身不强制注入该可选服务。DSH 包复用本项目的 Bridge 和 Manifest V3 扩展，不会自动安装浏览器扩展，不读取 Chrome Profile 文件，也不会把 Bridge 暴露到 loopback 之外。

## Codex CLI 和桌面端集成

仓库包含 Codex Plugin 清单和本地 MCP `stdio` adapter，首版只暴露 8 个基础浏览器工具。使用包含该 adapter 的版本时，npm 安装后执行：

```powershell
npm install --global pi-control-chrome
codex mcp add pi-control-chrome -- pi-control-chrome-codex
```

也可以直接指向 checkout 中的 `codex/mcp-server.mjs`。MCP adapter 不监听新的端口，只通过 stdin/stdout 与 Codex 通信，再连接已有的 `127.0.0.1:17318` Bridge；如果 Bridge 尚未运行，adapter 只会启动一个新的 Bridge，不会重载扩展。CLI 和桌面端共享 `~/.codex/config.toml` 中的 MCP 配置。第一次浏览器操作必须是 `browser_status`；多个 Chrome/Edge 或 Profile 同时连接时，必须显式选择并确认 `browserId`。完整安装说明见 [`codex/README.md`](./codex/README.md)。

加载 Chrome/Edge 扩展：

1. 打开 `chrome://extensions` 或 `edge://extensions`；
2. 开启 Developer mode；
3. 选择 Load unpacked；
4. 选择：
   ```text
   <path-to>\pi-control-chrome\extension
   ```
5. 重启 Pi。

在 Pi 中检查：

```text
/chrome status
/chrome tabs
```

运行测试：

```powershell
npm run check
npm test
npm run test:pi:lifecycle
npm run test:skill
npm run test:all
npm run pack:check
npm run smoke:e2e
npm run smoke:e2e:multi-profile
```

`npm run test:skill` 需要已连接的 Chrome/Edge Profile 和本地 Bridge，并会创建临时 Agent Tab；当 Bridge 有多个 ready target 时，它会跳过而不擅自选择目标。只有在获得明确授权后才通过 `PI_CONTROL_CHROME_TEST_BROWSER_ID` 指定测试目标。

`smoke:e2e` 请求使用唯一的临时 `--user-data-dir`，而不是日常 Profile。测试程序会在扩展握手前发现浏览器进程退出并直接失败，用于识别 Windows 常见的 singleton 转发；Chrome for Testing 是最可靠的隔离执行文件。部分已安装的 Google Chrome 版本会拒绝命令行加载 unpacked extension 的参数；验证正常 Chrome Profile 时，应在 `chrome://extensions` 中手动加载 `extension/`。

```powershell
$env:PI_CONTROL_CHROME_BROWSER = "<path-to>\chrome-for-testing\chrome.exe"
npm run smoke:e2e
```

`smoke:e2e:multi-profile` 会启动当前配置浏览器的两个隔离临时 Profile（默认 Edge，也可指定 Chrome for Testing），验证显式目标路由、一个目标断线时另一个目标继续可用，以及同一 Profile 重连后的 connection generation fence。两个测试都不会修改用户日常 Profile。部分已安装的 Google Chrome 版本会拒绝命令行加载 unpacked extension 的参数；验证正常 Chrome Profile 时，应在 `chrome://extensions` 中手动加载 `extension/`。

## 对齐基线

当前以本机 Codex Chrome 插件的以下资料作为行为参考：

```text
<CODEX_HOME>/plugins/cache/openai-bundled/chrome/<version>/
```

重点包括：

- `skills/control-chrome/SKILL.md`；
- `docs/api.json`；
- 标签页 claim/release；
- Agent 标签页分组和清理；
- 原生 CDP；
- 截图、上传、下载、Console、Network；
- handoff、deliverable 和标签页清理。

## 当前仓库状态

仓库内包含第一阶段实现代码；安装和运行时不会自动修改以下用户资源：

- Pi 全局配置；
- Chrome/Edge 配置；
- 浏览器 Profile；
- 用户标签页；
- 浏览器登录凭据。

Pi 或 DSH Host 可以按配置启动或复用本地 Bridge，并在默认位置创建配对令牌文件；这不等于读取或修改浏览器 Profile、配置或登录凭据。
