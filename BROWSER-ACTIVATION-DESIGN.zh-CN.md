# 浏览器能力激活、渐进式暴露与任务清理方案

本文档定义 Pi 和 DSH 浏览器工具的激活、cache-clean 渐进式暴露、普通 turn checkpoint、显式任务 finalize、context reset、Agent disposal 和插件关闭语义。固定 facade 的 API、operation registry 和验收细节见 [`browser-progressive-exposure-plan.md`](./browser-progressive-exposure-plan.md)；Codex 生命周期对齐方案见 [`docs/BROWSER-LIFECYCLE-CODEX-ALIGNED.zh-CN.md`](./docs/BROWSER-LIFECYCLE-CODEX-ALIGNED.zh-CN.md)。

## 1. 背景

`pi-control-chrome` 和 `dsh-tool-control-chrome` 使用惰性 Bridge 连接。Pi 扩展静态注册浏览器工具但默认从 active set 隐藏；DSH 默认 `exposureMode: lazy-full`、`lazyTools: true` 时只暴露 Skill 元数据，Skill 成功加载后才向当前 Agent 提供完整的 44 个 raw `browser_*` 工具。DSH 的 `exposureMode: progressive` 则从插件启动时只固定注册三个核心 facade 工具：`browser_capabilities`、`browser_call`、`browser_status`；后续能力说明通过 tool result/message 渐进返回，不改变工具集合，其他 operation（包括生命周期 operation）通过 `browser_call` 派发。Bridge 不一定立即连接，模型也不应在用户没有明确要求浏览器时主动使用当前浏览器。

浏览器控制应当与普通搜索和普通推理区分开。它会访问用户当前 Chrome/Edge Profile、登录态、标签页和页面数据，也会带来较高的上下文和运行时成本。

本项目借鉴 Codex `control-chrome/node_repl` 的固定入口和按需文档思路，但 DSH progressive mode 先采用结构化 operation dispatcher：不引入任意 Node.js/JavaScript 执行器，也不允许任意 Bridge method 透传。

参考资料：

