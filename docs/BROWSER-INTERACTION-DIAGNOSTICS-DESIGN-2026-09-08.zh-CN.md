# pi-control-chrome 浏览器交互后诊断增强方案

> 状态：P1/P2/P3 已实现并通过独立 Edge 回归；保留为设计与验收记录
>
> 范围：浏览器交互工具、Runtime Console 采集、交互后页面验证和排查工作流；不放宽 browser target、tab ownership、tab fence、document incarnation、lease 或隐私边界。

## 1. 背景与问题

DSH Web 这类问题必须验证“实际动作之后发生了什么”，不能只检查动作前的截图或 DOM。当前 pi-control-chrome 已经提供 tab 选择、semantic snapshot、locator、DOM-CUA、截图、Runtime Console 和 CDP 等能力，但这些能力由多个独立操作组成，排查时容易漏掉真正的点击或点击后的 Console 读取。

一次 Edit 展开异常说明了这个风险：页面初始状态没有错误，只有真实点击 Edit 后才触发 React slot 异常；如果只观察 DOM 和滚动位置，可能把渲染失败误判为元素滚出视口。DOM 中存在目标元素，也不能证明目标成功渲染、仍然可见或交互成功。

## 2. 目标

- 让一次浏览器交互能够关联目标、动作、文档身份、运行时错误和动作后的页面状态。
- 让 Agent 在点击后自动获得新增 `console.error`、`pageerror` 和未捕获异常，而不是依赖人工再调用 Console 工具。
- 在交互结果不确定时明确返回不确定状态，禁止自动重放可能已经发生的副作用动作。
- 保留现有 tab ownership、target lease、document identity、敏感数据保护和最小输出原则。
- 让 UI 消失、白屏、slot crash、点击后跳转和异步渲染失败拥有统一的排查路径。

## 3. 核心方案

### 3.1 增加可选的交互诊断模式

为 semantic locator、DOM-CUA 和 coordinate CUA 的副作用动作增加可选的 `diagnostic` 选项。普通动作保持现有返回格式，只有显式启用诊断时才建立 Console 基线并采集动作后的诊断信息。

诊断动作按以下顺序执行：

```text
确认 browserId、tabId、tabFence 和 document incarnation
→ 解析唯一且可操作的目标
→ 建立 Console / pageerror 基线
→ 分发一次动作
→ 等待指定的 load、visible、text 或 DOM settle 条件
→ 读取基线之后的新错误
→ 返回动作后的目标、URL 和文档状态
```

### 3.2 统一诊断结果

诊断结果应分开记录每个阶段，至少包含以下信息：

- `target`: 目标的语义描述、解析方式和唯一性结果。
- `action`: 动作类型、分发状态和是否确认完成。
- `identity`: browser、tab、fence、document incarnation 和当前 URL。
- `console`: 本次动作之后新增的 `console.error`、`pageerror` 和未捕获异常。
- `postState`: 目标是否存在、可见、启用，以及动作后的必要文本或属性。
- `settling`: 使用的等待条件、完成状态和未完成原因。

动作可能已经发生但响应丢失时，结果必须是 `BROWSER_OPERATION_UNCERTAIN` 或等价的不确定状态，并阻止自动重放。

### 3.3 增量 Console 采集

`browser_console` 应支持可复用的 Console 基线或等价的增量读取能力：

- `clearBefore` 或返回基线 token。
- `since` 读取基线之后的新事件。
- `only: "errors"` 过滤普通日志和无关警告。
- 限制事件数量、文本长度和堆栈深度。
- 标记事件来源、时间、文件、行号和列号。

诊断默认只返回新增错误，不读取全部历史 Console。完整 Console 仍保留给显式的人工诊断操作。

### 3.4 提供组合探针

在现有底层工具之上增加一个面向排查的组合操作，例如 `browser_probe_interaction`。该操作接收目标、动作和可选的 settle 条件，返回统一诊断结果。

组合探针不绕过现有 locator、DOM-CUA、target lease 或副作用确认逻辑。它只负责编排已有能力，并保留每一步的结果，避免把“定位成功”“动作分发成功”“页面渲染成功”混成一个布尔值。

## 4. 工作流规则

Skill 文档应明确规定：遇到“点击后消失”“点击后报错”“点击后白屏”“slot crash”或“页面状态与截图不一致”时，必须执行一次真实触发动作，并读取动作之后的 Console 和页面状态。

排查结果不能只依据以下证据：元素存在于 DOM、元素曾经出现在旧 snapshot、截图中滚动条发生变化，或页面加载时 Console 没有错误。

