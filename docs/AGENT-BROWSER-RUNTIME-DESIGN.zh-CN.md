# Agent-first 浏览器运行时重构方案

> 状态：P0–P2 首轮实现完成；P3（真实 Chromium AX ref）和发布迁移仍待单独评审。
>
> 范围：Chrome/Edge 扩展中的页面观察与交互层；Bridge、tab ownership、turn cleanup 和 debugger lease 保持既有安全边界。
>
> 已实现：幂等 isolated-world Page Agent、每 document 最多 16 份且 30 分钟 TTL 的 observation/ref registry、live original-node resolver、一次唯一 semantic rebind、DOM-CUA 对等规则、document-change 结构化诊断，以及 Edge 和 Chrome for Testing 隔离 profile 真实浏览器回归覆盖。Chrome for Testing 149.0.7827.55 已通过单 profile smoke 和双 profile 路由/重连 smoke；已安装 Google Chrome 仍会拒绝本隔离 harness 的命令行 unpacked-extension 限制参数，因此只用于人工加载 extension 的受控 `test:skill` 集成流程。
> 关联文档：[Codex 对齐默认值](../CODEX-ALIGNMENT.zh-CN.md)、[浏览器运行时生命周期方案](./BROWSER-LIFECYCLE-CODEX-ALIGNED.zh-CN.md)、[架构说明](../ARCHITECTURE.zh-CN.md)

## 1. 背景与问题

重构前，项目已经具备 tab ownership、claim/release、tab fence、document incarnation、CDP、DOM CUA、语义 locator 和 snapshot 等能力；但页面交互仍以“完整 snapshot 是否仍然完全相同”为主要前置条件：

```text
snapshot
  -> snapshotId + 全页 DOM fingerprint
  -> ref 操作前比较当前整页状态
  -> 任意页面变化可能使操作拒绝
```

这会产生不符合 Agent 与用户共同使用浏览器体验的误判：

- 用户从 `tab_a` 切换到 Agent 创建的 `tab_b` 观察过程；
- 页面标题、窗口焦点、visibility 或 tab metadata 更新；
- toast、通知角标、倒计时、异步列表、广告位等无关 DOM 更新；
- 前端框架仅重绘了目标输入框的外层，或重建了语义相同的唯一控件。

上述变化不意味着 Agent 已经处在错误 tab 或错误 document，但现有机制可能因为：

1. `tabs.onUpdated` 对任意 tab 更新清除 snapshot 状态；
2. MutationObserver 对任意 DOM mutation 轮换 snapshot ID；
3. ref 动作要求整页 DOM fingerprint 仍然相同；

而返回泛化的：

```text
Snapshot is stale; take a new browser_snapshot before using this ref
```

这类错误既增加模型调用次数，也会打断用户观察 Agent 的正常操作。更重要的是，它将“界面观察结果”错误地当成了“页面控制授权”。

## 2. 产品方向

本项目的目标不是一个只能执行 CSS/DOM 脚本的远程控制器，而是一个适合 Agent 的浏览器交互运行时：

- Agent 通过人类可理解的页面语义理解界面；
- 用户和 Agent 可以共同使用同一个日常浏览器 Profile；
- 用户切 tab、查看 Agent 页面、标题变化和无关局部刷新是正常路径；
- 工具在动作发生时基于当前 document 的实时 UI 解析目标；
- tab/document 身份变化、动作结果不确定和目标歧义仍然必须安全失败；
- 原生 CDP、DOM CUA 和坐标 CUA 保留为逐级 fallback，而非默认交互模型。

可概括为：

> **Snapshot 是 Agent 的认知状态，不是动作锁；document identity 是安全边界；实时 resolver 决定当前能否安全执行动作。**

## 3. Codex 对齐依据

本机 Codex Chrome 插件公开 API 和配套指导反映出以下使用模型：

