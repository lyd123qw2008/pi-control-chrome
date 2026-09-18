# 浏览器渐进式暴露 API 方案（Cache-clean）

> 状态：**已在 `feat/browser-progressive-exposure` worktree 实现，待最终验收**  
> 目标：在不改变会话 `tools` 前缀的前提下，让浏览器能力按需、逐级可发现。  
> 影响范围：`dsh-tool-control-chrome` host adapter；共享 Bridge、MV3 扩展协议和站点 Skill 的能力边界保持不变。

## 1. 一页结论

当前浏览器工具是两阶段 lazy loading：

```text
普通会话                 0 个 browser_* 工具
加载 pi-control-chrome  44 个 browser_* 工具一次性加入当前 Agent
```

源码虽然已经有 `CORE_TOOLS` / `ADVANCED_TOOLS` 两个数组，但
`registerFor()` 当前会把两组一起注册，因此并不是逐渐式暴露。

本方案的最终目标不是把 `CORE_TOOLS` 拆成更多次动态注册，而是：

```text
会话开始时固定注册少量 facade 工具
        │
        ├─ browser_capabilities：发现能力组和某个 operation 的 schema
        └─ browser_call：用固定 schema 派发已发现的 operation

能力说明、完整参数 schema、operation 结果
        └─ 通过 tool result / message 返回，不修改 tools 数组
```

核心不变量：

> **从第一条请求到会话结束，模型可见的工具定义集合保持不变。**

这使方案适用于当前 DSH provider prefix cache：中途发现能力不会触发工具目录变化，也不会触发完整 prefix 重算。

### 1.1 与 Codex `control-chrome/node_repl` 的关系

本方案采用 Codex `node_repl` 的 cache-safe 核心思路，但先实现为结构化、受控的 operation facade：

| Codex | 本方案 |
|---|---|
| 固定 `mcp__node_repl__js` 入口 | 固定 `browser_call` 入口 |
| `browser.documentation()` | `browser_capabilities` |
| REPL 状态跨调用保留 | host 保留 session、tab handle、snapshot 和 lease 状态 |
| 在 JS 中组合 `browser-client` API | 通过 operation registry 派发 `browser_*` operation |
| 能力说明作为 REPL 输出 | 能力说明和单 operation schema 作为 tool result/message |

本阶段不引入任意 Node.js/JavaScript 执行器，也不允许任意 Bridge method 透传。这样保留了 `node_repl` 的固定入口和渐进发现优势，同时复用当前 target fence、lease、cleanup、confirmation 和不自动重放的安全执行链。未来如确实需要多步 JS 组合，可在同一 registry/executor 之上新增独立的 `browser_js` 模式，而不改变 progressive facade 的 cache 不变量。

## 2. 背景与现状

### 2.1 当前实现位置

| 文件 | 当前职责 |
|---|---|
| `dsh-tool-control-chrome/src/index.ts` | 读取配置、创建 Bridge、安装 browser tools、注册 Skill 和 `/chrome` 命令 |
| `dsh-tool-control-chrome/src/tools.ts` | `CORE_TOOLS`、`ADVANCED_TOOLS`、参数定义、Bridge 执行、生命周期清理 |
| `dsh-tool-control-chrome/src/skill.ts` | 注册 bundled `pi-control-chrome` Skill |
| `dsh-tool-control-chrome/src/types.ts` | host 配置和浏览器身份/句柄类型 |
| `dsh-tool-control-chrome/src/output.ts` | DSH 输出投影与共享 extension output adapter |
| `dsh-tool-control-chrome/tests/tools.test.ts` | 工具目录、行为、生命周期和 cleanup 测试 |
| `dsh-tool-control-chrome/tests/load-path.test.ts` | Loader、lazy/eager 注册、Skill provider 测试 |
| `dsh-tool-control-chrome/skills/pi-control-chrome/SKILL.md` | 模型侧浏览器工作流契约 |
| `pi-extension/activation.js` | Pi 侧 session-local lazy activation 状态 |

### 2.2 当前工具目录

`dsh-tool-control-chrome/src/tools.ts` 当前导出：

```ts
export const browserToolCatalog = {
  core: CORE_TOOLS,
  advanced: ADVANCED_TOOLS,
} as const
```

