# 浏览器工具模型输出压缩与 Codex 对齐实施方案

## 1. 文档状态

本文是 `pi-control-chrome` 浏览器工具输出压缩方案和实现记录，用于说明模型可见结果、扩展侧边界、兼容性选择和发布结果。阶段 A～F 已实现并随 0.5.1 发布，浏览器操作的安全 fencing、快照引用和副作用不确定性语义保持不变。真实 Chromium AX 的 P3a/P3b/P3c 首轮实现已落盘；当前 accessibility 结果优先来自 Chromium AX，明确不可用时回退 DOM 派生 semantic tree，AX ref 受 capability 和 document fencing 约束。

目标发布面包括：Pi Extension、DSH browser tools、Manifest V3 扩展和本地 Bridge。实现优先保持浏览器操作的安全 fencing、快照引用和副作用不确定性语义不变。

## 2. 调研基线

本地 Codex Chrome 插件基线：

```text
C:\Users\liuyd\.codex\plugins\cache\openai-bundled\chrome\26.825.31414
```

重点实现文件：

```text
scripts/browser-client.mjs
scripts/browser-service.mjs
docs/accessibility.md
docs/api-use-behavior.md
```

从当前本地 bundle 可以确认：

- `tab.ax.write()` 是 Codex 页面理解的首选入口，默认使用 accessibility state diff；`disableDiffing: true` 才请求完整状态。
- `captureAX()` 在运行时内部组合 `Accessibility.getFullAXTree`、`DOMSnapshot.captureSnapshot` 和 iframe 信息，再由 `browser-accessibility.wasm.br` 生成 revision；模型主要接收 `rendered` 文本，不接收内部节点映射、frame target 和 revision 表。
- `playwright.domSnapshot()` 使用 `incrementalAriaSnapshot(element, { mode: "ai" })`，然后移除 generic、listitem、group 等包装节点和无意义图片节点。
- `dom_cua.get_visible_dom()` 使用可见元素白名单、属性白名单、字符预算和节点预算。当前 bundle 中的总预算为 20,000 字符和 200 个元素，主页面预留 15,000 字符和 150 个元素，并为 iframe 预留 5,000 字符和 50 个元素。
- visible DOM 的单元素可见文本限制约为 160 字符；脚本、样式、模板、hidden、不可见 viewport 内容不会进入正常结果。
- `playwright.evaluate()` 的结果序列化限制为最大深度 8、数组 2,000 项、对象 200 个字段、字符串 200,000 字符，并处理循环引用和超长字符串。
- `tabs.list()` 只返回轻量的 `id`、`title`、`url`；用户标签页发现结果还包括 `providerTabId`、`lastOpened` 和 `tabGroup`，不返回 favicon Base64 或完整控制句柄。

需要区分两类事实：Codex bundle 中的 AX diff、语义过滤和 visible DOM 预算是当前实现；`maxChars`、`maxNodes`、`selector` 等更细的页面抽取参数在公开资料中部分属于设计提案，不能直接当作所有 Codex Chrome 版本都已经支持的 API。

## 3. 当前实现基线

Bridge 线协议暂时保留兼容所需的结构化字段，内部响应仍可能包含：

```text
tab
snapshot.text
snapshot.elements
snapshot.accessibility
frameTree
```

Bridge 线协议的页面读取响应现在支持显式 `responseMode`：

- `compact`：Bridge 直接返回 bounded model-facing contract；普通 snapshot 只保留 `snapshotId`、`state`、计数、截断标记、viewport 和紧凑 tab identity，不返回 `snapshot.text`、`snapshot.elements`、`snapshot.accessibility` 或 `frameTree`。
- `raw`：仅用于人工/开发者诊断，保留当前兼容字段；不会由 Pi/DSH 默认请求。
- 未指定时保持旧 Bridge 的 raw 兼容行为。新 Pi、DSH 和 Skill CLI 消费者会先通过 health capability 发现 compact 支持；旧 Bridge 上由宿主侧本地 projection 降级。