- `Tab` 是稳定的控制对象，当前选中 tab 与浏览器 visibility 属于展示/用户体验状态；
- AX 操作以 accessibility element index 或点为目标，不要求调用方携带完整 snapshot version；
- DOM CUA 操作以 `node_id` 为目标，不要求调用方提供整页 snapshot ID；
- Playwright locator 绑定到 tab，在具体 `click()`、`fill()` 时实时解析；
- AX 指导要求在有意义的 UI 操作后重新读取 AX state，以更新模型对当前界面的理解，而不是把旧观察结果当作一票否决的全页锁。

这不意味着可以推断或复制 Codex 私有实现；本方案只对齐其公开行为和交互原则。

## 4. 不变量与术语

### 4.1 硬安全边界

以下状态构成页面操作不可放松的身份边界：

```text
browserId
+ tabId
+ tabFence
+ document incarnation
  (URL + performance.timeOrigin + per-document token)
```

规则：

- browser target 变化时不能继续使用旧 handle；
- tab fence 变化、tab 被关闭或数字 tab ID 被复用时不能继续操作；
- 跨 document navigation、reload、frame 卸载时不能在新 document 自动复用旧目标；
- 有副作用动作执行前后都必须确认 document identity；
- 若 click/fill/type 已可能发生、但执行上下文在结果返回前丢失，结果为 `BROWSER_OPERATION_UNCERTAIN`，不得自动重放。

### 4.2 软 UI 变化

以下变化本身不应使同一 document 中的 ref 或 locator 失效：

- tab title、favicon、audible、pinned 等 metadata 更新；
- 用户选择另一个 tab、切换窗口焦点或查看 Agent tab；
- `visibilitychange`、focus/blur；
- 无关 DOM 区域更新；
- 布局变化、滚动、通知、倒计时、异步状态刷新；
- 后续 observation/snapshot 的产生。

软变化可以使模型需要重新观察界面，但不能直接授权运行时拒绝一个已证明仍指向正确元素的动作。

### 4.3 Observation、Ref 和 Resolver

- **Observation**：一次 snapshot、AX state 或 visible DOM 读取，是模型理解界面的有界表示。
- **Ref**：由某次 observation 暴露的目标引用，例如兼容期内的 `e12`。它是目标来源/provenance，不是整页版本锁。
- **Resolver**：在当前同一 document 内，把 ref、AX ref 或 semantic target 解析为一个唯一可操作元素的运行时组件。
- **Rebind**：原 DOM node 已被框架替换时，resolver 依据保存的语义描述在同 document 内寻找唯一等价目标的过程。

## 5. 目标架构

```text
Pi / DSH browser_* tools
          |
          v
Bridge request routing
          |
          v
Extension background control plane
  - browser target / tab fence
  - ownership / lifecycle / cleanup
  - document pre/post fencing
  - request serialization / uncertainty policy
          |
          v
Per-document Page Agent (isolated world)
  - document context
  - observation store
  - ref registry
  - AX / semantic resolver
  - actionability checks
  - interaction executor
          |
          v
Current page DOM / Chromium AX / CDP fallback
```

### 5.1 Background control plane 的职责

`background.js` 保留并集中处理：

- Bridge 连接、请求分发、能力协商；
- browser target、tab fence、ownership、claim/release、group、cleanup；
- document incarnation 的动作前后校验；
- debugger lease、CDP、Network、Dialog、Download 等浏览器级能力；
- 请求取消、动作不确定性和 session 串行化；
- Page Agent 注入、可用性确认和跨 document 生命周期。

Background 不再维护“整页 DOM 必须完全相同”的页面交互规则。

### 5.2 Per-document Page Agent 的职责

每个可脚本化 document 在 extension isolated world 中拥有一个 idempotent 的 Page Agent。P2 首轮已由它持有 bounded snapshot/DOM observation registry；snapshot、page operation 和 DOM-CUA 的注入函数复用该 registry。后续再逐步把解析与执行代码收敛为 Page Agent 的内部模块。目标职责为：