实际 `BROWSER_TOOL_NAMES` 当前为 **44 个**。现有 `core` / `advanced` 划分可继续作为 operation 分组的初始来源，但不应把数组名称误认为已经实现了运行时分阶段注册。

当前注册路径：

```ts
const registerFor = (scope: Context): (() => void)[] => {
  for (const spec of [...CORE_TOOLS, ...ADVANCED_TOOLS]) {
    disposers.push(scope.tools.register(toolFor(spec)))
  }
}
```

`lazyTools: true` 时，完整目录在命名 Skill 成功后注册到当前 Agent；`lazyTools: false` 时，完整目录注册到全局 scope。

### 2.3 当前已经存在的“数据渐进式”

工具目录之外，页面数据层已经有良好的渐进式设计，本方案保留它：

- `responseMode: compact | raw`；
- `maxChars`、`maxNodes`；
- `browser_extract` 的 `primary` / `log` / `body`；
- `includeFrames`；
- snapshot ref、AX ref、DOM-CUA node 和 `snapshotId`；
- Console/Network 的 `since` / `nextSince` 增量读取；
- 页面变更后的重新观察与结构化不确定错误。

本方案只解决**工具能力目录如何逐级发现**，不替换现有页面数据投影。

## 3. 设计约束

### 3.1 Cache-clean 约束

当前 DSH 部署已经实测：provider prefix cache 覆盖 `tools` 和 system prompt。以下任一操作发生在首次请求后，都可能使整个 prefix 失效：

- 注册或注销真实 browser tool；
- 改变工具参数 schema 或描述；
- 改变包含工具说明的 system prompt section；
- 改变 PTC/code 模式的 `tools:sdk` prompt section。

因此以下方案禁止作为 DSH progressive mode 的实现：

```text
browser_capabilities → registerFor(advanced) → tools 数组变更
Skill → tools.register(...) → tools 数组变更
browser_search → 动态解除某个工具 mask → tools 数组变更
```

### 3.2 能力层边界

遵守 `ARCHITECTURE.md` 和 `DECISIONS.zh-CN.md`：

- host adapter 只描述通用浏览器结构、安全边界和操作原语；
- 不加入 Jenkins、OA、GitHub 等站点名称、selector、字段名或状态词；
- 站点流程和领域解析仍由调用方 Skill 完成；
- capability advertisement 是强制点，陈旧 runtime 必须显式失败；
- dispatcher 不能绕过 permission、approval、sandbox、target fence、lease 或 cleanup。

### 3.3 兼容性约束

- Pi 侧现有 `lazy-full` 行为先保持不变；
- DSH 侧新增 `progressive` exposure mode；
- 现有 44 个 raw browser tool 名称和 operation 行为不删除；
- raw tool 和 dispatcher 必须复用同一个 operation executor；
- `browser_*` 命名继续保留，不把内部 dispatcher 暴露成站点专用 API。

## 4. 目标架构

### 4.1 Exposure mode

新增显式模式，而不是改变 `lazyTools` 的原有语义：

```ts
export type BrowserExposureMode = 'lazy-full' | 'progressive'
```

建议配置：

```ts
interface Config {
  /** Existing Pi/legacy behaviour: no raw tools until Skill, then all raw tools. */
  lazyTools?: boolean
  /** Cache-clean DSH facade mode. */
  exposureMode?: BrowserExposureMode
}
```

优先级：

```text
exposureMode === 'progressive'
  → 使用固定 facade，不注册 44 个 raw tool

否则
  → 沿用当前 lazyTools 逻辑
```

`progressive` 模式下，facade 必须在 plugin apply 时注册到稳定的 root/global scope，而不是等 Skill 成功后注册到当前 Agent。这样普通 DSH 会话从第一条请求就带着相同的 facade，不需要依赖会话中途的 Skill 事件。

### 4.2 初始固定 facade

当前 progressive facade 固定以下三个核心入口：

```text
browser_capabilities
browser_call
browser_status
```

其中：

