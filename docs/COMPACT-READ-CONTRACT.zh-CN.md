# 紧凑读取契约（Compact Read Contract）

本文件规定所有进入模型上下文的浏览器读取结果的形状与预算纪律。它替代此前"按站点排序、挑主对象"的做法，改为 **确定性顺序 + 显式寻址 + 可检索省略**。

适用面：`browser_status`、`browser_tabs`、`browser_snapshot`、`browser_accessibility_snapshot`、`browser_extract`、`browser_dom_cua`、`browser_wait`、`browser_doctor`。

## 1. 三条根本原则

1. **不做主观排序。** 插件不判断"谁是页面主角"。页面结构按**文档顺序**输出；"我关心哪一块"由调用方用 locator/ref/selector 表达 —— 与 Playwright 的模型一致：它没有页面理解，只有 locator 与 aria 快照。
2. **有界读取必须可检索。** 任何被预算裁掉的内容，都必须同时给出：省略计数、可再次寻址的句柄、明确的展开路径。缺任一项即为缺陷。
3. **一次响应里同一事实只出现一次。** 连接身份、目标身份、句柄字段不在嵌套块里重复；诊断信息不进入成功路径。

## 2. 页面读取（snapshot / extract / dom_cua）

### 2.1 中性摘要（pageMap v2）

```text
Page: <title>
URL: <url>

Status:
- <role=status 区域文本>

Values:
- revision: abc123
- branch: dev

Regions (document order):
- content "Deployment build" (controls=320, items=18, values=6) [ref=e1] {selector=#root}
  controls: button "New session" [ref=e2], button "Search sessions" [ref=e5]
  values: revision=abc123, branch=dev
  text: Deployment build · Build #704
- navigation "Navigation" (controls=160) [ref=e4] {navigation "Navigation"}
- main "Deployment build" (controls=2, values=3) [ref=e6] {selector=#page-map-form}
  values: revision=abc123, change summary=change-change-…

Omitted: 1 region, 222 controls, 0 fields → narrow with browser_snapshot({ target }) / browser_extract({ selector })
```

规则：

- 区域**按文档顺序**，没有分数、没有 `Primary`、没有 `Key actions`。同一个页面在同样的 DOM 下必须得到同样的输出。
- 候选集合是机械的、可复核的：语义 landmark（`main/dialog/article/form/pre/table/section/aside/nav/...`）加上带显式 `id`/`data-testid` 的**非交互容器**（不含叶子控件，否则表单页每个输入框都会变成一个"区域"）。不按内容打分。
- 抑制规则只有两条，都与内容好坏无关：`main`/`dialog` 代表其内部全部内容（内部候选不再单列）；某个子候选若与已列出的祖先"暴露完全相同的控件数"，则视为冗余包装而不重复列出（例如 `<section>` 与它唯一的 `<aside>`）。因此嵌套区域可能同时出现，每个区域的明细受**全局预算**约束（控件 ≤24、值 ≤12、每区域文本 ≤3 行）。
- 每个区域带 `role`、`name`（取页面自身的 aria-label/title/heading/id，不推断），并在可寻址时带 `address`：优先 `{ role, name }`，其次页面自身提供的稳定 `id`/`data-testid` 选择器；再否则只给 `ref`。
- 重复容器（导航、历史、列表、表格）**只给计数不展开**（`controls=160`），符合 Playwright aria 快照对重复项的截断方式。
- `values` 只发布页面自己渲染的 `label: value` 对（上限 12），不做字段名归一化、不推断领域字段。除凭据词汇外，还有三条**结构**约束（与站点无关）：
  - label ≤ 32 字符，且不含句末标点（`。！？.!?;；,，`）——"terms" 不像句子；
  - 从自由文本**推断**出来的对：value 非空、≤ 120 字符，且**不得读起来像句子**（不以句末标点结尾、不含"句末标点 + 空白"的断句）；
  - 页面**自己声明**为数据的对（表格行、`dt`/`dd`）：value ≤ 320 字符。
  于是 `- confirmed: the plugin resolves ... node_modules.` 这类正文行不再进入 `Values:`，而 `Revision: abc123`、`Change summary: …` 保留。**声明对优先于推断对**：两者都在各自类别内保持发现顺序，但输出时声明对在前，避免正文里像 `label: value` 的行把页面真正的表格/`dt` 数据挤出预算。