`responseMode` 仅改变响应表示，不改变请求的 tab fence、document incarnation、snapshot refs、ownership 或副作用不确定性语义。Bridge health 宣告 `capabilities.compactResponses=true`；非法 mode 或对不支持 compact projection 的方法使用 compact 时，以 `INVALID_REQUEST` 拒绝。


扩展 collector 已实现以下边界：

- accessibility 只保留可见的语义节点、表单控件、标题、链接、按钮、可编辑控件和其他可操作节点；无意义 generic 容器不作为独立节点返回。
- accessibility、普通 snapshot、visible DOM CUA、extract、evaluate、Console 和 Network 均设置了源头边界，并在可用时返回计数和 `truncated`。
- accessibility revision 按 tab/document 状态提供 `full`、`diff` 和 `unchanged`；导航、tab replacement、document incarnation 和扩展 runtime 生命周期会清除 revision。
- `browser_snapshot`、`browser_extract`、`browser_accessibility_snapshot` 和 `browser_dom_cua` 支持 selector 或预算参数，参数在扩展侧执行。
- data URL favicon 在扩展侧不会返回；模型 projection 也会删除剩余的 favicon payload。
- Pi 和 DSH 使用紧凑 JSON，screenshot 的模型 details 不再携带 Base64。
- 用户 Tab 的只读页面读取允许一次有限重新观察；仍在 reload 或导航的页面返回可重试的 `BROWSER_PAGE_CHANGING`。click、fill、evaluate、CDP 和其他副作用操作继续使用严格的文档身份校验。
- 自动化验证使用 Agent-owned 测试 Tab 或隔离浏览器 Profile，不使用正在承载 DSH 对话的 GUI Tab 作为稳定 fixture。

当前实测 DSH 页面结果（旧模型输出基线）：

| 部分 | 体积 |
| --- | ---: |
| 格式化工具结果 | 约 880 KB |
| 紧凑 snapshot | 约 822 KB |
| accessibility | 约 743 KB |
| elements | 约 54 KB |
| 页面文本 | 约 23 KB |

主要问题不是 JSON 缩进，而是同时返回了多份页面表示，并且 accessibility 包含大量重复 generic 容器文本。当前实现通过源头筛选、Bridge compact wire response 和模型 projection 消除这两类重复；未指定 `responseMode` 的 raw 字段仍保留给兼容消费者和显式诊断。

## 4. 目标

### 4.1 模型可见目标

普通页面理解结果应满足：

- 一次调用只返回一份主要的模型可读页面表示。
- 默认只返回可见、语义相关或可交互的节点。
- 同一页面重复读取时默认返回 diff 或 unchanged，而不是重复完整文本。
- 所有完整结果都有字符、节点和时间预算。
- 达到预算时返回明确的 `truncated` 标记和计数。
- 操作引用携带来源 observation 的 `snapshotId`，并在当前 document 内由 live resolver 安全解析。
- 页面导航、reload、document incarnation 或 tab fence 变化会使旧引用失效；标题、焦点和无关 DOM 变化本身不会。

### 4.2 内部实现目标

扩展和 Bridge 仍可以保留执行操作所需的内部状态，但内部状态不应自动进入模型结果：

- 当前页的 DOM 元素引用映射；
- frame target 和 loader 映射；
- bounded Page Agent ref registry 和 observation provenance；
- accessibility revision；
- debugger lease 细节；
- raw CDP frameTree。

Bridge 线协议第一阶段可以继续返回兼容字段，Pi/DSH 模型适配器负责投影紧凑结果。源头 collector 仍必须设置边界，避免 Bridge 在适配器之前就生成和传输巨大报文。

## 5. 目标结果

### 5.1 普通 `browser_snapshot`

推荐的模型可见结果：