- `browser_capabilities`：纯本地 registry 查询，不启动 Bridge，不接触页面；
- `browser_status`：高价值、安全的 bootstrap read，模型仍可按当前工作流先确认浏览器目标；
- `browser_call`：派发所有已发现 operation，包括观察、导航、交互、advanced 和 lifecycle operation；确认型 lifecycle operation 必须在用户明确确认后通过 `arguments.confirmed: true` 派发。

三个核心入口在 plugin apply 时固定注册，不能在会话中途切换固定集合。完整 44 个 raw tool 仍只由 Pi/兼容路径的 `lazy-full` 暴露。

### 4.3 Operation 分组

初始分组沿用现有 `core` / `advanced` 的语义，但提升为可查询的 capability registry：

```text
bootstrap
  browser_status
  browser_doctor
  browser_targets

observe
  browser_tabs
  browser_selected
  browser_snapshot
  browser_extract
  browser_accessibility_snapshot

navigate
  browser_navigate
  browser_wait
  browser_back
  browser_forward
  browser_reload

interact
  browser_click
  browser_double_click
  browser_fill
  browser_type
  browser_press_key
  browser_scroll
  browser_screenshot
  browser_probe_interaction

advanced
  browser_locator
  browser_dom_cua
  browser_cua
  browser_console
  browser_network
  browser_dialog
  browser_upload
  browser_clipboard
  browser_download
  browser_evaluate
  browser_cdp

lifecycle
  browser_claim_tab
  browser_select_tab
  browser_new_tab
  browser_close_tab
  browser_release
  browser_mark_handoff
  browser_mark_deliverable
```

高风险/明确确认语义的 operation 仍单独标记：

```text
browser_restart
browser_reload_extension
browser_cleanup
browser_context_reset
```

它们不再占用固定工具名，而是由 `browser_call` 派发；对应 operation schema 要求 `arguments.confirmed: true`，且只应在用户明确确认后发送。这样减少初始 catalog，同时不弱化现有确认语义。

## 5. API Contract

### 5.1 `browser_capabilities`

固定工具 schema：

```ts
interface BrowserCapabilitiesInput {
  readonly group?: string
  readonly operation?: string
  readonly detail?: 'summary' | 'schema'
  readonly apiRevision?: string
}
```

调用示例：

```json
{
  "group": "observe",
  "detail": "summary"
}
```

返回示例：

```json
{
  "apiRevision": "browser-api-v2",
  "capabilityRevision": 7,
  "groups": [
    {
      "id": "observe",
      "description": "读取标签页和页面语义状态",
      "operations": [
        {
          "name": "browser_tabs",
          "summary": "列出窗口和标签页",
          "safety": "read"
        },
        {
          "name": "browser_snapshot",
          "summary": "读取页面语义结构",
          "safety": "read"
        }
      ]
    }
  ]
}
```

默认 `summary` 只返回：

- capability group；
- operation 名称；
- 一句话用途；
- `read` / `side_effect` / `confirmation_required` 等安全级别；
- 是否需要 `tabId`、`snapshotId`、`browserId` 等关键输入。

完整参数只按需返回：

```json
{
  "operation": "browser_snapshot",
  "detail": "schema"
}
```

返回：

```json
{
  "apiRevision": "browser-api-v2",
  "operation": "browser_snapshot",
  "schema": {
    "type": "object",
    "properties": {
      "tabId": { "type": "number" },
      "snapshotId": { "type": "string" },
      "responseMode": { "type": "string", "enum": ["compact", "raw"] }
    }
  },
  "safety": "read",
  "retry": "read-only may re-observe once; side effects are never replayed"
}
```

`browser_capabilities` 必须：

- 不调用 Bridge；
- 不读取当前 tab；
- 不改变 active target；
- 对 summary 和 schema 设置字符/operation 上限；
- 不把整个 44-tool 完整 schema 一次性塞回结果。
- 对 `confirmation_required` operation，schema 明确返回 `confirmed` required 参数；只有用户明确确认后，调用方才应在 `browser_call.arguments` 中传入 `confirmed: true`。

### 5.2 `browser_call`

固定工具 schema：

```ts
interface BrowserCallInput {
  readonly operation: string
  readonly arguments: Record<string, unknown>
  readonly apiRevision?: string
}
```

调用示例：

