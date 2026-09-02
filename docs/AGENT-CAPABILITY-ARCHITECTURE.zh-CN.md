# Pi/DSH 多 Agent 能力与 Skill 驱动架构设计

> 状态：设计讨论记录，当前用于指导后续架构演进，不等同于已经批准的实现计划。
>
> 本文记录围绕 `pi-control-chrome` 的一次架构头脑风暴：如何在保留现有 Chrome/Edge 控制安全语义的前提下，把浏览器能力继续提供给 Pi、DSH、Codex、Claude Code、Gemini CLI 以及未来的其他 Agent。

## 1. 核心结论

本项目后续不应把自己定位成一组只服务 Pi 的 `browser_*` 工具，而应逐步形成独立的 **Browser Capability Service**。

目标架构的关键词是：

```text
Skill-first
Capability-centered
Runtime-independent
Host-adapted
Policy-enforced
```

具体含义：

- **Skill-first**：Skill 负责告诉 Agent 何时使用什么能力、调用顺序是什么、如何处理失败和交接。
- **Capability-centered**：稳定的能力语义独立于工具名称和宿主 Agent。
- **Runtime-independent**：能力核心不绑定 Pi、DSH、Codex 或某一种浏览器执行协议。
- **Host-adapted**：Pi、DSH、Codex、Claude Code、Gemini CLI 可以使用不同的接入方式。
- **Policy-enforced**：Skill 只能指导模型，真正的权限、围栏、租约和安全检查必须在执行层强制执行。

最重要的取舍是：

> 借鉴 Codex 的可组合 Runtime 和 Skill 工作流，但不把 `node_repl` 或 MCP 变成内部唯一核心；保留结构化原子能力，并通过多个薄适配器向不同 Agent 提供合适的能力投影。

## 2. 背景与问题

当前仓库已经具备相对完整的 Chrome/Edge 控制基础：

```text
Manifest V3 扩展
    ↕
本地 loopback Bridge
    ↕
Pi Extension / DSH browser tools
```

当前能力包括标签页发现与选择、claim/release、页面快照、Accessibility、Locator、DOM/坐标交互、截图、上传下载、剪贴板、Dialog、Console、Network、Runtime.evaluate、原生 CDP、连接恢复和标签页生命周期管理。

当前实现还有几个重要特征：

- Pi 和 DSH 通过 Skill 门控控制模型可见的浏览器工具；
- DSH 默认使用惰性工具加载，Skill 成功加载后才注册完整工具目录；
- Bridge 和模型层已经有 compact response、结果预算、截断标记和页面状态投影；
- tab fence、document incarnation、snapshot ref、connection generation 和 side-effect uncertainty 是现有安全语义的一部分；
- Bridge 默认只监听 loopback，不是远程浏览器控制服务。

未来目标会扩大为：

```text
同一套浏览器能力
    ├── Pi
    ├── DSH
    ├── Codex
    ├── Claude Code
    └── Gemini CLI
```

这会产生新的问题：

1. 不同 Agent 的工具协议和 Skill 机制不同；
2. MCP 虽然便于接入，但一次性暴露大量工具会污染上下文和影响工具选择；
3. Codex 对富交互集成逐步采用自己的 App Server/JSON-RPC 方案，不能把 MCP 当作唯一未来协议；
4. `node_repl` 适合工作流组合，但任意 Node Runtime 会带来安全、生命周期和可观测性问题；
5. Pi 独有能力不能被强行加入 DSH 必须实现的统一接口；
6. 多 Agent 同时访问用户已登录浏览器时，需要会话隔离、目标租约和并发控制。

## 3. 术语与职责边界

| 层 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| **Skill** | 能力选择、调用顺序、工作流、失败处理、交接建议 | 不能承担真正的权限安全 |
| **Capability Contract** | 定义稳定的语义能力、输入输出、错误和版本 | 不绑定某个 Agent 或底层协议 |
| **Host Adapter** | 把 Pi/DSH/MCP/Codex 的调用方式映射到能力契约 | 不实现一套新的浏览器逻辑 |
| **Capability Broker** | 权限、会话、租约、围栏、取消、审计、结果预算 | 不承载 Agent 的业务提示词 |
| **Runtime** | 决定在哪个进程、Profile、容器或远程环境中执行 | 不决定模型该选择什么工具 |
| **Bridge/Extension** | 连接并操作真实 Chrome/Edge | 不直接向所有 Agent 暴露内部对象 |