- 输出语义 snapshot、AX observation、visible DOM；
- 为每份 observation 建立 bounded ref registry；
- 保存原 DOM node、语义描述及无敏感值的匹配信息；
- 对 ref、AX ref、role/name、label、placeholder、testId、CSS 等目标做实时解析；
- 检查 visible、enabled、editable、connected、唯一性；
- 在动作开始前进行最多一次受控 rebind；
- 执行页面内 click/fill/type/press/select 等操作；
- 返回结构化结果和当前 document generation。

建议通过独立 `page-agent.js` 文件注入，并以一个很小的 executeScript command bridge 调用其已注册的运行时方法。这样可避免多个注入函数中重复实现 role、label、fingerprint、visible 和错误处理逻辑。

### 5.3 Document 生命周期

```text
new document
  -> inject / initialize Page Agent
  -> observe
  -> retain bounded RefRecords
  -> interact / resolve live targets
  -> document navigation or unload
  -> background 收到 loading/URL/discard lifecycle event 后立即标记旧 observation 不可操作；对尚未到达 lifecycle event 的导航请求使用短暂 fallback 标记，避免旧 document 尚未 unload 的竞态。isolated-world state 随后自然终止。background 重置 document-bound CDP/AX 状态，并保留有容量上限的 observation provenance，供旧 ref 返回 `BROWSER_DOCUMENT_CHANGED` 而非泛化 stale 错误
```

Service Worker 重启不应默认等于 document 失效。Background 可重新查询当前 document generation；若 Page Agent 仍能证明 ref 的来源和 document identity，则可继续使用。无法证明时安全失败，而不是猜测。

## 6. Ref Registry 与 live resolver

### 6.1 RefRecord

每一个对模型暴露的 ref 在 Page Agent 内部对应一个 `RefRecord`：

```ts
interface RefRecord {
  observationId: string;
  documentIdentity: {
    url: string;
    timeOrigin: number;
    token: string;
  };
  originalElement: WeakRef<Element> | Element;
  rebound?: boolean; // once true, this observation never rebinds again
  semanticDescriptor: {
    tag?: string;
    role?: string;
    accessibleName?: string;
    label?: string;
    placeholder?: string;
    testId?: string;
    id?: string;
    name?: string;
    selectorCandidates?: string[];
    visibleIndex?: number;
  };
  constraints: {
    editable?: boolean;
    actionable?: boolean;
    inputType?: string;
  };
  createdAt: number;
}
```

实现要求：

- registry 必须有容量和 TTL；当前实现为每个 document 最多保留最近 16 份 observation，TTL 为 30 分钟；
- 不记录或对外暴露密码、token、OTP、信用卡号等敏感 value；
- `originalElement` 优先使用 `WeakRef`；不支持时允许小容量强引用并及时 prune；
- ref 的内部键应包含 observation identity，避免不同 observation 中同名 `e12` 冲突；
- 对外继续兼容 `ref + snapshotId`，但不再把 snapshotId 解释为“当前页面唯一版本”。

### 6.2 解析顺序

动作前的目标解析算法：

```text
验证 tab fence + expected document identity
  ↓
读取 RefRecord / AXRefRecord / semantic target
  ↓
原 node 是否仍 connected、属于当前 document、且满足语义约束？
  ├─ 是：使用原 node
  └─ 否：在同一 document 做一次受控 live rebind
            ↓
            依据 role/name/label/placeholder/testId/selector 等描述寻找候选
            ├─ 唯一且等价：使用 rebind 后的 node
            ├─ 0 个：ELEMENT_TARGET_NOT_FOUND 或 ELEMENT_TARGET_DETACHED
            └─ 多个：ELEMENT_TARGET_AMBIGUOUS
  ↓
检查 visible / enabled / editable / action-specific conditions
  ↓
在同一 page-agent command 内执行动作
  ↓
Background 校验执行后的 document identity
```

### 6.3 Rebind 的安全约束

允许 rebind 必须同时满足：