```json
{
  "tab": {
    "id": 123,
    "title": "订单管理",
    "url": "https://example.test/orders",
    "handle": {
      "tabId": 123,
      "browserId": "edge:...",
      "windowId": 1,
      "tabFence": "tab:...",
      "incarnation": "..."
    }
  },
  "snapshot": {
    "snapshotId": "snapshot-1",
    "mode": "full",
    "state": "- heading \\\"订单管理\\\"\\n- textbox \\\"搜索\\\" [ref=e1]\\n- button \\\"查询\\\" [ref=e2]",
    "nodeCount": 3,
    "charCount": 83,
    "truncated": false
  }
}
```

普通结果不再默认同时包含 `text`、`elements`、`accessibility` 和 `frameTree`。内部仍保留 bounded ref registry，`ref` 操作继续携带匹配的 `snapshotId`，优先解析原 connected node，并只在当前 document 内存在唯一强等价目标时进行一次 rebind。

Bridge 现在可以直接返回上述 compact response；未指定 `responseMode` 的旧请求继续获得 raw 兼容字段。确认所有消费者后，raw 字段是否最终删除仍需另行提高协议版本，不由本次兼容变更隐式执行。

### 5.2 `browser_accessibility_snapshot`

推荐返回单独的 AX 文本结果：

```json
{
  "snapshotId": "ax-2",
  "baseSnapshotId": "ax-1",
  "mode": "diff",
  "state": "+ button \"保存\" [ref=a1]\n~ textbox \"搜索\" value=\"订单\" [ref=a2]",
  "nodeCount": 2,
  "charCount": 72,
  "truncated": false
}
```

模式定义：

- `full`：没有可用的上一版本、页面 incarnation 变化、明确要求完整结果或 diff 成本超过完整结果。
- `diff`：同一 tab fence 和 document incarnation 下，返回新增、删除、变化的语义节点。
- `unchanged`：页面状态没有发生可观察变化，只返回计数和当前 snapshot 标识。

AX diff 的 state 只携带本次新增或变化节点的 `aN`；模型必须保留产生该 ref 的 `snapshotId`，不能把 diff 中的 ref 当作跨 observation 的稳定 id。敏感控件的 value 不进入 children、state、diff 或 locator read 结果。需要未变化节点时，重新请求 `disableDiffing: true` 的完整 AX snapshot，或改用语义 target。

### 5.3 `browser_tabs`

模型可见标签页结果应只保留任务需要的字段：

```json
{
  "browserId": "edge:...",
  "profile": "...",
  "tabs": [
    {
      "id": 123,
      "windowId": 1,
      "index": 4,
      "active": true,
      "title": "订单管理",
      "url": "https://example.test/orders",
      "owner": "user",
      "lifecycle": "",
      "groupId": -1,
      "handle": {
        "tabId": 123,
        "browserId": "edge:...",
        "windowId": 1,
        "tabFence": "tab:..."
      }
    }
  ]
}
```

`favicon` 字段可以暂时保留以兼容旧消费者，但 data URL 必须返回空字符串或短标记，不能返回 Base64。后续确认无消费者使用后可以删除该字段。

## 6. 页面采集设计

### 6.1 语义节点筛选

当前 `collectDomAccessibilitySnapshot()` 是真实 AX 不可用时的 fallback，应按以下顺序处理：

1. 先判断元素是否可见。
2. 只保留显式 ARIA role、隐式语义 role、标题、表单控件、链接、按钮、可编辑控件和其他可操作节点。
3. 没有语义 role 的 generic 容器不作为独立节点返回；其有用文本由页面文本或子节点承担。
4. 名称、可见文本和属性值分别设置上限。
5. 对 password、hidden、token、credential 等字段继续执行现有敏感信息策略。
6. 达到节点或字符预算后停止，并设置 `truncated: true`。

这会保留按钮、输入框、链接、标题、tab、checkbox、combobox 等模型真正需要的元素，同时删除当前最大的重复来源。

### 6.2 统一属性白名单

模型快照只保留以下类型的属性：

```text
role
aria-label
aria-labelledby
name
placeholder
type
href
contenteditable
checked
disabled
selected
expanded
value（经过敏感字段判断）
```

不返回：

```text
style
class（除非后续 selector 诊断确实需要）
完整 outerHTML
事件监听器
脚本内容
computed style
raw frameTree
```