推荐的调用方向：

```text
用户 / Agent
    ↓
Skill Catalog / Host Tool Registry
    ↓
Pi Native / DSH Native / MCP / Codex Node Adapter
    ↓
稳定 Capability Contract
    ↓
Capability Broker
    ↓
Browser Bridge
    ↓
Chrome/Edge Extension
    ↓
真实浏览器
```

## 4. 目标整体架构

```text
                         ┌──────────────────────┐
                         │       Agent 用户      │
                         └──────────┬───────────┘
                                    │
                         Skill 选择与按需加载
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
   Pi Native Adapter        DSH Native Adapter        External Adapters
                                                            │
                                             ┌──────────────┴──────────────┐
                                             │                             │
                                      MCP Adapter                 Codex Node/Skill
          └─────────────────────────┬─────────────────────────┬───────────┘
                                    │
                         Capability Contract / SDK
                                    │
                         Capability Broker
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
    Session / Lease              Policy                  Event / Resource
    Target / Fence              Approval                 Artifact / Cancel
                                    │
                             Browser Bridge
                                    ↕
                          Chrome/Edge MV3 Extension
```

这不是要求一次性实现所有层，而是要求后续新增能力时不要把某一层误当成全部架构。

## 5. 能力契约：核心能力与可选扩展

### 5.1 不做一个万能接口

不建议设计：

```ts
interface UniversalAdapter {
  a(): Promise<A>;
  b(): Promise<B>;
  c(): Promise<C>;
  // 未来继续增长
}
```

如果 `c` 只有 Pi 支持，DSH 也会被迫修改或实现一个假的方法。

### 5.2 使用稳定核心 + 可选 Capability

建议拆成稳定核心和可选扩展：

```ts
interface CoreCapabilities {
  a(input: AInput): Promise<AResult>;
  b(input: BInput): Promise<BResult>;
}

interface PiExtension {
  c(input: CInput): Promise<CResult>;
}
```

能力集合：

```ts
interface CapabilityProvider {
  list(): Promise<CapabilityDescriptor[]>;
  supports(id: string, version?: string): boolean;
  invoke<T>(id: string, operation: string, input: unknown): Promise<T>;
}
```

Pi 可以声明：

```text
core.a
core.b
pi.c
```

DSH 可以声明：

```text
core.a
core.b
```

DSH 不需要为了 Pi 的 `pi.c` 修改核心实现。

### 5.3 开放式能力 ID

能力 ID 不应使用所有适配器都必须同步修改的封闭枚举：

```ts
// 不推荐：封闭世界
 type CapabilityId = "a" | "b" | "c";
```

建议使用命名空间和开放式 ID：

```text
core.browser.tabs.list
core.browser.page.snapshot
core.browser.page.click
pi.special.c
dsh.debug.raw-cdp
```

添加新的能力时：

- 能力目录可以增加新的 ID；
- 支持该能力的宿主注册它；
- 不支持的宿主忽略它；
- Workflow 在执行前检查依赖；
- 不支持时返回明确的 `UNSUPPORTED_CAPABILITY`，而不是运行到中途才出现未定义方法错误。

统一层需要支持的是“如何发现和调用能力”，而不是预先列完所有能力。

### 5.4 何时进入共享层

按以下规则判断：

| 能力性质 | 归属 |
| --- | --- |
| 所有宿主最终都需要的插件核心能力 | 共享 Core Contract |
| 当前只有 Pi 能实现，但其他宿主未来可能支持 | 可选 Capability |
| 依赖 Pi 特有 Agent Loop 或会话机制 | Pi Extension |
| 只影响 DSH UI、Bridge 或浏览器连接 | DSH Extension |
| 仅用于开发者排障 | Debug/Admin API，不进入普通模型能力 |

一旦某个私有能力被用户稳定调用，它就已经成为公开 API，需要版本、文档、权限和兼容承诺。

## 6. Skill 驱动模型

### 6.1 Skill 负责控制，不负责执行