- document identity 未变化；
- 候选元素唯一；
- 候选语义与原记录一致或具有可解释的强等价关系；
- 对 `fill`，候选仍是正确类型的 editable field；
- 对 click，候选仍具有相同 role/name/关键属性；
- 每个 observation/ref record 最多只可 rebind 一次；成功后将 replacement 记为当前目标，后续再次 detach 必须重新 observation；
- 不在动作已开始、结果不确定后重试；rebind 仅是动作开始前的目标解析。

禁止：

- 跨 navigation、reload 或 document replacement rebind；
- 仅凭坐标、DOM 序号或模糊文本猜测替换元素；
- 匹配多个候选后自动选择第一个；
- 在 `BROWSER_OPERATION_UNCERTAIN` 后自动重放 click、fill、submit、download 或 upload。

### 6.4 snapshotId 的迁移语义

兼容期内：

```text
snapshotId + eN
```

表示“从特定 observation 获得的 ref record”，而不表示“此刻完整 DOM 必须与 observation 完全一致”。

因此：

- 产生新 snapshot 不自动作废旧 ref；
- 同 document 中无关 UI 变化不自动作废旧 ref；
- 原 node 保持时直接使用；
- 原 node 重建时仅在唯一、强等价条件下 rebind 一次；
- document 改变、registry 已 prune、目标被删除或出现歧义时才失败。

后续可引入不与 `eN` 序号耦合的 opaque ref token；在对外工具契约稳定后再决定是否迁移展示格式。

## 7. Observation 与 AX-first 策略

### 7.1 第一阶段：统一 semantic observation

短期先统一现有 DOM 派生的：

- role；
- accessible name；
- label；
- placeholder；
- testId；
- visible / enabled / editable；
- 有界页面文本与截图。

普通 `browser_snapshot` 可以继续返回 `[ref=eN]`，但其 ref 由 Page Agent 的 live resolver 支持。

### 7.2 第二阶段：真实 Chromium Accessibility Tree

为更接近真正的人机交互模型，后续通过已有 CDP/debugger 能力评估并接入：

```text
Accessibility.enable
Accessibility.getFullAXTree
Accessibility.getPartialAXTree
DOM.resolveNode
```

目标是使 `browser_accessibility_snapshot` 输出真正的 AX 节点和可操作 AX ref：

```text
- textbox "Email" [ref=a17]
- button "Continue" [ref=a18]
- checkbox "Remember me" checked=false [ref=a19]
```

真实 AX tree 接入前必须验证：

- iframe / cross-origin frame 对应关系；
- backend DOM node ID 的生命周期；
- AX value 中的敏感信息过滤；
- 页面动态重绘后的 AX ref rebind；
- debugger lease 与常规页面操作的性能和并发影响。

### 7.3 Agent 的默认交互梯度

```text
AX ref / semantic target
  -> live Playwright-style locator
  -> observation ref record
  -> DOM CUA
  -> coordinate CUA
  -> narrowly scoped browser_evaluate / CDP
```

越靠前越接近人类所见语义；越靠后越偏工程兜底。CDP 不应替代常规页面交互。

## 8. 事件与失效策略

### 8.1 tabs.onUpdated

不再因为任意 tab update 清空 observation/ref 状态。仅在可能更换 document 的事件重置 document-bound 系统或重新验证，例如：

- `changeInfo.url`；
- `changeInfo.status === "loading"`；
- tab discarded 且 document 已不可用；
- tab replacement、tab removal；
- 已验证的 document incarnation 改变。

Page Agent 的 live registry 会随旧 document 自然终止；background 则仅保留最近 16 份 observation 的 document provenance，用于把跨 document 的旧 ref 安全地报告为 `BROWSER_DOCUMENT_CHANGED`。`title`、favicon、active、audible、pinned、窗口焦点等变化不属于 ref 失效事件。

### 8.2 MutationObserver

MutationObserver 不再负责轮换 snapshot ID 或使 ref 自动失效。