```json
{
  "operation": "browser_snapshot",
  "arguments": {
    "tabId": 123,
    "responseMode": "compact",
    "maxNodes": 100
  },
  "apiRevision": "browser-api-v2"
}
```

固定 schema 只允许通用 JSON 参数；operation registry 负责第二层严格校验。对 `confirmation_required` operation，调用方必须先获得用户明确确认，再在该 operation 的 `arguments` 中传入 `confirmed: true`：

```json
{
  "operation": "browser_cleanup",
  "arguments": { "confirmed": true },
  "apiRevision": "browser-api-v2"
}
```

其余校验链如下：

```text
operation name
  → operation spec
  → normalizeBrowserToolArgs()
  → validateRequestNumbers()
  → operation-specific validation
  → target / connection / lease fencing
  → Bridge request
  → existing output projection
```

未知 operation 不得退化成任意 Bridge method 调用，必须返回结构化错误：

```json
{
  "code": "BROWSER_UNKNOWN_OPERATION",
  "operation": "browser_xxx",
  "apiRevision": "browser-api-v2",
  "nextAction": "call browser_capabilities with detail=schema"
}
```

`apiRevision` 用来处理 operation registry 版本不一致：

- 未传：使用当前版本；
- 版本一致：正常执行；
- 版本过旧或未知：返回 stale capability 错误，不猜测参数；
- Bridge 的 `capabilityRevision` 与 host API 的 `apiRevision` 分开，不混用。

### 5.3 返回与错误

`browser_call` 必须返回和现有 raw tool 相同的业务结果投影，包括：

- `compactBrowserResult`；
- snapshot/AX/DOM-CUA 的 refs 和 `snapshotId`；
- tab handle、`browserId`、`tabFence`、document `incarnation`；
- screenshot attachment；
- Console/Network cursor；
- `actionState`、`retryable`、`inspectFirst`、`nextAction`、`recommendation`。

dispatcher 自己只增加一层 envelope：

```json
{
  "apiRevision": "browser-api-v2",
  "operation": "browser_snapshot",
  "result": { "...": "existing projected result" }
}
```

不确定的副作用操作仍然必须遵守当前规则：

```text
不自动重放
先检查页面/目标状态
按照结构化错误的 nextAction 继续
```

## 6. 内部实现计划

### Phase 0：基线和契约 fixture

1. 修正 README 中的 43/44 工具数不一致；实际以 `BROWSER_TOOL_NAMES.length` 为准。
2. 增加 capability registry 的 fixture，覆盖每个 group、operation、安全级别和关键字段。
3. 记录三种目录成本：
   - 当前 `lazy-full` 的 44-tool catalog；
   - progressive 固定 facade；
   - capability summary/schema tool result 的字符数。
4. 先不改默认行为。

### Phase 1：operation registry

在 `src/tools.ts` 中把现有 spec 提升为可共享 registry：

```ts
interface BrowserOperationSpec {
  readonly name: string
  readonly group: BrowserCapabilityGroup
  readonly description: string
  readonly parameters: ParameterSchemaSpec
  readonly method: string
  readonly safety: 'read' | 'side_effect' | 'confirmation_required'
  readonly prepare?: ...
}
```

保留：

```ts
CORE_TOOLS
ADVANCED_TOOLS
BROWSER_TOOL_NAMES
browserToolCatalog.core
browserToolCatalog.advanced
```

新增：

```ts
export const browserCapabilityCatalog
export const browserOperationRegistry
```

目标是保持现有 exports 兼容，同时让 dispatcher 可以通过 operation name 查找同一份 spec。

### Phase 2：抽取共享 executor

把当前 `toolFor(spec).execute()` 中的 Bridge/target/lifecycle 主体抽成：

```ts
async function executeBrowserOperation(
  spec: BrowserOperationSpec,
  args: Record<string, JsonValue>,
  exec: ToolRunContext,
): Promise<JsonValue>
```

然后：

```text
defineTool(raw spec)
  → executeBrowserOperation(spec, args, exec)

browser_call
  → resolve operation spec
  → executeBrowserOperation(spec, arguments, exec)
```

不能为 dispatcher 直接复制一份 `bridge.request()` 分支。

特殊处理：