Skill 是模型侧的控制层，回答：

- 什么时候使用浏览器能力；
- 先做什么、后做什么；
- 哪个能力适合当前任务；
- 如何处理标签页、快照和引用；
- 什么时候应该交给用户；
- 读取结果应该如何裁剪。

Skill 不能替代：

- Broker 的权限判断；
- tab fence 和 document incarnation 校验；
- 文件路径检查；
- 副作用确认；
- 取消和重连；
- 敏感信息脱敏。

原则是：

```text
Skill 负责指导
Capability Contract 负责描述
Broker 负责强制
Runtime 负责执行
```

### 6.2 按任务拆分 Skill

不建议提供一个包含所有浏览器和桌面能力的巨大 Skill。可以按任务拆分：

```text
browser.read-page
browser.interact-page
browser.diagnose-page
browser.handoff
browser.computer-use
```

例如 `browser.read-page` 只依赖：

```text
browser.tabs.list
browser.page.snapshot
browser.page.extract
browser.page.wait
```

`browser.diagnose-page` 才需要：

```text
browser.console
browser.network
browser.cdp
```

### 6.3 Skill Manifest

未来可以为 Skill 增加宿主无关的 Manifest：

```json
{
  "id": "browser.read-page",
  "version": "1.0.0",
  "description": "读取用户明确指定的 Chrome/Edge 页面",
  "requires": [
    "core.browser.tabs.list",
    "core.browser.page.snapshot",
    "core.browser.page.extract"
  ],
  "profiles": [
    "readonly"
  ],
  "sideEffects": false,
  "entrypoints": {
    "pi": "native",
    "dsh": "native",
    "codex": "node",
    "claude": "mcp",
    "gemini": "mcp"
  }
}
```

Manifest 中的 `requires` 用于能力预检，不代表每个宿主都必须实现所有能力。

### 6.4 Skill 的宿主绑定

同一个概念 Skill 可以使用不同的宿主调用方式：

```text
browser.read-page Skill
        ↓
┌─────────────────────────────────────┐
│ Pi       → 原生 SDK / Native Tools   │
│ DSH      → browser_*                 │
│ Codex    → node_repl + JS Client     │
│ Claude   → MCP Tools                 │
│ Gemini   → MCP / Extension           │
└─────────────────────────────────────┘
```

Skill 不应硬编码某个宿主的底层工具名称，而应引用稳定的能力 ID，由 Adapter 完成映射。

## 7. 工具暴露分层

内部能力可以很多，但不应该把全部能力原样暴露给每个 Agent。

### 7.1 Read Profile

默认推荐暴露：

```text
browser_tabs_list
browser_tab_snapshot
browser_page_extract
browser_page_wait
browser_screenshot
```

用于读取、分析、搜索和总结页面。

### 7.2 Interactive Profile

在 Read Profile 上增加：

```text
browser_click
browser_fill
browser_type
browser_press_key
browser_scroll
```

### 7.3 Privileged / Debug Profile

显式启用后才暴露：

```text
browser_upload
browser_download
browser_evaluate
browser_cua
browser_network
browser_console
browser_cdp
```

`browser_cdp`、页面 JavaScript 和 Network Response Body 应被视为高级或逃生舱能力，不应成为普通 Skill 的默认依赖。

### 7.4 高级 Workflow

常见的多步流程可以提供高层 API：

```text
browser.read-current-tab
browser.find-tab-and-extract
browser.inspect-page
```

复杂或动态的任务可以进入受控 Workflow Runtime，但 Workflow 仍然只能调用 Capability Broker 提供的能力。

## 8. MCP 的定位

MCP 仍然有价值，但应定位为：

```text
外部兼容适配器
```

而不是：

```text
项目内部唯一协议
```

### 8.1 MCP 适合的能力

MCP 适合暴露：

- 只读标签页列表；
- 页面快照；
- 页面文本提取；
- 截图；
- 低风险、一次性的结构化查询。

### 8.2 MCP 不适合独自承载的能力

以下语义不应被 MCP 的简单 `tools/call` 模型限制住：

- 长时间 Computer Use；
- 多步浏览器会话；
- 用户审批和交接；
- 标签页租约；
- 中途取消；
- 进度事件；
- 多 Agent 并发控制；
- 截图、快照、差异和 Artifact 的连续流转。