它可以用于：

- observation diff 提示；
- AX/语义状态更新提示；
- 有界 UI dirty 标记；
- 诊断和测试。

它不能直接作为拒绝 click/fill/type 的依据。动作是否可执行由 live resolver 对实际目标的检查决定。

### 8.3 错误模型

保留 `STALE_SNAPSHOT` 仅用于无法解释的 legacy/registry provenance 失败；新的主要错误应表达可恢复原因：

| 场景 | 建议错误码 |
| --- | --- |
| tab 已关闭 | `BROWSER_TAB_CLOSED` |
| tab fence / browser target 改变 | `BROWSER_TAB_FENCE_CHANGED` / `BROWSER_TARGET_MISMATCH` |
| document 已替换 | `BROWSER_DOCUMENT_CHANGED` 或现有不确定性契约 |
| 原 node 被删除且不能重定位 | `ELEMENT_TARGET_DETACHED` / `ELEMENT_TARGET_NOT_FOUND` |
| rebind 出现多个候选 | `ELEMENT_TARGET_AMBIGUOUS` |
| 元素不显示、禁用或不可编辑 | `ELEMENT_TARGET_NOT_FOUND` / `ELEMENT_TARGET_DISABLED` / `ELEMENT_NOT_EDITABLE` |
| 动作期间 document 丢失 | `BROWSER_OPERATION_UNCERTAIN` |

错误 details 应只包含安全的原因、tab ID、是否发生 rebind、候选计数和下一步，不暴露敏感页面内容。

## 9. 对外工具与能力协商

现有工具优先保持兼容：

```text
browser_snapshot
browser_accessibility_snapshot
browser_fill
browser_click
browser_double_click
browser_type
browser_press_key
browser_locator
browser_wait
browser_dom_cua
```

新增 extension capability：

```json
{
  "liveRefs": true,
  "semanticRebind": true,
  "axRefs": false
}
```

迁移策略：

1. 新扩展声明 `liveRefs` 和 `semanticRebind`；当前实现也显式声明 `axRefs: false`；
2. `snapshotId + eN` 的请求格式不变，因此 Pi/DSH 不必为了新行为切换 wire dialect；它们可通过 capability 做诊断、升级提示或后续策略选择；
3. 旧扩展继续保持 legacy strict snapshot 行为，宿主不把 `liveRefs` 作为兼容请求的强制前置条件；
4. 真正 AX ref 完成后再声明 `axRefs`；
5. 兼容期内 `snapshotId` 继续接受，空值按现有参数清理规则处理。

动作成功结果可增加非敏感诊断字段：

```json
{
  "ok": true,
  "resolvedBy": "original_ref",
  "rebound": false
}
```

或：

```json
{
  "ok": true,
  "resolvedBy": "semantic_rebind",
  "rebound": true
}
```

如果页面 action 已返回成功 envelope，且随后读取到一个有效但不同的 document identity，结果仍是已完成；可额外带上：

```json
{
  "ok": true,
  "postActionDocumentChanged": true
}
```

这表示动作已被确认发出、随后观察到页面转换；只有注入结果或 post-action document identity 无法验证时才返回 `BROWSER_OPERATION_UNCERTAIN`。这些字段用于调试、测试和逐步评估 rebind 行为，不应强迫模型依赖它们完成普通任务。

## 10. 代码重构边界

不建议在一次改动中重写所有 extension 逻辑。

### 保持稳定的部分

- Bridge 协议与 browser target routing；
- tab fence 和 document incarnation；
- ownership、claim/release、group、cleanup；
- debugger lease、Network、Console、Dialog、Upload、Download；
- Pi/DSH 工具注册、Skill activation 与 turn 生命周期。

### 优先拆分的部分

当前 `extension/background.js` 中应逐步从请求分发中提取：

- snapshot 收集；
- accessibility/semantic 收集；
- page operation；
- DOM CUA；
- 可见性、role/name/label 解析；
- ref/fingerprint/MutationObserver 状态。

