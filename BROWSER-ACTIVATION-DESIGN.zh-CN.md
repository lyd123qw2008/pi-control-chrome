# 浏览器能力按 Skill 显式激活改造方案

状态：设计已确认，代码实施中。

## 1. 背景

`pi-control-chrome` 和 `dsh-tool-control-chrome` 当前已经使用惰性 Bridge 连接，但插件加载时就注册完整的 `browser_*` 工具集合。Bridge 不一定立即连接，模型却已经能够看到 38 个浏览器工具，因此可能在用户没有明确要求浏览器时主动使用当前浏览器。

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
session 结束或显式 cleanup 时注销工具并清理资源
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
- Skill 已激活：动态开放当前完整的 38 个浏览器工具；
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

激活状态绑定当前 Agent session，不绑定整个进程：

```text
inactive
  ↓ Skill 成功加载
active
  ↓ 普通 turn 继续
active
  ↓ browser_cleanup / session 结束 / session 切换
inactive
```

### 激活

- 动态注册或启用工具后，当前 session 可以连续使用浏览器工具。
- 不因为每个 Pi/DSH turn 结束就注销工具或断开 Bridge。
- 不因为激活就自动读取标签页、claim Tab 或打开调试器。

### 普通 turn 结束

- Pi 当前 `turn_end` cleanup 可以释放临时 Tab 和 claim，但不注销 Skill 激活状态。
- 显式浏览器 session 复用能力保持不变。
- debugger lease 继续遵循现有短时复用和显式 DevTools 持久化规则。

### 显式 cleanup

- `browser_cleanup` 完成当前 session 的 Tab cleanup 和 DevTools cleanup。
- cleanup 成功后，当前 session 的浏览器工具注销或隐藏。
- 下一次浏览器任务需要重新加载 Skill。

### session 结束

- DSH 在 `agent/disposed` 时清理当前 session。
- Pi 在 `session_shutdown`、session switch 或 fork 前清理当前 session。
- cleanup 失败不能阻止宿主 session 结束，但必须保持 fail-closed，不得自动切换浏览器目标。

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

工具 disposer 保存到当前 session 的 activation record。激活失败时按逆序释放已经注册的工具，不留下部分工具集合。

`lazyTools: false` 时直接使用原来的 global registration，确保旧 Profile 和调试流程可用。

### 6.2 Pi

Pi 使用 `pi.registerTool()` 配合 `pi.setActiveTools()`：

- 工具定义可在扩展加载时注册；
- 默认 active set 移除浏览器工具；
- Skill 成功加载后恢复浏览器工具到 active set；
- session 切换和结束时移除浏览器工具；
- 执行函数额外验证 session activation state。

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

`/chrome status`、`/chrome doctor`、`/chrome tabs` 等人工命令不受模型 Skill gate 限制。它们仍然是用户主动执行的诊断入口，但不能作为模型自动使用浏览器的理由。

## 9. 测试计划

### DSH 单元测试

- `lazyTools: true` 时初始 global tool registry 没有完整 `browser_*` schema；
- 成功的 `skill({ name: "pi-control-chrome" })` 为当前 Agent 注册完整工具；
- 错误的 Skill 名称和失败的 Skill result 不激活工具；
- 其他 Agent session 看不到已激活 Agent 的工具；
- 重复 Skill 加载不重复注册；
- agent disposal 清理 activation record 并请求 Bridge cleanup；
- `lazyTools: false` 保持完整工具集合；
- BrowserTargetTracker 和截图 attachment 测试继续通过。

### Pi 静态和行为测试

- 默认 active tool set 不包含浏览器工具；
- `before_agent_start` 发现 `pi-control-chrome` 后恢复浏览器工具；
- 成功 Skill tool result 可以激活工具；
- 普通搜索任务不会激活浏览器工具；
- session shutdown 和 switch 隐藏工具并执行 cleanup；
- Bridge 未激活前不会连接或请求浏览器状态。

### 真实验收

1. 启动 DSH/Pi，但不提出浏览器任务，确认模型工具列表没有 `browser_*`。
2. 请求普通网页搜索，确认使用搜索能力，不打开当前 Chrome/Edge。
3. 明确要求“使用当前浏览器打开网页”，确认模型先加载 `pi-control-chrome` Skill。
4. 确认 Skill 成功后下一轮才出现完整浏览器工具。
5. 连续执行 snapshot、evaluate、screenshot，确认 Bridge 和 debugger lease 正常复用。
6. 执行 cleanup 或结束 session，确认工具不可见、Tab ownership 和 DevTools 状态清理。

## 10. 实施顺序

1. 先更新本方案和 Skill 文档，固定 Skill 名称、`lazyTools` 默认值、激活事件和 session 语义。
2. DSH 增加 `lazyTools` 配置和 Skill 成功加载监听，实现 Agent-scoped registration。
3. Pi 增加 active-tool gate、Skill 检测和 session cleanup。
4. 更新 DSH/Pi 测试和 README，加入模型上下文成本说明。
5. 运行包级检查、协议测试、Skill 流程测试和静态检查。
6. 手动 reload 扩展后再做真实浏览器验收；不自动重启 DSH，不自动操作用户 Tab。