这些语义应先在内部 Capability Broker / RPC 模型中表达，再根据 MCP 客户端能力做投影。

### 8.3 MCP 工具目录控制

不建议让一个 MCP Server 一次暴露当前全部底层工具。建议采用：

```text
browser-mcp-readonly
browser-mcp-interactive
browser-mcp-privileged
browser-mcp-debug
```

或者在 Server 启动时选择 Profile：

```bash
browser-mcp --profile=readonly
browser-mcp --profile=interactive
```

优先使用启动时固定的工具集合，而不是每个请求动态增删大量工具，避免工具列表变化造成缓存失效、会话状态不一致和权限边界模糊。

模型看到的 MCP 工具数量应明显少于内部能力数量。

## 9. Codex、Claude Code、Gemini CLI 的接入策略

### 9.1 Pi

优先提供：

```text
原生 Capability SDK
+ Skill
+ 可选 Workflow Runtime
```

Pi 可以获得最丰富的组合能力和状态反馈。

### 9.2 DSH

继续提供：

```text
结构化 browser_* 工具
+ DSH Skill
+ 完整事件和安全围栏
```

DSH 不应该为了迁就 MCP 而丢失现有的 tab fence、document incarnation、清理、交接和副作用不确定性语义。

### 9.3 Claude Code 和 Gemini CLI

优先通过：

```text
MCP Read Profile
MCP Interactive Profile
```

接入外部浏览器能力。Claude Code 的按需工具发现和 Gemini CLI 的工具白名单/策略机制可以帮助降低工具目录污染，但 Server 侧仍必须主动裁剪工具集合。

### 9.4 Codex

准备两种入口：

```text
MCP 兼容入口
+
Codex Skill / Node Client 入口
```

`browser-client.mjs` 可以成为 Codex `node_repl` 的客户端，但它必须调用同一个 Capability Broker，不能重新实现浏览器连接、标签页 ownership 和页面围栏。

Codex App Server 主要解决“外部应用如何深度集成 Codex Agent”这一方向，不应直接当成我们浏览器能力的唯一传输协议。

## 10. Workflow Runtime

### 10.1 为什么需要 Workflow

原子工具适合单步、可验证和高风险操作；Workflow 适合：

- 多个依赖动作；
- 本地筛选和数据转换；
- 批量读取；
- 需要减少模型往返的流程；
- 将页面结果裁剪成小摘要。

### 10.2 不做裸 Node REPL

不建议直接暴露：

```js
require("fs");
fetch("任意地址");
调用任意系统进程;
```

建议使用受限 Runtime：

```text
Workflow JS
    ↓
受控 Browser SDK
    ↓
Capability Broker
    ↓
Bridge / Extension
```

允许 JS 做：

- 调用已授权的能力；
- 组合多个读取动作；
- 循环和条件判断；
- 过滤和聚合结果；
- 返回结构化摘要。

不允许 JS 绕过：

- 权限；
- target lease；
- tab fence；
- document incarnation；
- 文件和网络策略；
- 高风险操作审批。

### 10.3 Workflow 必须可观测

Workflow 不能成为黑盒。应产生嵌套步骤事件：

```text
workflow.started
  ├── browser.tabs.list.started
  ├── browser.tabs.list.completed
  ├── browser.page.snapshot.started
  ├── browser.page.snapshot.completed
  └── workflow.completed
```

外部 Agent 可以只收到最终摘要，但 Broker 和 DSH 必须保留完整步骤状态，以支持取消、失败定位、审计和回放。

## 11. 会话、租约和多 Agent 安全

当多个 Agent 都可以访问用户浏览器时，不能依赖“当前活动标签页”或全局隐式状态。

每次能力调用至少应绑定：

```text
clientId
sessionId
pluginId
browserId
targetId
leaseId
tabFence
documentIncarnation
```

建议规则：

- 一个 Agent session 默认绑定一个浏览器目标；
- 同一 Tab 同时只能由一个控制会话持有写租约；
- 只读操作也应验证目标和文档身份；
- 页面导航会使旧 snapshot ref、DOM ref、dialog 和 Network loader 映射失效；
- 连接断开后不能自动把请求转移到另一个 Profile；
- 有副作用的操作结果不确定时不能自动重放；
- 不支持的能力应在工作流开始前预检；
- 普通用户标签页不应默认对所有本地 Agent 全量开放。