- `browser_capabilities` 不走 Bridge executor；
- `browser_status` 继续走现有 status 分支；
- cleanup pending 状态仍以真实的 `ToolRunContext` 为 key；
- `browser_call` 的内部 operation name 必须被 lifecycle/turn cleanup 识别；
- screenshot 使用现有 attachments renderer；
- `browser_cleanup`、`browser_context_reset` 等确认 operation 在 progressive 中通过 `browser_call` 派发，lazy-full 继续使用独立 raw registration。

### Phase 3：固定 facade

新增：

```ts
function registerProgressiveFacade(scope: Context, ...): (() => void)[]
```

注册：

```text
browser_capabilities
browser_call
browser_status
```

`apply()` 逻辑：

```text
if exposureMode === 'progressive':
    registerProgressiveFacade(root ctx)
    register Skill metadata
    do not register 44 raw tools
    Bridge remains lazy
else if lazyTools:
    keep existing Skill-gated full catalog
else:
    keep existing eager full catalog
```

progressive mode 不应监听 Skill 成功来注册或注销真实工具。Skill 只提供如何使用 facade 的说明。

### Phase 4：Skill 与文档

修改 bundled Skill：

```text
DSH progressive mode:
  1. browser_capabilities({ group: ... })
  2. browser_capabilities({ operation: ..., detail: 'schema' })
  3. browser_call({ operation, arguments, apiRevision })

Pi lazy-full mode:
  仍可直接调用现有 browser_* 工具
```

说明必须明确：

- `browser_capabilities` 不是浏览器连接检查；
- 首次实际浏览器操作仍应先调用 `browser_status`；
- `browser_call` 不允许任意 CDP method；
- operation schema 是动态 tool result，不是新工具；
- site-specific logic 仍放在 calling Skill。

同步更新：

- `dsh-tool-control-chrome/README.md`；
- `dsh-tool-control-chrome/config/settings.yaml.example`（如需要）；
- 本项目 `ARCHITECTURE.md` 的 host adapter 说明；
- `DECISIONS.zh-CN.md` 的工具暴露/能力发现条目；
- Pi/DSH 共有 Skill reference。

### Phase 5：DSH profile opt-in

只在确认 package tests 和 token benchmark 后，在 DSH profile 中配置：

```yaml
config:
  exposureMode: progressive
```

不要把 progressive mode 与 `lazyTools: false` 混合成隐含优先级；配置必须能从启动日志/诊断中看出最终 exposure mode。

## 7. 测试计划

### 7.1 Registry 与 capability tests

新增 `tests/capabilities.test.ts`，断言：

- 所有 44 个现有 operation 都能从 registry 找到；
- operation name 唯一；
- 每个 operation 恰好属于一个 group；
- schema 可 JSON 序列化；
- summary 不返回完整参数，`detail=schema` 才返回完整 schema；
- 未知 group/operation 返回结构化错误；
- operation revision 不匹配时 fail closed；
- capabilities 查询不调用 Bridge。

### 7.2 Dispatcher tests

在 `tests/tools.test.ts` 增加：

- `browser_call(browser_status)` 使用现有 status 路径；
- `browser_call(browser_snapshot)` 与 raw `browser_snapshot` 经过同一个 executor；
- 参数错误和 raw tool 的错误类别一致；
- target fence、connection generation、lease、cleanup 和 cancellation 行为一致；
- side-effect 不会因为 dispatcher 而自动重放；
- screenshot attachment 与 raw tool 一致；
- close/upload/download/evaluate/CDP 等操作不会绕过现有安全约束；
- `browser_capabilities` 不创建或连接 Bridge。

### 7.3 Exposure mode tests

扩展 `tests/load-path.test.ts`：

```text
lazy-full + Skill 未加载
  → 没有 raw browser schema

lazy-full + Skill 成功
  → 44 个 raw browser schema

progressive + Skill 未加载
  → 只有固定 facade

progressive + Skill 成功
  → tools 数组完全不变

progressive + 任意 browser_capabilities/browser_call
  → tools 数组完全不变

eager/lazy-full 旧模式
  → 既有兼容行为不变
```

### 7.4 Cache acceptance

需要一个真实 DSH session fixture 或手工验收：