Agent 必须在报告中区分：已实际复现、只观察到静态状态、动作未执行、动作结果不确定，以及运行时错误已被动作关联。

## 5. 安全与隐私

- 诊断模式默认关闭，不让普通点击自动收集无关页面日志。
- Console 和异常文本继续遵守有界输出规则，不读取 cookies、storage、密码、令牌或无关页面数据。
- 诊断结果只属于当前 tab、当前 document 和当前动作，不能跨 tab 合并。
- 目标歧义、stale ref、document 变化和 target lease 失败继续安全失败。
- 截图、完整 DOM、Network body 和完整 Console 仍然是显式的后续诊断能力，不作为每次动作的默认输出。

## 6. 测试计划

新增隔离浏览器 fixture，覆盖以下动作后结果：

1. 点击后抛出 `console.error` 或 `pageerror`。
2. 点击后从 DOM 移除目标行。
3. 点击后目标行高度变化并触发异步渲染。
4. 页面持续流式追加内容时点击历史卡片。
5. 页面存在多个同名 Edit 目标。
6. 目标在滚动容器内但不在当前视口。
7. 动作可能已经发生但 Bridge 在返回前断开。
8. 页面没有运行时错误但目标成功展开。

每个 fixture 都应断言动作身份、Console 增量、postState 和不确定状态，而不是只断言截图或 DOM 数量。

## 7. 分阶段实施与当前结果

### P0：工作流规则

已完成：Skill 和恢复手册要求遇到“点击后消失”“点击后报错”“slot crash”等问题时，必须执行真实动作并读取动作后的 Console 与页面状态。

### P1：统一交互探针（已完成）

已实现 `browser_probe_interaction`，统一一次动作、目标解析、等待、动作确认、前后 document identity、Console 增量和 postState。支持 click、表单、键盘、focus、hover 和 scroll，并保留不确定副作用的禁止重放规则。

### P2：Console 增量诊断（已完成）

已扩展 `browser_console`：返回 `nextSince` 游标，支持 `since` 增量读取、`only: "errors"` 过滤、`Runtime.exceptionThrown` → `pageerror` 映射、来源位置、堆栈和有界输出。诊断默认只返回动作后的错误事件，不清空或泄露无关历史。

### P3：独立浏览器回归（已完成）

已在隔离 Edge profile 中增加真实 fixture 并验证：点击后 `console.error`、未捕获异常、目标从 DOM 消失、异步 settle、无错误稳定展开和 Console 增量游标。测试使用独立 Bridge 端口、临时扩展副本和临时浏览器 profile，不触碰日常 DSH 浏览器会话。

实现入口：

- `extension/background.js` — Bridge 侧 Console 事件、有界 cursor 和探针编排；
- `pi-extension/index.ts`、`dsh-tool-control-chrome/src/tools.ts`、`codex/mcp-server.mjs` — Pi、DSH 和 Codex 工具面；
- `tests/e2e-browser.mjs` — 独立真实浏览器 fixture；
- `tests/extension-lifecycle.test.mjs`、`dsh-tool-control-chrome/tests/tools.test.ts` — 单元和协议回归。

## 8. 非目标

- 不把所有浏览器操作改成自动截图或录屏。
- 不默认读取完整 Console、Network response body 或页面存储。
- 不用组合探针绕过用户标签页所有权、文档身份和副作用确认。
- 不把普通 UI 警告自动判定为动作失败；只有动作之后新增且可关联的运行时错误进入错误摘要。

## 9. 验收标准

- 一个显式诊断动作能够返回准确的 tab/document 身份、目标解析结果、动作确认状态、新增运行时错误和动作后的目标状态。
- 点击触发 React 渲染异常的 fixture 能在一次诊断结果中同时显示动作与异常，而不需要人工拼接多次工具调用。
- 没有异常的展开 fixture 不产生误报，并能报告目标已可见且处于展开状态。
- stale、歧义、不可操作和不确定动作不会被自动重放。
- 现有 ownership、lease、document identity 和隐私测试保持通过。
- Skill 流程、隔离 fixture、Chrome/Edge 真实浏览器回归和包级检查全部通过。

## 10. 取舍

只修改 Skill 文档成本最低，但无法防止复杂排查再次遗漏 Console 读取；因此方案要求增加可选的工具层诊断编排。每次动作都自动采集 Console 会增加日志噪声和隐私风险，因此诊断保持显式启用，并默认只返回动作后的错误增量。完整截图和 DOM trace 作为后续证据保留，不作为替代运行时错误关联的默认机制。