现有的 `tabFence`、`incarnation`、ownership、connection generation 和 cleanup 机制应作为未来多 Agent 服务的基础，而不是被新协议绕过。

## 12. 结果、Token 和资源策略

### 12.1 工具定义

不要让每个 Agent 都看到完整内部工具目录。采用：

```text
内部 Capability Registry
    ↓
宿主 / Profile / 权限过滤
    ↓
模型可见工具
```

Skill 采用按需加载和渐进披露，MCP 采用 Profile 或工具白名单。

### 12.2 工具结果

结果应在靠近数据源的位置压缩：

```text
Browser / Extension
    ↓ 源头字段和预算限制
Bridge compact response
    ↓ 模型投影
Agent context
```

大结果使用：

- 字符和节点预算；
- `truncated` 标记；
- full/diff/unchanged；
- Resource 或 Artifact 引用；
- 摘要 + 按需详情。

UI 折叠只减少视觉噪声；只有模型上下文中的结果真正被裁剪，才会减少 Token。

## 13. 版本和适配器演进

统一层的目标不是让所有变化消失，而是把变化限制在正确的位置。

### 13.1 底层实现变化

```text
CDP → 浏览器扩展 → Playwright
```

只要语义契约不变，通常只改底层实现或对应 Adapter。

### 13.2 宿主变化

```text
Pi Tool API 变化
DSH Tool API 变化
MCP Client 行为变化
```

只改对应 Host Adapter，不影响 Capability Core。

### 13.3 语义变化

如果 `snapshot`、引用生命周期或操作结果语义真正改变，应通过：

- 新版本能力；
- 可选字段；
- Feature Negotiation；
- 明确的弃用周期；
- Contract Tests；

处理，而不是在 Adapter 中静默改变行为。

### 13.4 不让 Adapter 变成瓶颈

适配器应当是：

```text
薄翻译层 + 策略接入层
```

不应是：

```text
所有业务逻辑和所有插件能力的集中实现
```

按能力拆分 Adapter：

```text
BrowserTabsAdapter
BrowserPageAdapter
BrowserInputAdapter
ComputerWindowAdapter
ComputerInputAdapter
```

不要创建一个包含所有领域的 `UniversalAdapter`。

## 14. 推荐的包和目录方向

这是未来可考虑的逻辑拆分，不要求一次性迁移：

```text
browser-capabilities-core/
├── contracts/
├── schemas/
├── errors/
├── session/
└── workflow/

browser-bridge/
├── bridge server
├── target registry
├── session and lease manager
├── policy broker
└── Chrome/Edge extension protocol

browser-mcp/
└── MCP compatibility adapter

browser-node-client/
└── Codex node_repl / JS SDK adapter

pi-control-chrome/
└── Pi Skill and native adapter

dsh-tool-control-chrome/
└── DSH Skill and native browser tools
```

当前仓库可以继续保留现有目录和发布包，先通过稳定的内部边界逐步抽取，而不需要立即拆分 npm 包。

## 15. 分阶段路线

### 阶段 0：保持现状并记录契约

- 保留当前 Bridge、扩展、Pi 和 DSH 行为；
- 把现有 tab handle、snapshot、错误和生命周期语义视为稳定基线；
- 不为了抽象而改变当前安全 fencing。

### 阶段 1：Capability Contract

- 为标签页、页面读取、页面交互定义稳定语义接口；
- 区分核心能力、可选能力和宿主私有能力；
- 增加开放式能力 ID、版本和 `supports`/预检机制；
- 为 A/B 与未来 Pi-only C 写出契约测试。

### 阶段 2：Skill Manifest 和按需加载

- 将 Skill 拆分为 read、interact、diagnose、handoff 等任务能力；
- 为 Skill 声明 `requires`、Profile、风险和副作用；
- 让宿主根据支持能力决定是否加载 Skill；
- 保持 DSH 当前的 `lazyTools` 和 compact response 机制。

### 阶段 3：共享 SDK / Native Adapter