建议的新文件：

```text
extension/page-agent.js
extension/page/document-context.js
extension/page/observation-store.js
extension/page/ref-registry.js
extension/page/semantic-resolver.js
extension/page/interaction.js
extension/page/dom-cua.js
extension/page/redaction.js
```

实际模块形式需兼容 Manifest V3 的 service worker 与 `chrome.scripting.executeScript` 注入机制；注入文件应保证幂等，并且在 isolated world 中不可被普通页面脚本伪造。

## 11. 实施阶段

### P0：特征测试和回归基线（已完成）

已增加真实浏览器 E2E 场景，确认当前问题并防止回归：

1. `tab_a -> tab_b` 切换后 title 更新，旧 input ref 仍应可 fill；
2. 无关 toast/timer/badge DOM 更新，旧 ref 仍应可操作；
3. 目标属性或语义被改变，必须不误操作；
4. React/Vue 风格替换唯一字段；
5. 替换后出现两个同名字段；
6. navigation/reload/back/forward/tab close；`navigate(wait:false)`、`reload`、`back` 和 `forward` 均返回标记为 `transitionPending` 且 handle 省略不稳定 URL/title 和 incarnation 的 Tab，loading 期间旧 ref 返回 `BROWSER_DOCUMENT_CHANGED`；
7. click/fill 已确认返回且 post-action document identity 可验证时保持成功（可带 `postActionDocumentChanged: true`）；只有注入结果或 post-action identity 无法验证时返回 `BROWSER_OPERATION_UNCERTAIN`，且不重放；
8. Edge 隔离 profile smoke；Chrome for Testing 149.0.7827.55 的单 profile smoke 与双 profile 路由/重连 smoke；人工加载 Chrome 扩展的受控 Skill 集成流程。

### P1：移除整页 stale 依赖（已完成）

- 将 tab update cache invalidation 限制为 document 生命周期事件；
- 删除 MutationObserver 的自动 snapshot ID 轮换；
- 停止以完整 DOM fingerprint 作为 ref 操作前提；
- 保留 tab/document pre/post fencing；
- 对 DOM CUA 应用同一失效原则；
- 保持当前工具输入输出兼容。

P1 直接解决 title、tab focus 和无关 DOM 变化引发的误判。

### P2：Page Agent 与 live ref resolver（首轮已完成）

- 引入 Page Agent 和 bounded RefRegistry；
- 原 node 直达、一次受控 semantic rebind；
- 统一 snapshot、page operation、locator 和 DOM CUA 的页面内逻辑；
- 返回细粒度错误和可选 rebind 诊断；
- capability negotiation 与 Pi/DSH adapter 测试。

P2 是 Agent-first 交互模型的核心实现。

### P3：真实 AX adapter（待评审）

- 评估并实现 Chromium AX tree；
- 暴露 AX ref；
- 实现 AX diff、敏感内容过滤与 frame 处理；
- 让 AX/semantic target 成为工具和 Skill 的默认推荐路径。

### P4：文档、迁移与发布（进行中）

- 更新 Skill、README、FEATURES、错误恢复说明；
- 标记 legacy strict snapshot 路径；
- 增加 release note 和 upgrade 指南；
- 在真实 Pi、DSH、Chrome、Edge 环境完成验收（Edge 隔离 smoke、Chrome for Testing 149.0.7827.55 的单/双 profile smoke，以及人工加载 Chrome 的 Skill 集成流程均已通过）。

## 12. 测试与验收

### 单元测试

- RefRegistry TTL、容量、observation ID 隔离；
- original node 命中、detached、rebind 成功和 ambiguity；
- 语义描述不记录敏感 value；
- `tabs.onUpdated` title-only 不清 ref，navigation 才清理；
- new observation 不自动清旧 RefRecord；
- tab/document fence 和 post-action uncertainty 不退化。

### 扩展集成测试

