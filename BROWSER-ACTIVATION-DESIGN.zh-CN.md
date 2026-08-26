# 浏览器能力按 Skill 显式激活与任务清理方案

本文档定义 Pi 和 DSH 浏览器工具的激活、普通 turn checkpoint、显式任务 finalize、context reset、Agent disposal 和插件关闭语义。详细的 Codex 对齐实施方案见 [`docs/BROWSER-LIFECYCLE-CODEX-ALIGNED.zh-CN.md`](./docs/BROWSER-LIFECYCLE-CODEX-ALIGNED.zh-CN.md)。

## 1. 背景

`pi-control-chrome` 和 `dsh-tool-control-chrome` 使用惰性 Bridge 连接。Pi 扩展静态注册浏览器工具但默认从 active set 隐藏，DSH 默认 `lazyTools: true` 时只暴露 Skill 元数据；Skill 成功加载后才向当前 Agent 提供 39 个 `browser_*` 工具。Bridge 不一定立即连接，模型也不应在用户没有明确要求浏览器时主动使用当前浏览器。

浏览器控制应当与普通搜索和普通推理区分开。它会访问用户当前 Chrome/Edge Profile、登录态、标签页和页面数据，也会带来较高的上下文和运行时成本。

参考腾讯 BrowserSkill 的实现后，本项目采用“Skill 成功加载后动态开放原生工具”的方向，而不是把浏览器操作改成 Skill CLI。

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
默认只暴露 pi-control-chrome Skill 的名称和描述
    ↓
用户明确表达浏览器意图
    ↓
模型成功加载 pi-control-chrome Skill
    ↓
当前 Agent session 动态注册或启用 browser_* 工具
    ↓
第一次真实浏览器工具调用时才连接 Bridge
    ↓
同一个 Agent session 内连续复用浏览器能力
     ↓
普通 turn 结束执行 Codex-style turn cleanup：关闭未标记 Agent 临时 Tab、release claimed user Tab、detach debugger lease，不停止 Bridge
     ↓
用户明确要求 browser_cleanup 时立即 finalize 当前任务资源并保留工具激活
     ↓
显式 browser_context_reset 才停用当前上下文工具
     ↓
session 结束或 Agent disposal 时执行最终 cleanup
```

核心规则：

> Skill 负责显式激活和使用指导，tool-control-chrome 负责原生浏览器运行时；用户没有明确要求浏览器时，模型不应该因为发现了工具就自动接管当前浏览器。

## 3. 核心决策

### 3.1 继续使用可选 Profile 插件

`tool-control-chrome` 不进入 DSH 核心仓库：

- DSH Profile 可选安装 `@lyd123qw2008/dsh-tool-control-chrome`。
- Pi 继续通过 `pi-control-chrome` package 提供扩展和 Skill。
- Bridge、Manifest V3 extension、BrowserTargetTracker、Browser identity 和 ownership 协议保持不变。
- 插件加载不代表已经连接浏览器，也不代表当前 Agent 已获得浏览器工具。

### 3.2 默认 `lazyTools: true`

DSH 插件新增 `lazyTools` 配置：

```yaml
control-chrome:
  lazyTools: true
```

默认值为 `true`：

- 插件加载时不注册完整 `browser_*` 工具。
- Skill 成功加载后，工具注册到当前 Agent scope。
- 第一次真实浏览器工具调用时才建立 Bridge WebSocket。

兼容模式：

```yaml
control-chrome:
  lazyTools: false
```

`false` 保留旧行为：插件加载时直接注册完整工具集合，适合调试、迁移和暂时不使用 Skill 的旧 Profile。兼容模式仍保留 Bridge 的惰性连接和 BrowserTargetTracker 保护。

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
- 告知模型 Skill 加载成功后才能使用 `browser_*` 工具。

### 3.4 第一阶段不拆 Core/Advanced

第一阶段只实现一个 Skill gate：

- Skill 未激活：隐藏完整浏览器工具集合；
- Skill 已激活：动态开放当前完整的 39 个浏览器工具，并在当前 Agent/session 后续 turn 保持激活；
- 不在第一阶段增加 `browser_activate` 或 `browser_enable_advanced` 模型工具；
- 不要求模型使用 CLI 替代原生工具。

后续阶段再考虑将 `evaluate`、`cdp`、`network`、`upload/download` 等工具拆成高级 Skill 或高级工具层。

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

DSH 监听浏览器 Skill 的成功加载：

```text
tools/result
  exec.name === "skill"
  exec.arguments.name === "pi-control-chrome"
  result.isError === false
