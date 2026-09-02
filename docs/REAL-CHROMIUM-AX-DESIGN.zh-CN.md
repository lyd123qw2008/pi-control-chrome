# 真实 Chromium Accessibility Tree 接入设计

> 状态：P3a、P3b、P3c 首轮实现已完成，待目标浏览器重载后的持续验收。
>
> 当前 `browser_accessibility_snapshot` 优先使用真实 Chromium AX；AX domain 明确不可用时回退 DOM 派生的 accessibility-oriented semantic tree。`axRefs` 已开启：AX ref 仅在 accessibility snapshot 中生成，并继续受 tab fence、document identity、一次 semantic rebind、debugger lease 和副作用 uncertainty 约束。
>
> 关联文档：[浏览器运行时设计](./AGENT-BROWSER-RUNTIME-DESIGN.zh-CN.md)、[输出压缩设计](./BROWSER-OUTPUT-COMPACTION-DESIGN.zh-CN.md)。

## 1. 背景

当前 accessibility collector 自己遍历 DOM，并自行推导：

- implicit/explicit role；
- accessible name；
- visible、disabled 和部分表单状态；
- `aria-label`、`aria-labelledby`、`label`、`alt` 等名称来源。

这条路径适合作为兼容 fallback，但它不是 Chromium 实际提供给辅助技术的 AX tree，容易与浏览器对复杂 ARIA、原生控件、ignored/hidden 节点、状态和关系的判断产生差异。

P3 通过已经存在的 `chrome.debugger` lease 调用 Chromium DevTools Accessibility domain：P3a 替换读取来源，P3b 增加受 document/frame 约束的内部 AX/DOM 映射，P3c 开放 `aN` ref 的有限交互。

## 2. 设计目标与非目标

### 2.1 目标

1. `browser_accessibility_snapshot` 优先读取真实 Chromium AX tree。
2. 保留现有 `full`、`diff`、`unchanged` 外部契约和预算参数。
3. 保留 `browserId`、tab fence、document incarnation、取消和 debugger lease 的安全语义。
4. 对主 frame 做强校验；frame 无法安全验证时省略或降级，不猜测目标归属。
5. 继续执行节点、字符和敏感信息预算，避免原始 CDP 响应进入模型结果。
6. AX/CDP 能力不可用时回退现有 DOM 派生语义树。

### 2.2 非目标

P3a 不做以下事情：

- 不让 AX node ID 或 backend DOM node ID 直接成为公共 ref；
- 不跳过 document/frame fencing、actionability 检查或副作用 uncertainty 处理驱动 click、fill、type 或其他动作；
- 不改变 `browser_accessibility_snapshot` 的 wire format；
- 不把 AX tree 当作 document fencing、tab fencing 或副作用确认机制；
- 不引入 MCP、远程 Bridge、Workflow Runtime、统一 adapter 或新的核心包。

## 3. 外部契约

P3a 继续返回当前结果形状：

```json
{
  "snapshotId": "snapshot-2",
  "baseSnapshotId": "snapshot-1",
  "mode": "diff",
  "state": "+ button \"保存\" [ref=a1]\n~ textbox \"搜索\" value=\"订单\" [ref=a2]",
  "nodeCount": 2,
  "changedNodeCount": 2,
  "charCount": 72,
  "truncated": false
}
```

语义保持不变：

- `full`：没有可用的同 document 基线、显式禁用 diff、基线不确定或 diff 过宽；
- `diff`：同一 tab/document 下只报告新增、变化和删除的节点；
- `unchanged`：没有可观察变化，只报告状态标识和计数；
- `snapshotId` 是 observation provenance，不是 AX 节点授权版本；
- compact Pi/DSH 结果不暴露原始 `children`、CDP node ID、backend node ID、frameTree 或 revision 内部表。

`source: "chromium_ax"`、frame 失败计数等信息只作为受限 raw/开发者诊断字段保留，不能成为模型必须依赖的契约。当前能力声明为：

```json
{ "axRefs": true }
```

`aN` 只在真实 Chromium AX observation 能提供可映射 backend DOM node 且节点为 actionable/focusable 时生成；DOM fallback 不伪造 `aN`。

## 4. P3a 读取流程