- 在不改变底层浏览器实现的前提下抽出 SDK；
- Pi 和 DSH 分别提供薄 Adapter；
- 统一错误、结果、会话和事件语义。

### 阶段 4：只读 MCP 兼容层

- 先暴露 `Read Profile`；
- 只提供少量稳定工具；
- 大结果使用有界输出和 Resource/Artifact；
- 在 Claude Code、Gemini CLI 和 Codex 兼容模式下做真实任务验收。

### 阶段 5：Codex Node/Skill Client

- 在 Codex 接入点稳定后提供 `browser-client.mjs`；
- Node Client 只调用统一 Broker；
- 先支持只读组合工作流，再考虑交互动作。

### 阶段 6：受控 Workflow Runtime

- 提供只读优先的 JS Workflow；
- 增加步骤事件、取消、超时和结果预算；
- 有副作用的调用继续经过统一策略和文档身份检查。

### 阶段 7：多 Agent 与远程 Runtime

- 增加 client/session/lease 隔离；
- 处理多 Agent 并发控制；
- 在确认权限模型后，再考虑非 loopback 或远程 Runtime；
- 不因支持外部 Agent 而默认扩大用户浏览器的暴露面。

## 16. 验收指标

后续不要只看“能否调用工具”，还应比较：

### 模型使用效果

- 模型可见工具数量；
- 工具选择错误率；
- 单任务工具往返次数；
- 模型上下文 Token；
- 页面读取结果大小；
- 多步任务成功率。

### 工程效率

- 新增一个 Agent 宿主需要修改多少核心代码；
- 新增一个插件能力需要修改多少 Adapter；
- 底层 Bridge 改动是否影响 Pi、DSH 和外部客户端；
- 是否可以使用同一套 Contract Tests 验证多个宿主。

### 安全和可靠性

- 未授权能力是否会被发现或调用；
- 页面导航后旧引用是否 fail closed；
- 多 Agent 是否会误操作同一目标；
- 副作用不确定时是否会被错误重放；
- Bridge 断线和 Runtime 重启后是否能明确恢复或失败；
- 大结果是否会突破模型上下文预算。

## 17. 非目标

当前不做以下事情：

- 不把所有 `browser_*` 工具直接原样暴露给所有 Agent；
- 不把 MCP 当作内部唯一协议；
- 不把 Codex App Server 当成浏览器能力协议；
- 不开放无约束的 Node.js；
- 不让 Skill 充当真正的安全边界；
- 不为了统一而强迫 DSH 实现 Pi 私有能力；
- 不复制多套 Chrome/Edge 控制逻辑；
- 不在尚未解决本地权限和会话隔离前开放远程 Bridge；
- 不为了增加抽象而破坏现有的 tab fence、document incarnation、ownership 和 cleanup 语义。

## 18. 决策摘要

```text
Skill：决定怎么用能力
Capability Contract：定义能力是什么
Host Adapter：适配 Pi/DSH/MCP/Codex
Capability Broker：决定是否允许并保证安全
Runtime：决定在哪里执行
Bridge/Extension：操作真实浏览器
```

最终建议：

> **将 `pi-control-chrome` 演进为独立的 Browser Capability Service。Pi 和 DSH 继续使用原生能力，Claude Code 和 Gemini CLI 通过精选 MCP 兼容层接入，Codex 通过 MCP 兼容和 Node/Skill 入口接入。MCP 是外部适配器，Skill 是模型控制层，Capability Broker 才是跨宿主共享的执行安全边界。**

## 19. 调研参考

以下资料用于形成本文的设计背景，外部产品行为可能继续变化：

- [OpenAI：Unlocking the Codex harness: how we built the App Server](https://openai.com/zh-Hans-CN/index/unlocking-the-codex-harness/)
- [OpenAI：Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)
- [Gemini CLI 工具参考](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/tools.md)
- [Gemini CLI Policy Engine](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md)
- [OpenHands Tool System](https://docs.openhands.dev/sdk/arch/tool-system)
- [SWE-agent 架构](https://swe-agent.com/0.7/background/architecture/)
- [Playwright MCP](https://github.com/microsoft/playwright.dev/blob/main/mcp/introduction.mdx)