- [Tencent BrowserSkill](https://github.com/Tencent/BrowserSkill)
- [Tencent BrowserSkill lazy-tools.ts](https://github.com/Tencent/BrowserSkill/blob/main/packages/dsh-plugin-browserskill/src/lazy-tools.ts)
- [Pi Extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi Skills](https://pi.dev/docs/latest/skills)
- [DSH Tool Registry](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)
- [DSH Skills](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md)

## 2. 最终形态

```text
插件安装在 DSH Profile 或 Pi package 中
    ↓
根据 host exposure mode 选择固定 facade 或 lazy-full raw catalog
    ├─ lazy-full：只暴露 Skill 元数据
    │     ↓ Skill 成功后，当前 Agent 获得完整 44 个 raw browser_* 工具
    └─ progressive：从插件启动时固定暴露 facade
          ↓ browser_capabilities 返回能力组/单 operation schema
          ↓ browser_call 派发已校验 operation，不注册新工具
    ↓
第一次真实浏览器工具调用时才连接 Bridge
    ↓
同一个 Agent session 内连续复用浏览器能力
     ↓
普通 turn 结束执行 Codex-style turn cleanup：关闭未标记 Agent 临时 Tab、release claimed user Tab、detach debugger lease，不停止 Bridge
     ↓
用户明确要求 browser_cleanup 时立即 finalize 当前任务资源并保留 lazy-full catalog 或 progressive facade
     ↓
显式 browser_context_reset 清理上下文；lazy-full 停用 raw catalog，progressive 保留固定 facade
     ↓
session 结束或 Agent disposal 时执行最终 cleanup
```

核心规则：

> Skill 负责显式意图和使用指导，tool-control-chrome 负责原生浏览器运行时；progressive mode 的能力发现通过 message/tool result 完成，绝不在会话中途改变模型可见的工具定义。

## 3. 核心决策

### 3.1 继续使用可选 Profile 插件

`tool-control-chrome` 不进入 DSH 核心仓库：

- DSH Profile 可选安装 `@lyd123qw2008/dsh-tool-control-chrome`。
- Pi 继续通过 `pi-control-chrome` package 提供扩展和 Skill。
- Bridge、Manifest V3 extension、BrowserTargetTracker、Browser identity 和 ownership 协议保持不变。
- 插件加载不代表已经连接浏览器，也不代表当前 Agent 已获得浏览器工具。

### 3.2 DSH exposure mode

DSH 插件同时提供工具注册模式和兼容开关：

```yaml
control-chrome:
  exposureMode: progressive
  lazyTools: true
```

`exposureMode: progressive`：

- 插件加载时只注册固定 `browser_capabilities`、`browser_call`、`browser_status` 三个核心工具；
- 完整 44 个 raw `browser_*` schema 不会加入 progressive 会话；
- `browser_capabilities` 通过 tool result 返回能力组和单 operation schema；
- `browser_call` 通过固定参数 schema 派发 registry 中的 operation；确认型生命周期 operation 需要在用户明确确认后传入 `arguments.confirmed: true`；
- Skill 成功加载不会再改变工具集合；
- 第一次真实浏览器工具调用时才建立 Bridge WebSocket。

默认和兼容模式仍为：

```yaml
control-chrome:
  exposureMode: lazy-full
  lazyTools: true
```

`lazy-full` 下，插件初始只提供 Skill 元数据，Skill 成功后把完整 44 个 raw 工具注册到当前 Agent。设置 `lazyTools: false` 可保留插件加载即显示完整 raw 工具的旧行为，适合调试、迁移和暂时不使用 Skill 的旧 Profile。两种 raw 模式仍保留 Bridge 的惰性连接和 BrowserTargetTracker 保护。`exposureMode` 在插件启动时确定，不能由 capability 查询或 Skill 激活在会话中途切换。

### 3.3 Skill 名称统一为 `pi-control-chrome`

Pi 和 DSH 使用同一个 Skill 名称：

```text
pi-control-chrome
```

Skill 内容负责：

- 说明浏览器能力需要用户明确意图；
- 区分 `web_search` 和真实浏览器控制；
- 指导 `status → tabs → snapshot → action → verify` 流程；
- 指导 Tab ownership、handoff、deliverable 和 cleanup；
- lazy-full 模式下告知模型 Skill 加载成功后才能使用 raw `browser_*` 工具；progressive 模式下指导模型先查询 `browser_capabilities`，再通过三个核心 facade 使用 operation，生命周期 operation 也通过 `browser_call` 派发。

### 3.4 Progressive 不动态拆分 raw Core/Advanced

progressive mode 不使用 `browser_activate`、`browser_enable_advanced` 或中途的 `tools.register()` 来逐层加入 raw schema：

- 固定 facade 从会话开始存在；
- `browser_capabilities` 返回 bootstrap、observe、navigate、interact、advanced、lifecycle 分组；
- 完整 operation schema 按单 operation 通过 tool result 返回；
- `browser_call` 只派发固定 registry 中的 operation；
- 明确需要确认的 restart、extension reload、cleanup、context reset 仍保持确认语义，但在 progressive 模式统一通过 `browser_call` 派发；
- operation 查询和派发都不改变模型可见的工具集合。

`CORE_TOOLS` / `ADVANCED_TOOLS` 仍保留为 raw compatibility catalog 和 capability 分组来源，不是 DSH 会话中的动态 activation phase。需要多步 JavaScript 组合时，未来可以在同一 registry/executor 之上增加独立的 `browser_js` 模式，但不属于本阶段。

## 4. 激活条件

### 4.1 用户明确浏览器意图

以下请求允许模型加载 Skill：

- “打开当前浏览器里的网页。”
- “操作我已经登录的后台系统。”
- “截取当前页面。”
- “点击当前网页上的按钮。”
- “在浏览器中登录这个网站。”

以下请求不应自动激活浏览器：

- “搜索 OpenAI 最新新闻。”
- “总结这个公开 URL。”
- “解释这段代码。”
- “查一下某个产品的价格。”

模型认为浏览器可能有帮助，不等于用户授权。没有明确浏览器意图时，优先使用 `web_search` 或其他轻量能力。

### 4.2 DSH 激活点

DSH 根据启动时的 `exposureMode` 分两条路径：

```text
exposureMode: progressive
  → plugin apply 时注册固定 facade
  → Skill 只补充工作流说明
  → Skill/result 不注册或注销任何 browser tool

exposureMode: lazy-full
  → tools/result 成功加载 pi-control-chrome Skill
  → exec.agent.ctx.tools.register() 注册完整 44-tool raw catalog
```

progressive 模式仍要求用户明确表达浏览器意图，并建议遵循 Skill 的工作流说明，避免普通任务主动接管当前 Chrome/Edge；但 Skill 不是工具激活门槛，也不是工具 schema 的注册时机。三个核心 facade 工具从第一条请求起存在。

lazy-full 模式同时支持用户显式 Skill invocation：当 `agent/pre-step` 的最终消息中出现 `skill-invocation`，且名称为 `pi-control-chrome` 时，执行当前 Agent 的完整 raw catalog 激活流程。工具注册必须发生在下一次模型请求之前，注册失败时不应发布半完成的激活状态。

### 4.3 Pi 激活点

Pi 使用动态工具 API：

- 默认注册或发现浏览器扩展，但通过 `pi.setActiveTools()` 隐藏浏览器工具；
- `before_agent_start` 验证当前 prompt 中成功展开的 `<skill name="pi-control-chrome">`，然后恢复浏览器工具；
- `tool_result` 仅在成功读取当前系统 Skill 元数据中同一路径的 `skills/pi-control-chrome/SKILL.md` 后恢复浏览器工具；
- `tool_result` 检查成功加载的 Skill 结果作为补充触发点；
- Skill 激活后将现有浏览器工具加入 active tool set；
- 未激活时模型不会在工具列表中看到浏览器工具。

Pi 的扩展也必须在执行层检查激活状态，避免旧工具快照、兼容配置或其他扩展路径绕过 Skill gate。

## 5. Session 生命周期

lazy-full 的 raw 激活状态绑定当前 Agent session，不绑定整个进程；progressive 的固定 facade 绑定 host/plugin 生命周期，task finalize 和 context reset 都不会注销 facade：

```text
lazy-full:
  inactive
    ↓ Skill 成功加载
  active-sticky
    ↓ 普通 turn checkpoint / task finalize / Bridge reconnect
  active-sticky
    ↓ browser_context_reset / session 结束 / session 切换 / Agent disposal
  inactive

progressive:
  fixed-facade
    ↓ capability discovery / browser_call / task finalize / context reset
  fixed-facade
    ↓ plugin dispose
  removed
```

### 激活

- lazy-full 动态注册 raw 工具后，当前 session 可以连续使用浏览器工具；progressive facade 从 host 启动时即可使用。
- 不因为每个 Pi/DSH turn 结束就注销工具或断开 Bridge。
- 不因为 Skill 加载或 facade 注册就自动读取标签页、claim Tab 或打开调试器。

### 普通 turn 结束

- DSH 和 Pi 在宿主 turn/end 事件中执行内部 turn cleanup：关闭未标记 Agent 临时 Tab、release claimed user Tab、detach debugger lease。
- turn cleanup 不停止 Bridge、不清除上下文、不注销 browser tools，也不产生模型可见结果或生命周期 transcript 噪音。
- handoff/deliverable 标记只对当前 turn 生效；下一 turn 需要保留时重新标记。

### 用户明确要求的 task finalize

- 未标记的 Agent 临时 Tab 在普通 turn 结束时由宿主自动关闭，不由模型调用 `browser_cleanup`。
- 只有用户明确要求立即关闭临时 Tab、释放 claim 或清理浏览器任务时，才调用 `browser_cleanup`；progressive 通过 `browser_call` 传入 `arguments.confirmed: true`，lazy-full 可调用直接 raw tool。
- `browser_cleanup` 完成当前 session 的 Tab cleanup 和 DevTools cleanup。
- cleanup 成功后，当前 session 的浏览器工具和健康 Bridge 继续可用。
- 下一次浏览器操作不需要重新加载 Skill。

### 显式 context reset

- `browser_context_reset` 先完成资源 finalize，再清除当前浏览器上下文；progressive 通过 `browser_call` 传入确认参数，lazy-full 隐藏惰性 raw tools，progressive 保留三个核心 facade。
- context reset 失败时保留 recovery state，不报告伪造成功，也不停止共享 Bridge。

### session 结束和 Agent disposal

- DSH 在 `agent/disposed` 时执行最终 cleanup；插件关闭时再次清理仍待处理的 session，并停止 Bridge。
- Pi 在 `session_shutdown`、session switch 或 fork 前执行最终 cleanup，并在 session 边界隐藏浏览器工具。
- cleanup 失败不能阻止宿主 session 结束，但必须保留 recovery state，不能自动切换浏览器 target；工具只有在成功 cleanup 后才被视为完成任务。

## 6. 工具注册实现

### 6.1 DSH

DSH 同时支持 cache-clean progressive facade 和 legacy raw catalog：

```text
exposureMode: progressive
    ↓
plugin apply 时注册固定的三核心 facade：browser_capabilities / browser_call / browser_status
    ↓
Skill 只提供工作流说明
    ↓
browser_capabilities 返回能力摘要或一个 operation schema
    ↓
browser_call 使用固定参数 schema 派发 registry operation
    ↓
tools/change 不因 capability discovery 或 operation dispatch 发生
```

progressive facade 的 operation metadata 和 schema 通过 tool result/message 返回，不进入 `tools` 前缀。`browser_call` 与 raw `browser_*` 工具共享 operation registry 和 executor；未知 operation、过期 API revision 和参数错误均 fail closed。确认型 lifecycle operation 必须通过 `browser_call` 传入 `arguments.confirmed: true`，且只能在用户明确确认后调用。普通 `turn/end` 执行 turn cleanup 但保留三核心 facade；`browser_cleanup` finalize 资源但保留 facade，插件关闭才移除固定工具。

`exposureMode: lazy-full` 时保留原来的 Skill-gated Agent-scoped dynamic registration；`lazyTools: false` 时继续使用完整 raw catalog 的 global registration，确保旧 Profile 和调试流程可用。

### 6.2 Pi

Pi 使用 `pi.registerTool()` 配合 `pi.setActiveTools()`：

- 工具定义可在扩展加载时注册；
- 默认 active set 移除浏览器工具；
- Skill 成功加载后恢复浏览器工具到 active set，并跨 turn 保持；
- 普通 `turn_end` 关闭未标记的 Agent 临时 Tab、release claimed user Tab、detach debugger lease，并保留运行时 active set；
- 成功的 `browser_cleanup` 清理任务资源但保留 active set；
- 成功的 `browser_context_reset`、session 切换、fork、shutdown 才隐藏浏览器工具；
- 执行函数额外验证 session activation state，并记录仍需最终 cleanup 的资源状态。

如果目标 Pi 版本支持工具 disposer，后续可以从 active set 隐藏升级为真正注销；当前实现优先使用官方动态 active-tool API，避免依赖未稳定的私有 registry。

## 7. 不改变的运行时保护

Skill gate 控制 lazy-full raw 工具的可见性；progressive facade 的能力发现不替代底层保护：

- `browserId` 和 `expectedBrowserId` 确认流程不变；
- `BrowserTargetTracker` 仍按 Agent session 隔离；
- Bridge pairing token、loopback binding 和 stale-target rejection 不变；
- Tab claim/release、handoff、deliverable 和 cleanup ownership 不变；
- 用户 Tab 不因为 Skill 激活而自动导航、移动或关闭；
- Bridge 仍只在第一次真实浏览器请求时连接；
- debugger lease、active use/refcount 和 detach race protection 不变。

## 8. 配置与迁移

### DSH progressive Profile 配置

```yaml
control-chrome:
  exposureMode: progressive
  lazyTools: true
```

`progressive` 让 DSH 从启动时固定暴露 facade，按 message/tool result 发现能力，并保证 provider prefix 中的 `tools` 不因浏览器能力查询而变化。包配置的默认值仍是 `exposureMode: lazy-full`，因此需要启用 cache-clean 目录的 Profile 必须显式设置 `progressive`。

### Legacy Profile

旧 Profile 可以显式设置：

```yaml
control-chrome:
  lazyTools: false
```

迁移完成后建议改回 `true`，并让模型通过 `pi-control-chrome` Skill 使用浏览器。

### 兼容诊断

`/chrome status`、`/chrome targets`、`/chrome profile [browserId]`、`/chrome connect`、`/chrome disconnect`、`/chrome doctor`、`/chrome restart`、`/chrome tabs` 等人工命令不受模型 Skill gate 限制。`connect` 复用或启动 Bridge 并等待扩展连接，`disconnect` 只断开当前 DSH 客户端，`restart` 重启 Bridge 并等待扩展恢复。它们仍然是用户主动执行的诊断或生命周期入口，但不能作为模型自动使用浏览器的理由。

## 9. 测试计划

### DSH 单元测试

- lazy-full `lazyTools: true` 时初始 global tool registry 没有完整 `browser_*` schema；
- lazy-full 成功的 `skill({ name: "pi-control-chrome" })` 为当前 Agent 注册完整 44-tool raw catalog；
- progressive mode 从启动时只注册固定 facade，不注册完整 raw catalog；
- progressive Skill 成功、`browser_capabilities` 和 `browser_call` 前后工具集合完全不变；
- capability summary/schema 查询不调用 Bridge，且完整 schema 按单 operation 返回；
- unknown operation、stale API revision 和 invalid arguments 均 fail closed；
- raw tool 与 dispatcher 共用 operation executor；
- 错误的 Skill 名称和失败的 Skill result 不激活 lazy-full 工具；
- 其他 Agent session 看不到已激活 lazy-full Agent 的工具；
- 重复 Skill 加载不重复注册；
- 普通 `turn/end` 自动清理未标记的 Agent 临时 Tab、release claimed user Tab、detach debugger lease，并保留工具或 facade；
- 成功的 `browser_cleanup` 清理资源但保留当前 Agent 工具/facade；
- lazy-full `browser_context_reset` 停用当前 Agent 工具，progressive 保留固定 facade；
- cleanup 失败保留 recovery state，Agent disposal 和 plugin disposal 可重试；
- Agent disposal 清理 activation record 并请求 Bridge cleanup；
- `lazyTools: false` 保持完整 raw 工具集合；
- BrowserTargetTracker 和截图 attachment 测试继续通过。

### Pi 静态和行为测试

- 默认 active tool set 不包含浏览器工具；
- `before_agent_start` 发现 `pi-control-chrome` 后恢复浏览器工具；
- 成功 Skill tool result 可以激活工具；
- 普通搜索任务不会激活浏览器工具；
- 普通 `turn_end` 自动清理未标记的 Agent 临时 Tab、release claimed user Tab、detach debugger lease，并保留 active set；
- 显式 `browser_cleanup` 清理任务资源但保留 active set；
- 显式 `browser_context_reset`、session shutdown 和 switch 隐藏工具并执行最终 cleanup；
- Bridge 未激活前不会连接或请求浏览器状态；
- 旧 tool snapshot 在执行层仍被 active gate 拒绝。

### 真实验收

#### progressive DSH

1. 启动配置了 `exposureMode: progressive` 的 DSH Profile，但不提出浏览器任务，确认初始工具只有三个核心 facade，不包含 44 个 raw schema。
2. 请求普通网页搜索，确认不会因为 facade 的存在而连接当前 Chrome/Edge。
3. 明确要求“使用当前浏览器打开网页”，可加载 `pi-control-chrome` Skill 获取工作流说明；确认 Skill 不改变工具集合。
4. 调用 `browser_capabilities` 返回 group/operation 摘要，再按需请求一个 operation schema。
5. 调用 `browser_call` 执行 status、tabs、snapshot、evaluate 或 screenshot，确认 Bridge 和 debugger lease 正常复用。
6. 在 capability 查询、不同 operation 调用和连续 turn 后检查 provider header，确认没有因为工具目录变化产生新 header，且 cache 继续命中。
7. 结束一个普通 turn，确认未标记的临时 Tab 已关闭、claimed user Tab 已 release、debugger lease 已 detach，且 facade 仍可用于下一轮。
8. 通过 `browser_call` 执行带显式确认的 `browser_cleanup` 和 `browser_context_reset`，确认资源按 ownership 清理且三个核心 facade 保留；失败时确认 recovery state 保留。

#### lazy-full / Pi compatibility

1. 启动默认 lazy-full DSH/Pi，但不提出浏览器任务，确认没有完整 raw `browser_*` catalog。
2. 明确浏览器任务并加载 Skill，确认 lazy-full DSH 下一轮出现完整 44-tool raw catalog；Pi active-tool 行为保持不变。
3. 连续执行 snapshot、evaluate、screenshot，确认 Bridge 和 debugger lease 正常复用。

## 10. 验证与发布

1. 运行 DSH 包的 `check`、单元测试、构建和 pack check。
2. 运行 Pi 的 syntax check、Bridge 测试、activation 测试和 Skill 测试。
3. 验证普通 turn、显式 cleanup、cleanup 失败、Agent disposal、session teardown 和 plugin shutdown 路径。
4. 对 progressive mode 检查固定 facade、capability result、dispatcher operation 和 provider header/cache 不变量。
5. 手动 reload 扩展后进行真实浏览器验收；不自动重启 DSH，不自动操作用户 Tab。
6. 发布时同步实现、测试、README、Skill 文档和 changelog。