1. 首条 header 包含固定 facade；
2. 调用 `browser_capabilities` 后不产生新 header；
3. 调用 `browser_call` 后不产生新 header；
4. 连续调用不同 group 的 operation 后仍不产生新 header；
5. provider 后续请求继续命中 prefix cache；
6. 完整 44-tool schema 不出现在 progressive 初始 header；
7. capability result 的大小有明确上限。

核心验收不是“能不能调用”，而是：

```text
headers_after_capability == headers_before_capability
headers_after_operation == headers_before_operation
```

### 7.5 现有行为回归

继续运行：

```powershell
corepack pnpm --dir dsh-tool-control-chrome run check
corepack pnpm --dir dsh-tool-control-chrome test
corepack pnpm --dir dsh-tool-control-chrome run build
corepack pnpm --dir dsh-tool-control-chrome run pack:check
```

同时确认：

- `/chrome ...` human commands 不受影响；
- Pi 的 `lazyTools` 行为不受影响；
- Bridge 协议无需升级；
- extension capability revision 仍按原规则校验；
- shared Skill references 在 Pi/DSH 两份之间保持一致。

## 8. 失败模式与防护

### 8.1 dispatcher 退化成万能 CDP

错误做法：

```json
{ "method": "Runtime.evaluate", "params": {} }
```

由 `browser_call` 直接透传。

防护：

- 只允许 registry 中的 operation name；
- `browser_cdp` 仍是一个明确的 operation；
- 继续应用现有 capability checks、参数清洗和 target fence；
- 返回结构化 unknown-operation 错误。

### 8.2 schema 过大重新制造上下文膨胀

错误做法：`browser_capabilities()` 默认返回 44 个完整 schema。

防护：

- summary 默认只返回组和 operation 摘要；
- schema 只按单 operation 查询；
- group/operation/字符数设上限；
- 返回 `omitted`、`nextAction`，让能力可继续查询而不是静默截断。

### 8.3 facade 工具本身又被 Skill 延迟注册

错误做法：progressive mode 仍然在 `tools/result` 里等 Skill 成功后注册 facade。

防护：

- progressive facade 在 plugin apply 时注册到 root scope；
- Skill 只改变 message/使用说明；
- 加测试断言 Skill 前后 tools 数组完全相同。

### 8.4 generic arguments 绕过现有校验

错误做法：dispatcher 直接把 `arguments` 转成 Bridge payload。

防护：

```text
resolve spec
→ normalizeBrowserToolArgs
→ validate request
→ validate operation-specific fields
→ existing executor
```

raw tool 和 dispatcher 必须共享这条路径。

### 8.5 lifecycle/cleanup 状态丢失

`browser_call` 不是普通纯函数调用。它必须继续携带当前 Agent 的：

- session id；
- turn number；
- pending cleanup execution；
- operation FIFO；
- target lease；
- recovery record；
- generation/fence。

当前实现已经完整复用这条执行链；progressive 的 lifecycle operation 通过 `browser_call` 派发，并由 operation schema 和 `arguments.confirmed` 保持确认约束。

### 8.6 Skill 文案与 exposure mode 漂移

Skill 文案必须同时说明 Pi `lazy-full` 和 DSH `progressive`：

- DSH 不应指导模型直接调用不存在于 `tools` 数组的 raw tool；
- Pi 不能因为 DSH 文案而失去现有 raw API；
- 站点 Skill 不得假定某个 host 一定拥有全部 44 个 raw tool。

## 9. 迁移和回滚

### 9.1 默认策略

第一版代码合入后，默认仍使用：

```text
exposureMode = lazy-full
```

先让 registry/executor/facade 在测试中稳定，再由 DSH profile 显式 opt-in progressive。

### 9.2 DSH 启用

启用前确认：

1. package version 已包含 progressive mode；
2. DSH profile 配置只加入 `exposureMode: progressive`；
3. 重启 DSH（由维护者/用户手动完成，不由插件自动重启）；
4. 新开一个普通会话并检查初始 header；
5. 调用 capability 和多个 operation，再检查 header/cache；
6. 用实际浏览器页完成 status → tabs → snapshot → action 流程。

### 9.3 回滚

如果 dispatcher 行为或模型调用质量不达标：

```yaml
config:
  exposureMode: lazy-full
```