```

确认成功后，使用 `exec.agent.ctx.tools.register()` 将完整工具集合注册到当前 Agent scope。

同时支持用户显式 Skill invocation：当 `agent/pre-step` 的最终消息中出现 `skill-invocation`，且名称为 `pi-control-chrome` 时，执行相同的当前 Agent 激活流程。DSH 会先完成当前 step 的工具 assembly，再进入 `agent/pre-step`，因此这条路径影响下一次模型请求，不承诺让首次 Skill 注入所在的请求立即出现浏览器 schema。

工具注册必须发生在下一次模型请求之前。工具注册失败时不应发布半完成的激活状态。

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

激活状态绑定当前 Agent session，不绑定整个进程；task finalize 不会停用工具：

```text
inactive
  ↓ Skill 成功加载
active-sticky
  ↓ 普通 turn checkpoint / task finalize / Bridge reconnect
active-sticky
  ↓ browser_context_reset / session 结束 / session 切换 / Agent disposal
inactive
```

### 激活

- 动态注册或启用工具后，当前 session 可以连续使用浏览器工具。
- 不因为每个 Pi/DSH turn 结束就注销工具或断开 Bridge。
- 不因为激活就自动读取标签页、claim Tab 或打开调试器。

### 普通 turn 结束

- DSH 和 Pi 在宿主 turn/end 事件中执行内部 turn cleanup：关闭未标记 Agent 临时 Tab、release claimed user Tab、detach debugger lease。
- turn cleanup 不停止 Bridge、不清除上下文、不注销 browser tools，也不产生模型可见结果或生命周期 transcript 噪音。
- handoff/deliverable 标记只对当前 turn 生效；下一 turn 需要保留时重新标记。

### 用户明确要求的 task finalize

- 未标记的 Agent 临时 Tab 在普通 turn 结束时由宿主自动关闭，不由模型调用 `browser_cleanup`。
- 只有用户明确要求立即关闭临时 Tab、释放 claim 或清理浏览器任务时，才调用 `browser_cleanup`。
- `browser_cleanup` 完成当前 session 的 Tab cleanup 和 DevTools cleanup。
- cleanup 成功后，当前 session 的浏览器工具和健康 Bridge 继续可用。
- 下一次浏览器操作不需要重新加载 Skill。

### 显式 context reset

- `browser_context_reset` 先完成资源 finalize，再清除当前浏览器上下文并隐藏惰性 browser tools。
- context reset 失败时保留 recovery state，不报告伪造成功，也不停止共享 Bridge。

### session 结束和 Agent disposal

- DSH 在 `agent/disposed` 时执行最终 cleanup；插件关闭时再次清理仍待处理的 session，并停止 Bridge。
- Pi 在 `session_shutdown`、session switch 或 fork 前执行最终 cleanup，并在 session 边界隐藏浏览器工具。
- cleanup 失败不能阻止宿主 session 结束，但必须保留 recovery state，不能自动切换浏览器 target；工具只有在成功 cleanup 后才被视为完成任务。

## 6. 工具注册实现

### 6.1 DSH

DSH 采用真正的 Agent-scoped dynamic registration：

```text
lazyTools: true
    ↓
仅注册 `pi-control-chrome` Skill 元数据和 Skill 成功结果观察器
    ↓
Skill 成功加载
    ↓
agent.ctx.tools.register(browserTool)
    ↓
tools/change
    ↓