- **同一对不在区域之间重复**：区域是嵌套/重叠的，真实构建页曾把 2 个事实打印 8 次。文档顺序上**第一个**发布的区域保留该对，后代区域不再重复（读者缩放到该区域时仍会拿回它，因此不损失可检索性）。页面级 `Values:` 是**刻意的聚合视图**（≤12 条，用于不扫区域就能取到关键事实），因此它会与首个区域各出现一次——这是本契约里唯一允许的重复。
- `text` 只取渲染文本（`innerText`），最多若干行；内联脚本与 `textContent` 永不进入。
- 不设置 `Primary`：需要"当前关注区域"的调用方，自己用 `target`/`ref`/`selector` 指定。

### 2.2 省略与展开（必须成对出现）

每个有界读取都要报告：

| 字段 | 含义 |
| --- | --- |
| `omitted.regions` | 因预算未列出的区域数（文档顺序计） |
| `omitted.controls` | 未列出的控件数 |
| `omitted.fields` | 未列出的字段/值数 |
| `omitted.characters` | 被裁掉的字符数（正文/状态行） |
| `recommendation` | `narrow_read` |
| `nextAction` | 应当用来取回上下文的工具名 |

逐工具的省略与展开（同一契约，2026-09-15 落地）：

| 工具 | 省略计数 | 展开路径 |
| --- | --- | --- |
| `browser_snapshot`（页面摘要） | `omitted.regions/controls/fields/characters` | `browser_snapshot({ target })`、`browser_extract({ selector })` |
| `browser_snapshot`（文本/AX 状态） | `omitted.nodes`、`omitted.characters`、`sourceCharacters` | 同一工具的 `selector` / `maxNodes` |
| `browser_extract` | `omitted.characters`、`sourceCharacters` | `browser_extract({ selector, maxChars })`、`scope: "log"` + `logMatch` |
| `browser_console` | `omitted.events`（源侧 `logTotalCount`） | `browser_console({ since: <nextSince> })`、`only: "errors"` |
| `browser_network` | `omitted.requests`（源侧 `requestTotalCount`） | 游标续读或收窄过滤 |
| `browser_tabs` | `omittedTabs` | `browser_tabs({ query, limit })` |
| `browser_accessibility_snapshot`、`browser_evaluate` | **仍是 `truncated` 标志**（见下） | 同一工具收窄参数 |

> 尚未覆盖：`browser_accessibility_snapshot` 的节点/字符省略计数、`browser_evaluate` 的数组项/字段省略计数。两者目前只报 `truncated`（AX 为 `truncated` + `maxNodes`/`maxChars`，evaluate 为 `outputTruncated` + `outputLimits`）。原因是这两条路径的**预算发生在更内层的收集器里**（`normalizeAxNodes` 与 `boundEvaluateValue`），需要在递归裁剪处累计丢弃量后再逐层上抛，属于纯实现工作而非契约缺口；在补齐之前，读者应把 `truncated` 当作"内容不完整"并直接用同一工具收窄参数重读。

展开路径（同一契约递归适用）：

1. `browser_snapshot({ target })` 或 `{ ref }`：把读取范围收窄到该区域，返回**同一形状**的摘要（因此可以逐层深入）。
2. `browser_extract({ selector, maxChars })`：取该区域的文本。
3. `browser_locator({ target, action })`：只取一个要素（count/text/attribute），不读整页。
4. `responseMode: "raw"`：未投影状态，仅用于诊断；仍受扩展侧预算约束。
5. `browser_doctor`：协议与连接层诊断，不用于页面内容。

> 说明：不提供"整页 HTML"输出。模型需要的是缺失的**上下文**，用 locator 缩放到子树即可获得；整页 HTML 会把输入框值与凭据一并灌入上下文。若某任务确实需要 DOM 片段，用 `browser_evaluate` 做有界、只读的定向读取，并在调用的 Skill 内记录该脚本。

## 3. 身份与诊断（status / doctor / tabs）

### 3.1 `browser_status`

模型可见字段仅保留：`state`、`connected`（可选 `ok`、`targetRequired`、`completed`、`retryable`、`userActionRequired`）、`browser`、`extensionVersion`、`browserId`、`profile`、`connectionId`、`connectionGeneration`、`connectedAt`、`capabilityRevision`、`bridge`（摘要）、`targetStability`（决策字段）、`target`（仅失联恢复时）、`targets`（仅要求选择时）、`error`、`recommendation`、`nextAction`、`issues`/`notices`（非空时）与随 `issues` 出现的 `recovery`。