### 6.3 页面文本

普通 snapshot 的页面文本不再作为完整 transcript 使用。建议：

- 默认页面文本上限：8,000 字符；
- 语义状态总上限：20,000 字符；
- 单节点名称或文本上限：160～240 字符；
- 超出时保留开头和必要的末尾提示，并设置 `truncated`。

需要完整正文时使用独立的 `browser_extract`，而不是扩大默认 snapshot。

### 6.4 iframe

主页面和 iframe 共享总预算：

```text
总预算：20,000 字符 / 200 节点
主页面：15,000 字符 / 150 节点
iframe 预留：5,000 字符 / 50 节点
```

iframe 只在可见、已加载且能够验证 parent frame 关系时展开。无法展开的 iframe 返回短 warning，不返回完整调试对象。

## 7. Diff 状态设计

### 7.1 状态键

AX revision 按以下组合隔离：

```text
browserId
runtime instance
sessionId
browser tab id
tabFence
document incarnation
```

导航、tab replacement、document incarnation 变化、扩展 runtime 重启或 session disposal 时清除旧 revision。

### 7.2 节点身份

节点身份只作为内部 diff 键，不直接依赖模型提供的文字：

- 优先使用当前 document 内可验证的 DOM/backend identity；
- 没有稳定 identity 时使用父节点路径、role、ordinal 和局部属性组合；
- identity 大规模变化时放弃 diff，返回新的 `full`；
- Chromium AX 跨读取只使用 backend identity；缺少稳定 identity 时仅保留当前读取的临时 key，并放弃 diff；
- 不因为 diff 失败而复用旧 ref。

### 7.3 Diff 退化规则

以下情况必须返回 full：

- 没有上一版本；
- 页面 URL、tab fence 或 document incarnation 变化；
- 变化节点超过总节点的一半；
- diff 文本不比完整状态更短；
- 当前 revision 无法证明 ref 映射仍然有效；
- 发生 snapshot collector 错误或 iframe 关系无法验证。

### 7.4 unchanged 结果

页面没有变化时不返回页面全文，只返回：

```json
{
  "mode": "unchanged",
  "snapshotId": "ax-3",
  "baseSnapshotId": "ax-2",
  "nodeCount": 42,
  "charCount": 0,
  "truncated": false
}
```

## 8. 各工具输出预算

| 工具 | 默认结果 | 建议默认预算 |
| --- | --- | --- |
| `browser_snapshot` | 紧凑语义状态和当前可操作 ref | 20,000 字符、200 节点 |
| `browser_accessibility_snapshot` | full/diff/unchanged AX 文本 | 20,000 字符、200 节点 |
| `browser_dom_cua` | 可见 DOM 节点 | 20,000 字符、200 节点 |
| `browser_extract` | 正文或 Markdown | 12,000 字符，可显式提高 |
| `browser_tabs` | 轻量标签页 descriptor | 不返回 data URL favicon |
| `browser_status` | 连接、目标和稳定性摘要 | 默认省略 recentEvents |
| `browser_doctor` | 问题、恢复建议和目标摘要 | 详细诊断显式请求 |
| `browser_evaluate` | JSON-ish 值 | 深度 8、数组 2,000、对象字段 200、字符串 200,000 |
| `browser_console` | 有界日志 | 现有单条文本上限，增加总条数和总字符上限 |
| `browser_network` | 请求摘要 | 现有单字段上限，增加总条数和总字符上限 |
| `browser_screenshot` | 图片 attachment | 模型文本不携带 Base64 |

预算应由扩展侧和模型适配器共同执行。扩展侧防止 Bridge 传输巨大结果，适配器侧防止包装字段和格式化 JSON 重新突破预算。

## 9. 模型输出投影

### 9.1 Bridge 与模型层分离

Bridge 可以继续为内部消费者返回完整的结构化结果，但 Pi/DSH 的模型结果必须经过同一套 projection：

```text
raw Bridge response
  -> model-facing projection
  -> compact JSON/text render
```