```text
browser_accessibility_snapshot
  |
  +-- 读取当前 Page Agent document identity
  |
  +-- debugger lease + tab fence
  |
  +-- Accessibility.enable
  |
  +-- Page.getFrameTree
  |     |
  |     +-- 无 selector：逐 frame getFullAXTree
  |     |
  |     `-- 有 selector：主 frame DOM.getDocument/querySelector
  |                         -> Accessibility.getPartialAXTree
  |
  +-- AX normalization / redaction / budget
  |
  +-- 与同 document revision 比较
  |
  +-- 再次确认 document identity 和 tab fence
  |
  `-- 输出兼容的 full/diff/unchanged 结果
```

### 4.1 CDP 命令边界

P3a 使用已有 debugger lease，不新增连接模型：

- `Accessibility.enable`：开启当前 debugger target 的 Accessibility domain；
- `Page.getFrameTree`：取得可验证的 frame 关系；
- `Accessibility.getFullAXTree({ frameId })`：读取 frame 的完整 AX tree；
- `DOM.enable`、`DOM.getDocument`、`DOM.querySelector`、`DOM.describeNode`：仅用于 selector 范围定位、敏感属性判断和取得内部 backend identity；
- `Accessibility.getPartialAXTree({ nodeId, fetchRelatives: true })`：读取主 frame selector 对应子树。

P3b/P3c 使用 `DOM.enable`、`DOM.resolveNode` 将经过验证的 backend DOM node 映射到当前 document 的 DOM object；映射对象仅在一次操作期间存在并在 finally 中释放。AX 观察仍不把 raw node id 暴露给模型。

### 4.2 frame 策略

- 默认先读取主 frame，再按 `Page.getFrameTree` 中可验证的 child frame 读取；
- AX 内部键必须包含 `frameId`，不能只使用 AX node ID 或 backend node ID；
- selector 初期只支持主 frame，先用 DOM backend identity 找到 selector 根，再只保留该 AX 节点及其 descendants；跨 frame selector 不静默改写；
- child frame 读取失败时，保留主 frame 结果并标记结果不完整；
- 主 frame、tab fence 或 document identity 无法确认时，整个读取失败或回退，不返回看似完整的混合树；
- 跨域/OOPIF 的进一步支持必须以真实浏览器验证为前提，不能通过猜测 parent-child 关系实现。

## 5. AX normalization

原始 `AXNode` 只在扩展内部短暂存在。规范化后的内部节点至少保留：

```text
internal key = frameId + backendDOMNodeId
           或 frameId + 当前读取内的 AX nodeId

role
name
value（脱敏后）
disabled / checked / expanded / selected / pressed
required / readonly / editable / level
ignored / frame provenance
```

规则：

1. role、name、state 优先使用 Chromium AX 值，不再重新实现 DOM role/name 规则；
2. `ignored`、无意义包装节点和没有可读语义的节点不进入紧凑结果；
3. 保留按钮、链接、标题、表单控件、tab、menu、tree、dialog 等可理解语义；
4. 内部 diff key 不进入模型；没有稳定 backend identity 时只允许当前读取内的临时 key，不能据此生成 ref；
5. 不把 AX node 位置编码进 `eN`；公共 `aN` 只引用经当前 AX tree 验证并映射到 DOM 的 actionable/focusable 节点。

当前外部文本是扁平、有界的 state，而不是原始树。保留扁平投影可以避免把 Chromium 内部 child/parent 关系直接变成新的 wire contract；如果未来需要层次结构，另行设计版本化输出，不在 P3a 隐式改变。

## 6. 隐私与输出预算

真实 AX value 可能比 DOM value 更接近用户实际可听见的内容，因此脱敏不能省略。继续沿用现有策略：

- password、hidden、OTP、token、secret、credential、API key、信用卡、银行账户、PIN、CVV 等字段不输出值；
- 结合 role、name、description、autocomplete、input type 等非敏感提示判断风险；AX 未携带足够提示时，对有 backend identity 的 value-bearing 节点读取受限 DOM attributes 做补充判断，元数据无法确认时 fail closed 并隐藏 value；
- role/name/value 单字段有界，默认总预算为 20,000 字符、200 节点，硬上限仍为 100,000 字符、1,000 节点；
- hidden/ignored 节点不因为存在于 CDP 返回中而进入模型结果；
- 不输出完整 raw AX JSON、DOM backend ID、frame URL、loader 细节或 debugger lease；locator 对已识别敏感节点也不返回 value 或敏感属性；
- 达到预算或 child frame 不完整时设置 `truncated`，不能伪装成完整页面。