- **身份只打印一次**：`targetStability` 不再重复 `browser`/`browserId`/`profile`/`connectionId`/`connectionGeneration`，只在目标实际变化时带 `previousBrowserId`/`previousConnectionId` 等差异字段；`observedBrowserIds` 只在出现多个目标时保留。
- 不再内嵌 `bridgeHealth`：改为极小的 `bridge: { ok, version, port, extensionConnected, readyTargets }`。目标清单、每请求指标（`observability`）、`userAgent` 一律去 `browser_doctor`。
- 不再输出能力布尔清单：改为一个单调递增的 `capabilityRevision`（扩展侧由 `CAPABILITY_SINCE` 表推导，能力表与修订号不可能漂移）。**宿主门禁仍在内部比对布尔集合**，报错里点名缺失能力；因此线上的兼容性判断没有被削弱，只是不再进入模型上下文。
- 运行时新鲜度：扩展修订号低于宿主所需时，`browser_doctor` 报 `extension_runtime_stale`（失败）；扩展未声明修订号时报 `extension_runtime_unversioned`（notice，不判失败）——因为逐请求门禁仍会以确切能力名失败关闭。

### 3.2 `browser_doctor`

诊断汇聚点：`bridgeHealth`（含 `targets`、`observability` 的 metrics/recovery/leases/recentEvents）、`runtime`（`extensionVersion`、`capabilityRevision`、`requiredCapabilityRevision`、`fresh`、`capabilities`）、`targetStability`、`targets`（仅身份）、`recommendation`、`issues`/`notices`、`recovery`。诊断只在需要时读取；成功路径不再携带。

形状由共享投影 `compactDoctorResult` / `compactBridgeHealth` 产出，**Pi、DSH、Codex 三端共用同一实现**（`pi-extension/output.js`）；运行期判定同样共用 `capabilityRuntime` / `runtimeDiagnosis`，避免"同一契约三处实现"各自漂移：

- 扩展能力映射**只出现一次**，在 `runtime.capabilities`；`bridgeHealth` 只保留 Bridge 自身能力摘要（`compactResponses`）、目标清单身份与可观测性，不再内嵌每目标的 `capabilities`/`userAgent`；
- Bridge 的 `/health` 公开契约不变（仍可读到扩展能力与 UA），被裁掉的是**模型可见投影**里的重复副本；
- 身份（`browser`/`browserId`/`profile`/`connectionId`/`connectionGeneration`）只打印一次；`targetStability` 只在真正变化时带 `previous*` 差异字段。

### 3.3 `browser_tabs`

参数：`query?`（标题/URL 大小写不敏感子串）、`owner?`（`user` / `agent` / `claimed`）、`limit?`（省略即完整列表，硬上限 200 行）、`documentIdentity?`（默认 true；`false` 时只返回带 tab fence 的句柄，不再为探测 document 身份而注入 page-agent）。

- **默认真实且完整**：默认不做截断。曾试过"默认 25 行"，结果把调用方刚创建的 tab 挡在列表之外（bundled CLI 就是靠 `browser_tabs` 找回新建 tab 的）——**静默丢弃行会隐藏调用方正需要的那一行**，这比多花 token 更糟；收窄是调用方的显式选择。
- **过滤在源头完成**：先装配廉价字段，再用 `query`/`owner`/`limit` 选出行；只有**被返回的行**才可能探测 document 身份（即注入 page-agent）。被过滤掉的标签页不会被触碰。
- 结果同时给出 `totalTabs`、`matchedTabs`，只有显式 `limit` 或 200 行硬上限真正截断时才给出 `omittedTabs` 与 `nextAction: "browser_tabs"` / `recommendation: "narrow_tab_query"`（可检索省略，同 §2.2）。
- 参数带 `query`/`owner` 时回显 `filters`，便于续读时复用同一收窄条件。
- 内部调用方（`tabEntryFor`、创建后的所有权校验）直接调 `listTabs()`，同样完整，不受工具参数影响。

## 4. 预算纪律（所有工具）

1. 成功路径不带诊断字段。
2. 嵌套块不重复顶层身份；需要引用时用 id/ref，不复制整个对象。
3. 列表默认给清单；句柄、原始状态按需请求。
4. 每个投影走同一个 helper，禁止各工具各自扩展字段。
5. 新增能力不改变已有响应的形状，只增加 `capabilityRevision`。