projection 只能删除模型不需要的调试字段，不能删除操作安全所需的：

- tab id；
- browser id；
- tab fence；
- document incarnation；
- snapshot id；
- 当前可用 ref；
- truncated 和计数。

### 9.2 序列化

模型结果使用紧凑 JSON：

```ts
JSON.stringify(value)
```

而不是：

```ts
JSON.stringify(value, null, 2)
```

人类 UI 的 `/chrome` 命令和调试通知仍可以使用格式化 JSON；模型输出和人类显示不需要共用一种序列化格式。

### 9.3 screenshot

DSH 已经可以将截图保存为 attachment；Pi 应继续返回 image content，但 `details` 中不能重复保存 Base64 数据。模型文本只返回：

```text
Screenshot captured for tab 123.
```

图片内容由独立 attachment 传递。

## 10. 分阶段实施

### 阶段 A：源头止血，保持主要字段兼容（已实现）

修改：

- `extension/background.js`
  - 过滤无 role 的 generic accessibility 容器；
  - 限制 accessibility 名称和文本长度；
  - 给 accessibility、页面文本和节点数量增加 `truncated` 及计数；
  - data URL favicon 不再返回原始内容；
  - DOM CUA 增加总节点和总字符限制；
  - evaluate 增加深度、数组、对象字段和字符串限制；
  - Console 和 Network 读取增加总条数和总字符限制；
  - 把受限/错误页面、注入脚本异常和选择器失败转换为稳定的错误码；
  - 允许没有已返回文档 Handle 的普通用户 Tab 使用只读 `extract`。
- `dsh-tool-control-chrome/src/tools.ts`
  - 模型结果使用紧凑 JSON；
  - `browser_snapshot` 投影掉 raw frameTree 和内部 metadata；
  - screenshot details 移除 Base64；
  - 发送前删除空的可选字段，并为目标不匹配、页面不可用、选择器失败和等待超时返回动作建议。
- `pi-extension/index.ts`
  - 使用同一 projection；
  - 使用紧凑 JSON；
  - screenshot details 移除 Base64；
  - 发送前删除空的可选字段。

验收重点：不改变现有 semantic target、snapshot ref、tab fence 和 uncertain side effect 行为。

### 阶段 B：单一语义 snapshot（已实现）

新增内部 canonical semantic state：

```text
state lines + ref map + counts + truncation
```

普通 `browser_snapshot` 默认输出 `state`，不再输出 `text`、`elements`、`accessibility` 的重复组合。Bridge 通过 `responseMode=compact` 在 wire 层直接提供同一 contract；未指定 mode 的旧请求仍可获得 raw 兼容字段。

### 阶段 C：DOM 派生 semantic revision diff（已实现）

新增每个 tab/document 的 accessibility-oriented semantic revision：

- 第一次返回 full；
- 后续默认 diff；
- 无变化返回 unchanged；
- navigation、fence、incarnation 或 revision 不确定时返回 full；
- diff 结果不自动承诺旧 ref 仍可用。

当前 revision 可由 DOM semantic 或 Chromium AX observation 驱动；只有 `source: "chromium_ax"` 的结果才代表真实 AX observation。AX ref、映射和交互设计见 [REAL-CHROMIUM-AX-DESIGN.zh-CN.md](./REAL-CHROMIUM-AX-DESIGN.zh-CN.md)。

### 阶段 D：按需范围读取（已实现）

为 `browser_snapshot` 和 `browser_extract` 增加可选参数：

```text
selector
maxChars
maxNodes
```

参数在扩展侧执行，而不是只由模型适配器截断。selector 只限定读取范围，不绕过可见性、敏感字段和 snapshot fencing。

### 阶段 E：发布和默认切换（已实现）

Pi 与 DSH 已完成双通道验证，compact projection 作为默认发布行为。发布面同步了：

- 根包版本；
- Manifest 版本；
- DSH 包依赖和 lockfile；
- Profile 解析结果；
- README、Codex 对齐文档和 CHANGELOG。

### 阶段 F：Bridge raw consumer 迁移（已实现并随 0.5.1 发布）