## 7. 生命周期与安全边界

AX 读取必须套在现有的 document/tab 安全边界内：

```text
browserId
+ tabId
+ tabFence
+ document incarnation
  (URL + performance.timeOrigin + per-document token)
+ verified frame identity
```

具体要求：

1. debugger attach、每个 CDP command 和 release 都通过现有 lease/fence 路径；
2. 采集前确认 snapshot 对应的 document identity 仍然有效；
3. 采集后再次确认 document identity；发生导航、reload、frame 生命周期变化或 tab replacement 时，不能把新旧 AX tree 组成一次 revision；
4. AX tree 变化本身是观察变化，不是安全授权变化；AX 不替代 Page Agent、tab fence、document fencing 或 cancellation；
5. AX ref 只由 accessibility snapshot 产生，解析前重新读取当前 AX tree；普通 `eN` ref 仍只由 Page Agent 管理；
6. debugger command 结果或 post-read identity 不确定时，按现有 `BROWSER_PAGE_CHANGING` / `BROWSER_OPERATION_UNCERTAIN` 语义处理，不能自动重试副作用动作。

## 8. Fallback 与错误策略

### 8.1 可以 fallback 的情况

以下情况可以回退到现有 DOM 派生 semantic tree：

- Accessibility domain 不存在、版本不支持或明确返回 method-not-found/not-supported；
- Accessibility/selector CDP domain 明确不可用，但当前 document 和 tab fence 仍可验证；
- AX adapter 在受支持浏览器上不可用，而普通页面脚本仍可安全执行。

fallback 结果继续使用 `full/diff/unchanged`，并标记为 DOM semantic source；fallback 不生成新的 `aN` ref，但不影响已存在的 document/fence 安全边界。

### 8.2 不可吞掉的错误

以下错误必须原样保留现有安全语义，不得用 fallback 隐藏：

- tab closed、tab fence 或 browser target changed；
- document identity 不一致或读取期间持续变化；
- request cancelled；
- debugger lease/cleanup 状态不确定；
- selector 明确无匹配或无效；
- 受限页面或 error page 无法验证；
- 已有的 `BROWSER_PAGE_CHANGING`、`BROWSER_OPERATION_UNCERTAIN`、`BROWSER_PAGE_UNAVAILABLE` 等错误。

内部可使用 `BROWSER_AX_UNAVAILABLE` 区分“能力不存在”和“安全边界失败”，但该代码不应成为模型依赖的新增正常分支。

## 9. Revision 设计

revision 仍按 tab/document 隔离：

```text
browser target
+ runtime instance
+ tab id
+ tab fence
+ document incarnation
+ accessibility observation
```

diff key 优先级：

1. `frameId + backendDOMNodeId`；
2. 同一次读取内的 `frameId + AX nodeId`；
3. 无法建立可靠 key 时放弃 diff，返回新的 `full`。

以下情况必须退化为 full 或 fallback：

- 没有同 document 基线；
- 主 frame 或 frame 关系发生变化；
- 大量节点 identity 同时变化；
- AX 读取不完整且 diff 会造成误导；
- revision provenance 被生命周期事件清除。

AX diff 只描述模型认知状态，不单独授予对旧节点的操作权。使用 `aN + snapshotId` 执行动作时，扩展仍重新采集当前 AX tree、校验 document/frame 身份，并通过 `DOM.resolveNode` 得到当前 DOM 对象；普通 `eN + snapshotId` 和 semantic target 继续走原有 Page Agent 路径。

## 10. 分阶段实现

### P3a：真实 AX 只读 adapter（已实现）

- 通过 debugger lease 调用 Accessibility domain；
- 完成主 frame、selector、可验证 child frame 的采集；
- 完成 AX normalization、敏感字段脱敏、预算和 fallback；
- 复用现有 revision 和 compact projection；
- 已加入 mock CDP 与 Edge 隔离真实浏览器 E2E。