## 5. 兼容与验收

- 页面摘要形状变更记录为 `pageMap.version: 2`；`0.6.0` 未发布，允许直接替换 v1。
- 验收不变量（原型矩阵逐类断言）：
  - 相同 DOM ⇒ 相同输出（确定性；比较时忽略 `ref` 这类观察期句柄，它们在重新观察时可能重新编号）；
  - 输出顺序 === 文档顺序（无排序痕迹）；
  - 页面标题与 URL 永远在顶层；
  - 每个列出的区域可被 `target`/`ref` 再次寻址；
  - 任何截断都带 `omitted` 计数与展开建议；
  - 内联脚本、凭据类标签、输入框敏感值不进入上下文；
  - 句子式正文行不进入 `values`，页面声明的表格/`dt` 数据仍保留；
  - `browser_status` 不含能力布尔清单、不含 `bridgeHealth`/`observability`/`targets`（要求选择时例外），身份字段不重复；
  - 扩展声明的能力集合与派生的 `capabilityRevision` 始终同步（`tests/extension-lifecycle.test.mjs` 直接对源码与状态载荷断言）。
- 矩阵载体：`tests/e2e-browser.mjs` 提供 `/archetype/<kind>` 六类独立原型页，逐类断言上面的不变量——`landmark`（landmark 容器/重复链接计数/确定性/scoped 读回）、`wrapper`（冗余包装只列一次）、`data`（声明对可长、推断对须短且非句子）、`secrets`（凭据与内联脚本不进上下文）、`bulk`（`omitted` + `narrow_read` 可检索）、`hostile`（重复 id、120 层嵌套、20k 文本仍须有界）。新增摘要规则时先加一格原型，再改规则。
- 真实页面读数：`npm run measure:reads -- <build-tab-id> <console-tab-id>` 在真实页面上只读地对比"线上字节数 vs 投影后模型可见字节数"，并等 Bridge 排空后再测（`tests/measure-reads.mjs`，只打印尺寸不打印载荷）。

实测样例（真实 Jenkins 构建页 `#701` 与控制台页，只读，2026-09-15）：

| 读法 | 线上字节 | 模型可见字节 | 耗时 |
| --- | --- | --- | --- |
| `browser_status` | 1140 | **395** | 3 ms |
| 中性摘要 `browser_snapshot`（pageMap compact） | 4443 | **3952** | 179 ms |
| 旧式整页语义读（未投影） | 37175 | 7389 | 151 ms |
| 定向 `browser_extract #main-panel`（600 字符上限） | 1623 | 1623 | 35 ms |
| 控制台 `logMatch "Finished"`（300 字符上限） | 1598 | **1421** | 42 ms |
| 控制台整页读（compact 12k 预算） | 13326 | 13149 | 40 ms |

同一个"构建是否成功、修订号/分支/耗时是多少"的验证问题：**旧路径**（status + 未投影整页读 + 控制台全文）约 21.1 KB；**新路径**（status + 中性摘要 + 定向读 + `logMatch`）约 7.4 KB；**最省路径**（status + 定向读 + `logMatch`）约 3.4 KB。整页 `snapshot` 的**线上**载荷也从 37 KB 降到 4.4 KB——中性摘要同时省了扩展/桥接传输。注意上表全部是只读调用，且"旧式整页读"在页面复杂时会显著变慢（一次实测在排空残留请求时达到 100 s 量级），这也是有界读的价值之一。

整个**验证流程**的对比（`npm run measure:flow -- <detail-tab> <log-url> [selector] [terminalMatch]`，同一天、同一构建 #701、只读）：

| 流程 | 调用次数 | 模型可见字节 |
| --- | --- | --- |
| 穷举式：status + 未投影整页读 + 整页文本 + 整页日志 | 4 | 29,271 |
| 有界式：status + 中性摘要 + 定向区域读 + 日志 `logMatch`（终态 + 失败证据） | 5 | 9,748（**0.33×**） |
| 有界式但省略"先看一眼摘要"（已知页面结构时） | 4 | 5,719（**0.20×**） |

有界式多花一次往返（证据分两次取：终态行 + 失败证据），换来 3 倍字节下降；如果调用的 Skill 已经知道页面结构，直接定向读可以做到 4 次调用、5 倍字节下降。