- Bridge health 宣告 `compactResponses`，并校验 `responseMode=compact|raw`。
- Bridge 在响应发送前对 snapshot、Accessibility、extract、tabs、selected tab 和 visible DOM 执行 canonical compact projection。
- 新 Pi、DSH 和 Skill CLI 消费者按能力协商 compact wire response；旧 Bridge 由宿主侧本地 projection 降级。
- Skill CLI 默认不读取 `frameTree`；`--raw` 仅保留给人工/开发者诊断。
- Pi/DSH projection 对已 compact 的结果幂等，保证独立调用方和过渡期 Bridge 的兼容。

## 11. 文件改动清单

当前实现涉及：

```text
extension/background.js
pi-extension/index.ts
pi-extension/output.js
dsh-tool-control-chrome/src/tools.ts
dsh-tool-control-chrome/src/output.ts
skills/pi-control-chrome/scripts/browser.mjs
tests/e2e-browser.mjs
tests/extension-lifecycle.test.mjs
tests/output-projection.test.mjs
dsh-tool-control-chrome/tests/tools.test.ts
dsh-tool-control-chrome/tests/output-projection.test.ts
README.md
README-zh-CN.md
CHANGELOG.md
```

`bridge/server.mjs` 现在负责协商并执行 `compact`/`raw` response mode；`skills/pi-control-chrome/scripts/browser.mjs` 默认使用 compact response，不再读取 raw `frameTree`。显式 `--raw` 仅用于人工/开发者诊断。Pi 与 DSH projection 对已 compact 的 Bridge 响应保持幂等，以兼容旧 Bridge 和独立调用方。

## 12. 测试和验收标准

### 12.1 结构和安全

- 长文本嵌套在多个 generic 容器中时，不重复返回父容器全文。
- accessibility 节点名称不超过配置上限。
- hidden、script、style、template 和密码字段不会进入普通结果。
- data URL favicon 不进入结果。
- evaluate 的循环对象、深层对象和超长字符串按边界返回。
- screenshot 的文本和 details 不重复携带 Base64。
- 空的可选 `selector`、`snapshotId`、`incarnation` 和截图 `path` 不会进入 Bridge 请求。
- 选择器不匹配、注入脚本失败、目标不匹配、受限/错误页面和等待超时返回稳定错误码及下一步建议。
- 未 claim 的普通用户 Tab 没有返回文档 Handle 时，仍可完成只读 `extract`。

### 12.2 页面操作

- 最新完整 snapshot 的 ref 仍然可以 click、fill、type 和 locator 操作。
- 页面变化后旧 snapshot ref 仍然 fail closed。
- navigation、tab replacement 和 document incarnation 变化会清除旧 revision。
- semantic target 的 visible filtering 和 index-after-visibility 行为不改变。
- uncertain side effect 不自动重放。
- 用户 Tab 在读取期间发生文档替换时，只读读取有限重试；重试耗尽返回 `BROWSER_PAGE_CHANGING`，副作用操作仍返回 `BROWSER_OPERATION_UNCERTAIN`。
- 自动化浏览器验证不依赖正在变化的 DSH GUI Tab。

### 12.3 Diff

- 首次 AX 读取返回 full。
- 无变化读取返回 unchanged。
- 修改一个按钮只返回该按钮的 diff。
- 大规模变化自动退化为 full。
- 页面导航后不会把旧页面 diff 当作新页面 diff。
- iframe 增删和不可用状态不会泄露无界调试数据。

### 12.4 体积目标

以当前约 880 KB 的 DSH 长会话页面作为回归样本：

- 普通 `browser_snapshot` 模型结果目标：不超过 120 KB；
- accessibility/AX 状态目标：不超过 20,000 字符，除非显式请求更大预算；
- `browser_dom_cua` 默认不超过 20,000 字符和 200 节点；
- `browser_tabs` 不包含 Base64 favicon；
- unchanged AX 结果只包含状态标识和计数；
- Pi 和 DSH 对同一 Bridge 结果生成等价的模型可见字段。