下一次模型 assembly 出现 browser_* schema
```

工具 disposer 保存到当前 Agent 的 activation record。激活失败时按逆序释放已经注册的工具，不留下部分工具集合。普通 `turn/end` 执行 turn cleanup 但保留当前 Agent 的 browser tools；`browser_cleanup` finalize 资源但保留当前 Agent 的 browser tools，`browser_context_reset`、Agent disposal 和插件关闭才调用 disposers。所有 cleanup 按 session 隔离、幂等、可重试，失败时保留可恢复状态。

`lazyTools: false` 时直接使用原来的 global registration，确保旧 Profile 和调试流程可用。

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

Skill gate 只控制模型工具的可见性，不替代底层保护：

- `browserId` 和 `expectedBrowserId` 确认流程不变；
- `BrowserTargetTracker` 仍按 Agent session 隔离；
- Bridge pairing token、loopback binding 和 stale-target rejection 不变；
- Tab claim/release、handoff、deliverable 和 cleanup ownership 不变；
- 用户 Tab 不因为 Skill 激活而自动导航、移动或关闭；
- Bridge 仍只在第一次真实浏览器请求时连接；
- debugger lease、active use/refcount 和 detach race protection 不变。

## 8. 配置与迁移

### 新 Profile 默认值

```yaml
control-chrome:
  lazyTools: true
```

### 旧 Profile

旧 Profile 可以显式设置：

```yaml
control-chrome:
  lazyTools: false
```

迁移完成后建议改回 `true`，并让模型通过 `pi-control-chrome` Skill 使用浏览器。

### 兼容诊断

`/chrome status`、`/chrome connect`、`/chrome disconnect`、`/chrome doctor`、`/chrome restart`、`/chrome tabs` 等人工命令不受模型 Skill gate 限制。`connect` 复用或启动 Bridge 并等待扩展连接，`disconnect` 只断开当前 DSH 客户端，`restart` 重启 Bridge 并等待扩展恢复。它们仍然是用户主动执行的诊断或生命周期入口，但不能作为模型自动使用浏览器的理由。

## 9. 测试计划

### DSH 单元测试

- `lazyTools: true` 时初始 global tool registry 没有完整 `browser_*` schema；
- 成功的 `skill({ name: "pi-control-chrome" })` 为当前 Agent 注册完整工具；
- 错误的 Skill 名称和失败的 Skill result 不激活工具；
- 其他 Agent session 看不到已激活 Agent 的工具；
- 重复 Skill 加载不重复注册；
- 普通 `turn/end` 自动清理未标记的 Agent 临时 Tab、release claimed user Tab、detach debugger lease，并保留工具；
- 成功的 `browser_cleanup` 清理资源但保留当前 Agent 工具；
- 成功的 `browser_context_reset` 清理资源并停用当前 Agent 工具；
- cleanup 失败保留 recovery state，Agent disposal 和 plugin disposal 可重试；
- Agent disposal 清理 activation record 并请求 Bridge cleanup；
- `lazyTools: false` 保持完整工具集合；
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

1. 启动 DSH/Pi，但不提出浏览器任务，确认模型工具列表没有 `browser_*`。
2. 请求普通网页搜索，确认使用搜索能力，不打开当前 Chrome/Edge。
3. 明确要求“使用当前浏览器打开网页”，确认模型先加载 `pi-control-chrome` Skill。
4. 确认 Skill 成功后下一轮才出现完整浏览器工具。
5. 连续执行 snapshot、evaluate、screenshot，确认 Bridge 和 debugger lease 正常复用。
6. 结束一个普通 turn，确认未标记的临时 Tab 已关闭、claimed user Tab 已 release、debugger lease 已 detach，且 browser tools 仍可用于下一轮。
7. 执行显式 `browser_cleanup`，确认任务资源按 ownership 清理、工具和 Bridge 仍可用。
8. 执行显式 `browser_context_reset`，确认资源清理后工具隐藏；失败时确认 recovery state 保留。

## 10. 验证与发布

1. 运行 DSH 包的 `check`、单元测试、构建和 pack check。
2. 运行 Pi 的 syntax check、Bridge 测试、activation 测试和 Skill 测试。
3. 验证普通 turn、显式 cleanup、cleanup 失败、Agent disposal、session teardown 和 plugin shutdown 路径。
4. 手动 reload 扩展后进行真实浏览器验收；不自动重启 DSH，不自动操作用户 Tab。
5. 发布时同步实现、测试、README、Skill 文档和 changelog。