### P3b：AX/DOM 内部映射（已实现）

- 使用 `backendDOMNodeId` + `DOM.resolveNode` 做内部映射；
- 绑定 frame、document incarnation 和 observation provenance；
- 支持一次 semantic rebind，并对 ambiguity/changed/detached 返回结构化错误；
- raw AX node id、backend DOM node id 不暴露给模型。

### P3c：AX ref 与交互评估（首轮已实现）

- accessibility snapshot 对可映射的 actionable/focusable 节点生成 `aN`；
- click、double-click、fill、type、press、select、check/uncheck、hover、focus、locator 读取、visible/enabled wait 均通过当前 AX 重新解析；
- DOM 操作前执行 connected、visible、disabled、editable 检查，副作用使用 post-action document fence；
- AX 重绘支持一次语义重绑定，第二次重绑定、歧义、节点改变和不可映射均 fail closed；
- Pi/DSH 保留 state、ref 和 capability contract；
- 后续仍需在目标浏览器重载后完成持续性能和跨域/OOPIF 验收。

## 11. 测试与验收

当前已完成 mock CDP、Edge 隔离 E2E、AX ref action、semantic rebind、output projection 和 capability gate 验证；目标浏览器重载后的持续验收仍是发布后检查项。

### 单元/契约测试

- AXValue scalar、空值、布尔值、mixed state 和 level 规范化；
- role/name/state 字段与 wrapper 过滤；
- password、autocomplete、token、credit-card 等脱敏；
- 节点/字符预算和 `truncated`；
- backend key、frame key、identity 大规模变化时 full fallback；
- `Accessibility.enable`、full tree、partial tree 的命令顺序；
- AX domain 不可用时 DOM fallback；安全错误不被 fallback 吞掉；
- compact Pi/DSH 结果仍保持同一 `full/diff/unchanged` 字段。

### 真实浏览器验收

至少覆盖：

- 原生 button、input、select、checkbox、radio、heading、link；
- `aria-label`、`aria-labelledby`、复杂 role、checked/expanded/disabled；
- hidden、ignored、display:none、密码和敏感表单；
- shadow DOM、同源 iframe、跨域/OOPIF 的安全降级；
- 动态重绘、虚拟列表、节点删除和页面导航；
- selector AX partial tree；
- Chrome 与 Edge 的 debugger lease 性能；
- AX 读取期间 reload、tab close、取消和 Bridge reconnect；
- 普通 snapshot 的 `eN` ref 行为不因 AX 采集改变。

验收底线：真实 AX 采集失败可以安全降级，但不能返回未经 document/frame 验证的节点，也不能让 AX 观察绕过现有副作用 fencing。

## 12. 代码落点

首轮实现尽量不引入新的架构层：

- `extension/background.js`：CDP AX adapter、frame 采集、normalization、fallback 和 revision 输入；
- `pi-extension/output.js`：只在需要展示新增 AX state 时扩展现有纯 projection，不引入第二套 serializer；
- `tests/extension-lifecycle.test.mjs`：lease、fence、fallback 和生命周期测试；
- `tests/e2e-browser.mjs`：真实 Chrome/Edge AX 语义、frame 和动态页面验收；
- `docs/AGENT-BROWSER-RUNTIME-DESIGN.zh-CN.md`、`docs/BROWSER-OUTPUT-COMPACTION-DESIGN.zh-CN.md`：只记录已实现和已批准设计，区分 DOM 派生树与真实 Chromium AX。

Manifest 已有 debugger 能力时不新增依赖；若目标浏览器不支持 Accessibility domain，直接走 fallback。

## 13. 明确保留的取舍

- DOM 派生树保留为 fallback，不继续把它命名成真实 AX；
- P3a/P3b/P3c 保持现有 request/fence/lease 主干，只在 AX observation、内部映射和有限 interaction 分支增加最小实现；
- 不为 Pi 与 DSH 强造统一 schema DSL；
- 不把 AX node ID 当作稳定 ref；
- 不因为接入 AX 就放松 document fencing、tab fence、ownership、cleanup 或副作用不确定性；
- 不为未来 MCP、多 Agent remote bridge 或 universal capability interface 提前写代码。