### 12.5 Bridge 响应协议

- `/health` 宣告 `capabilities.compactResponses=true`。
- `responseMode=compact` 的 snapshot、accessibility、extract、tabs、selected_tab 和 visible DOM 响应不包含对应 raw 数组、页面全文重复字段或 `frameTree`。
- `responseMode=raw` 只通过显式 CLI `--raw` 或开发者请求启用；默认消费者不发送 raw mode。
- 未指定 mode 的旧请求仍获得兼容 raw 响应；非法 mode 或对不支持 compact projection 的方法使用 compact 时返回 `INVALID_REQUEST`。
- compact 响应保留 `browserId`、`connectionId`、`connectionGeneration`、tab handle、snapshot/DOM refs 和计数，且 Pi/DSH 二次 projection 不改变语义。


阶段 A～F 已实现并随 0.5.1 发布，默认的模型和 Skill CLI 页面读取使用 compact response；Bridge raw 字段仍由未指定 mode 的旧请求和显式 raw 调试路径保留。真实 Chromium AX 的 P3a/P3b/P3c 首轮实现已完成，当前实现采用以下决策：

- generic 容器过滤、字段上限和扩展侧预算先于模型 projection 执行，避免大报文在 Bridge 中生成和传输。
- 普通 snapshot 只向 Pi/DSH 暴露单一有界 `state`，ref map、snapshot id 和 fencing 仍由扩展内部维护；交互元素或 AX 节点已经描述页面时，省略的页面全文不会把语义 state 标记为截断。
- AX 读取默认使用 Chromium AX 的 `full`、`diff`、`unchanged` revision；AX domain 不可用时安全回退 DOM semantic tree；需要完整 AX 树时显式传 `disableDiffing: true`；真实 AX accessibility snapshot 的 actionable/focusable 节点可带 `aN`，交互前仍重新解析并执行 document/fence 校验。
- `maxChars`、`maxNodes` 和 `selector` 由扩展执行，projection 作为第二道边界；selector 不绕过可见性、敏感字段和 snapshot fencing。
- 同一个用户 Tab 可能在读取期间被用户或 DSH UI 导航/重载。只读读取最多重新观察一次，连续变化返回 `BROWSER_PAGE_CHANGING`；副作用结果不使用这一重试路径。
- 自动化验证使用 Agent-owned 测试 Tab 或隔离浏览器 Profile；用户明确要求时仍可读取或操作现有用户 Tab。
- `responseMode=compact` 是新 Pi、DSH 和 Skill CLI 的默认页面读取模式；旧 Bridge 未宣告该能力时，宿主侧本地 projection 提供兼容降级。
- raw 字段只为未指定 mode 的旧消费者和显式人工/开发者诊断保留；后续独立删除 raw wire 字段仍需另行提高协议版本，不在本次兼容变更中隐式执行。

0.5.1 的发布、消费者迁移、lockfile、Profile 和 CHANGELOG 已完成。本次 P3a/P3b/P3c 代码位于独立工作树，mock CDP 与 Edge 隔离 smoke 已通过；合并或发布前仍需完成目标浏览器 extension 重载后的持续验收并单独决定版本变更。

## 14. 已确认的评审决策

1. 普通 `browser_snapshot` 的模型结果移除 `accessibility` 和 `frameTree` 字段，只保留单一 bounded semantic state；Bridge compact wire response 同样遵守该边界。
2. `browser_accessibility_snapshot` 默认返回 full/diff/unchanged revision；普通 `browser_snapshot` 保持当前页的完整 compact refs。
3. 普通 snapshot 的页面文本默认上限为 8,000 字符；显式 `maxChars` 仍受扩展硬上限约束。
4. data URL favicon 直接删除，不返回空字符串。
5. `selector`、`maxChars`、`maxNodes` 已加入并由扩展先执行，projection 再执行第二道边界。
6. 保留仅供人工/开发者调试的 raw response：旧请求可省略 mode，CLI 使用显式 `--raw`；新模型消费者不得依赖该路径。