然后重启 host。回滚不涉及 Bridge 协议、extension 或 tab ownership 数据。

## 10. 验收标准

### 必须满足

- [ ] progressive 初始工具目录只有固定 facade，不含 44 个 raw browser schema；
- [ ] `browser_capabilities` 不启动 Bridge；
- [ ] 任意 capability 查询不改变 `tools` 数组；
- [ ] 任意 `browser_call` 不改变 `tools` 数组；
- [ ] unknown operation、stale API revision、参数错误均 fail closed；
- [ ] raw tool 和 dispatcher 共用同一个 operation executor；
- [ ] target fence、lease、cleanup、cancellation、uncertain side effect、attachment 行为不回归；
- [ ] Pi `lazy-full` 兼容路径不回归；
- [ ] DSH 真实日志中 capability/operation 调用期间没有新增 `request/header`；
- [ ] provider cache 在 facade 会话中持续命中；
- [ ] Skill 文案不要求直接调用未注册的 raw tool。

### 需要测量但不预设固定值

- progressive 初始 facade 的工具定义 token；
- `browser_capabilities` summary/schema result 的字符数；
- 从 summary 到实际 call 的平均额外往返；
- dispatcher 相比 raw tool 的参数错误率；
- 44 个 operation 的历史调用覆盖率；
- 需要完整 schema 的 operation 比例。

“是否值得”不能只看初始 token，还要同时看：

```text
initial_catalog_cost
+ capability_round_trips
+ dispatcher_error/recovery_cost
+ model_success_rate
```

## 11. 本次实现决定

本 worktree 按以下决定实现，避免工具目录在运行时出现隐含变化：

1. 固定 facade 使用 3 个核心工具：`browser_capabilities`、`browser_call`、`browser_status`。
2. `browser_capabilities` 无参数时返回分组和 operation 名称；指定 group 时返回短 operation 摘要；指定 operation 且 `detail: schema` 时只返回一个完整 schema。
3. `browser_call.operation` 使用 string，由固定 operation registry 校验，不把完整 44 名称 schema 放进 facade 工具定义。
4. `browser_call` 派发普通观察、导航、交互、advanced 和 lifecycle operation；四个确认型生命周期 operation 通过 `arguments.confirmed: true` 保持显式用户确认语义。
5. `apiRevision` 使用显式静态 host revision `browser-api-v2`；它与 Bridge/extension 的 `capabilityRevision` 分开。
6. 第一版只在 DSH adapter 中启用 `progressive`；Pi 保持 `lazy-full` 兼容路径。
7. 之前实测 7-tool progressive facade 为 10,041 tools tokens；当前 3-tool schema 已测得 1,836 chars，按同一 DSH schema 估算约 9,520 tools tokens，较 44-tool raw 的 22,970 预计节省约 13,450（约 58.6%）。

## 12. 实现后的剩余验收

代码、单元测试和 package build 已覆盖 operation registry、共享 executor、facade 注册、参数校验和 Skill 前后工具集合稳定性；以下项目必须在启用 DSH profile 后补充真实运行证据：

- [ ] progressive 初始 facade 的实际 token 成本；
- [ ] capability summary/schema result 的实际字符数；
- [ ] capability/operation 调用期间没有新增 request/header；
- [ ] provider cache 在 facade 会话中持续命中；
- [ ] 真实 Chrome/Edge session 完成 status → tabs → snapshot → action 流程。

## 13. 实现顺序与后续

本 worktree 已按以下顺序完成代码和 package-level 验证：

```text
operation registry
  → shared executor
    → capability result contract
      → browser_call dispatcher
        → progressive exposure mode
          → Skill/README/架构文档
            → package tests/build/pack
```

剩余步骤是 DSH Profile 显式 opt-in 和真实 session cache 验收：

```text
DSH profile opt-in
  → 手动重启 DSH
    → status → tabs → snapshot → action
      → 检查 capability/operation 前后 header 和 cache
```

不要把 `CORE_TOOLS` / `ADVANCED_TOOLS` 改成会话中途的动态注册。operation registry 和共享 executor 已经确保“渐进式暴露”只是入口变化，而不是重新实现一套不一致的浏览器控制逻辑。