- Page Agent 注入幂等；
- Service Worker 重启后的 document/ref 重新验证；
- request cancellation 与 live resolver 不会使副作用重放；
- ownership/session 边界不因 ref rebind 绕过；
- 旧 extension capability 不会收到新协议假设。

### 真实浏览器 E2E

| 场景 | 预期 |
| --- | --- |
| 用户切 tab、title 更新 | 原 ref 可操作 |
| 无关 DOM 更新 | 原 ref 可操作 |
| 同语义唯一字段被框架重建 | 一次安全 rebind 后成功 |
| 同名字段变为多个 | 返回 ambiguous，不猜测 |
| 原字段删除 | 返回 detached/not found |
| navigation/reload/back/forward | 不跨 document rebind；`navigate(wait:false)`、`reload`、`back` 和 `forward` 返回标记为 `transitionPending` 且 handle 省略不稳定 URL/title 和 incarnation 的 Tab，调用方必须等待/重新观察；即使调用方不等待 navigation/load，旧 ref 也不能在 loading 期间执行 |
| 动作已发出后检测到 navigation | `BROWSER_OPERATION_UNCERTAIN`，不重放；若 click 在导航可观察前已成功返回，则报告成功而不将其伪称为不确定 |
| 用户观察 Agent tab | 不影响指定 tab 的控制身份 |
| 密码/敏感字段 | 不在 observation、error 或诊断中泄露 |

## 13. 风险与待决策项

1. **真实 AX tree 的性能与兼容性**：需要先验证 debugger attach 成本、iframe 和浏览器版本差异；P3 不应阻塞 P1/P2。
2. **Rebind 的保守程度**：默认只允许一次、唯一、强等价 rebind；高风险动作可进一步限制策略。
3. **Ref 生命周期**：TTL/容量需要在模型多轮任务、内存占用和安全性之间取平衡。
4. **页面 agent 注入方式**：已在 Edge 和 Chrome for Testing 149.0.7827.55 的隔离启动中验证 `executeScript({ files })` 与 isolated-world global state；仍应在未来 Chrome/Edge 版本、navigation 与 worker restart 组合中持续回归。当前 Edge 隔离 profile 已覆盖 `navigate(wait:false)`、reload、back/forward 的 transitionPending 生命周期，并在 Edge `tabs.goBack/goForward` 错报 history unavailable 时以同 tab-fence 的 CDP history entry 做一次受限 fallback。
5. **错误码迁移**：需保持现有消费者对 `STALE_SNAPSHOT` 的兼容，并在能力协商后逐步使用细粒度错误。
6. **测试环境**：真实 Chrome/Edge E2E 是此方案的必要验收，不应只依赖 mock。当前 Edge 隔离 profile、Chrome for Testing 149.0.7827.55 的单/双 profile smoke，以及人工加载 Chrome 的受控 Skill 集成流程均已通过。已安装 Google Chrome 会忽略本 harness 使用的 `--disable-extensions-except` 限制参数，故不将其命令行隔离启动视为 Chrome for Testing 验证的替代品。

## 14. 执行结果与后续决策

已按以下顺序执行：

```text
先做 P0（测试基线）
  -> P1（去除全页 stale 误判）
  -> P2（Page Agent + live resolver）
  -> 单独评审 P3（真实 AX adapter）
```

首轮实现已快速修复当前用户可见问题，同时以低风险方式完成核心交互层迁移；ownership、cleanup、Bridge 与 debugger lease 没有被卷入一次大规模重写。点击触发导航的结果按可验证时序定义：若页面 action 已返回且随后才观察到导航，则 action 是已完成；只有 action 后的 document 身份无法验证时才返回 `BROWSER_OPERATION_UNCERTAIN`，且绝不自动重放。下一步应先在 Chrome for Testing 或等效隔离环境完成 smoke、收集真实使用中的 rebind 诊断，再单独评审 P3 的 Chromium Accessibility Tree 接入。
