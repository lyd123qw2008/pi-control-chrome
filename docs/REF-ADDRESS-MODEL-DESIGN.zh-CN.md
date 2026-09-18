# Ref 地址模型设计（文档级注册表）

- 状态：**待评审**
- 工作树 / 分支：`D:\liuyongdan\code\pi-control-chrome-ref-address` / `feat/ref-address-model`
- 基线：`baaac11`（release/pi-control-chrome-0.7.1）
- 日期：2026-09-18
- 关联：`docs/AGENT-BROWSER-RUNTIME-DESIGN.zh-CN.md`、`docs/REAL-CHROMIUM-AX-DESIGN.zh-CN.md`、`docs/BROWSER-LIFECYCLE-CODEX-ALIGNED.zh-CN.md`

---

## 1. 摘要

**结论：这不是一次地址模型重构，而是把一个 WeakMap 的作用域从"每次快照"提升到"每个文档"，外加解析契约与文档对齐。**

更准确地说：**实现没有兑现它自己已经写进 Skill 的契约。** Skill 明确声明 ref 是 *document-scoped*，而代码是 *snapshot-scoped*；本次改动是**修 bug（兑现既有契约）**，不是重构，也不是引入外部模型。

| 分级 | 内容 | 规模 |
|---|---|---|
| **真改** | `elementRefs` 从快照局部提升为文档级注册表（发号稳定 + 解析不依赖缓存） | 1 处核心，约 60–90 行 |
| **需合并** | 未提交的重试层与既有 `executeWithLocatorWait` 合并为一条解析契约；其中"重试 `STALE_SNAPSHOT`"部分应回退 | 1 处 |
| **已具备，只需对齐** | 有界等待（`:6810-6845`）、可交互过滤（`:4238-4240`）、立即类型化失败（`STALE_SNAPSHOT` 不在重试集内） | 3 处，主要为测试与文档 |
| **保留** | descriptor 唯一重绑（我们相对 Playwright 的实测优势） | 不动 |
| **降级** | 容量上限 16 的 observation 历史：从"正确性前提"降为"provenance 与加速器" | 语义调整 |
| **明确不做** | 在 ref 字符串里编码文档纪元前缀（理由见 §4.6） | — |

上一轮我把根因判为"架构不合理"，实读代码后修正为**"注册表作用域错误"**：稳定身份的机制已经存在（`refFor` + WeakMap），只是它的寿命被拴在了一次快照上。改动面因此小一个数量级。

---

## 2. 背景与证据

### 2.1 症状

1. **文档化的契约与实现不一致。** Skill 明确写着 ref 是 document-scoped：
   - `skills/pi-control-chrome/SKILL.md:18`：`eN` snapshot refs, `aN` Chromium AX refs, and DOM-CUA node ids are **document-scoped observations**. Use the matching `snapshotId`; navigation, reload, document replacement, tab closure, or a changed tab fence is a hard boundary.
   - `.dsh/skills/pi-control-chrome/SKILL.md:69-70`（kernel 版）：**`eN`** page-map refs and **`aN`** Chromium AX refs are **document-scoped**. Pass the matching `snapshotId` with the ref, and re-take the observation after any boundary.
   - `skills/pi-control-chrome/SKILL.md:33`：An `aN` ref is opaque and **valid only with its matching `snapshotId`**.

   而实现是 **snapshot-scoped**（§2.2）。"Pass the matching `snapshotId`" 这条要求存在的唯一理由，就是实现没做到文档承诺的寿命。
2. 实测错误 `STALE_SNAPSHOT: observation_unavailable`。
3. 应用内路由切换（`pushState`）后 handle 失效 —— 已由 0.7.1 三个提交修复（文档身份改为 `document-v2`）。

**判据：为了绕开实现缺陷而写进契约的额外要求，就是这个缺陷的证据。** 本文档的验收对象即第 1 条。

### 2.2 根因（代码级）

- `extension/background.js:3845`：`const elementRefs = new WeakMap();` —— **在快照函数内部创建**。
- `:3850-3854` `refFor(element)`：命中 `elementRefs.get(element)` 则复用，否则 `e${++counter}` 并写回。
- 推论：**同一元素跨快照必然换号**（`e12` → `e30`），因此模型必须把 ref 与 `snapshotId` 成对记忆。
- 而 `ref → element` 的解析依赖 observation 记录（`:4270` `rememberObservation`，`:6116` 定义），该记录是**有容量上限的缓存**（`:15` `PAGE_OBSERVATION_HISTORY_LIMIT = 16`，`:5656`/`:6127` LRU 淘汰），且存活于 MV3 service worker 中。
- 记录消失即报 `STALE_SNAPSHOT`（`:4843`/`:4845`）。

**一句话根因：正确性依赖了一个会消失的缓存。** 这是唯一真正的架构缺陷；其余都是在它之上长出来的补丁（错误分类学、重绑、栏栅）。

### 2.3 Playwright 对照实测（2026-09-18，headless Edge + `playwright-core@1.64.0-alpha-2026-09-14`）

| 场景 | 实测结果 | 对我们的含义 |
|---|---|---|
| 同元素跨快照（无变化） | 8/8 编号**不变** | 类别消失 |
| `pushState` 路由切换 | 旧 ref 仍可用，**56 ms** | 类别消失（我们 0.7.1 才修好） |
| 文档导航 | `e3 → f1e3 → f2e3`，前缀=文档纪元 | 跨文档隔离靠前缀 |
| React 式换节点（同 role/name） | 新号 `e5→e12`，旧 ref 死 → **必须重拍快照** | **我们更强**（唯一重绑可省一次往返） |
| 元素尚不存在 | 选择器 **1 次往返等到 2.9 s**；ref 结构上做不到 | 谓词应当作主地址 |
| `display:none` | 不进快照、**无 ref** | ref 不是完备地址空间 |
| 禁用元素 | 等到超时失败（3 s） | 等待属于解析阶段 |
| 失效 ref 失败体验 | 裸 `locator.click` **20008 ms 超时**；`normalize()` **1 ms** 精确报错 | 预解析是可用性前提 |

原始输出见附录 A，复现见附录 B。

### 2.4 与现状的对照结论

| 我们 | Playwright | 判定 |
|---|---|---|
| ref 身份 = 快照局部 WeakMap | ref 身份 = 元素自身属性 + 文档纪元 | **改** |
| 解析依赖会消失的记录 | 解析不依赖任何侧表 | **改** |
| 立即类型化失败（`STALE_SNAPSHOT` 不重试） | 裸模型 20 s 超时 | **已具备，保持** |
| 有界等待（`:6810-6845`，100 ms 步进） | actionability 等待（5 项检查） | **已具备，扩展** |
| descriptor 唯一重绑 | 无（只能重拍快照） | **保留（优势）** |
| 30 个结构化错误码 | not-found + strict violation | 收敛但**不删除**（兼容政策） |

---

## 3. 目标与非目标

**目标**

1. 同一文档内，同一元素的 ref **跨快照稳定**，使 `snapshotId` 不再是使用 ref 的前提。
2. 解析**不依赖任何会消失的状态**；缓存丢失只降速，不降正确性。
3. 解析失败**立即且有类型**；只有"可能变好"的情况才等待，且等待有界。
4. 谓词（role/name/text/testId）是**主地址**，ref 是精度与降噪的短名。
5. 删除以绕开设计为目的的提示词规则。

**非目标**

- 不 vendor Playwright 的 injected script；不做 CDP relay / Node driver。
- 不改 Codex / DSH 的工具面与数量（与 0.8.0 的 `codex/` → `mcp/` 批次解耦）。
- 不改 tab fence / handle 语义（本次只动页面内元素地址）。

---

## 4. 设计

### 4.1 地址模型

| 地址形态 | 用途 | 何时使用 |
|---|---|---|
| **谓词**（`role`/`name`/`text`/`testId`） | 主地址，动作时重解析 | 默认；元素尚不存在、或需要跨快照引用时 |
| **ref**（`eN` / `aN` / nodeId） | 同一文档内的派生短名 | 从最近一次快照复制；需要消歧或降噪时 |
| **脚本 / CDP** | 逃生通道 | 以上都不表达时 |

三者都必须进入**同一条解析管道**（`chromium_ax` 路径与 `page-agent` 解析共用判定），不允许 ref 走一条更弱或更长的路径。

### 4.2 文档级 ref 注册表（核心改动）

```
documentRegistry = {
  documentIdentity,                          // pageGenerationIdentity()，复用现有实现
  minted:  WeakMap<Element, string>,         // 发号：同一元素 → 同一号
  counter: number,                           // 文档内单调，不复用
  byRef:   Map<string, {                     // 纯缓存，可随时丢弃
             node: WeakRef<Element>,
             descriptor,                     // 现有 descriptorMatches 的输入
             updatedAt
           }>
}
```

三条语义（缺一不可）：

1. **发号稳定**：同一元素跨快照、跨动作得到同一 ref。元素上同时留一个隔离世界标记作为回退查找依据。
2. **解析不依赖缓存**：`byRef` 命中直接用；未命中 → 用标记回退查回元素 → 仍未命中才报类型化 `ELEMENT_TARGET_NOT_FOUND`。**缓存被清空不得改变正确性，只影响耗时。**
3. **文档边界即生命周期**：`documentIdentity` 变化时整体替换注册表；旧 ref 报 `BROWSER_DOCUMENT_CHANGED`（现有码）。

放置位置：与现有 observation 存储同级（`:5655`/`:6126` 附近），复用 `pageGenerationsMatch`/`pageGenerationIdentity` 做边界判定。

**受影响路径（待实现时逐条核对）**：主快照路径（`:3845-3854`、`:4246-4264`、`:3963`、`:4178`）、AX 路径（`:3394` `a${++refCounter.value}`、`:3671`）、DOM-CUA nodeId 路径（`:5342-5395`）。AX 与 nodeId 是否同样要求文档级稳定，列为未决项（§9）。

### 4.3 解析契约（三态）

| 状态 | 触发 | 行为 |
|---|---|---|
| **解析期失败（立即）** | 文档不匹配 → `BROWSER_DOCUMENT_CHANGED`；主文档内无此 ref 且无候选 → `ELEMENT_TARGET_NOT_FOUND`；多候选 → `ELEMENT_TARGET_AMBIGUOUS` | 立即返回，**不等待** |
| **解析期等待（有界）** | 可解析但尚不可操作（未出现 / 不可见 / 禁用），或记录被 LRU 挤掉的**可恢复**缓存未命中 | 等到"可解析 ∧ 可操作"或到界；沿用 `:6810-6845` 的 100 ms 步进与 `remaining` 上界 |
| **派发后不确定** | 副作用已可能发生 | `BROWSER_OPERATION_UNCERTAIN`，绝不重放（现状已正确） |

**禁止项：等待一个不可恢复的失败。** 把 `STALE_SNAPSHOT` 这类"记录没了/文档不对"放进重试集，只会把立即失败变成慢失败。

### 4.4 ref 发放策略

ref 只发给**当下可交互**的元素（可见 ∧ 接收指针事件 ∧ 非 `generic`/`group`/`listitem`）。现状 `:4238-4240` 已基本符合；需核对其余发放点，确保"ref 的含义 = 现在就能动"。

### 4.5 descriptor 重绑的定位

**保留，但重新定位为策略层加速器**：

- 仅在"原节点已脱离 ∧ 存在唯一强等价候选"时重绑，且**只重绑一次**（现状已实现）。
- 必须标注（`resolvedBy` / `rebound`，现状已返回）。
- 它不承担正确性：即使重绑不可用，也必须能退回谓词或明确失败。

理由：Playwright 实测（§2.3）在 React 换节点时必须多一次快照往返；这是我们唯一被实测证明**优于参照实现**的能力。

### 4.6 不引入文档纪元前缀（明确决策）

Playwright 用 `f1e3`/`f2e3` 把文档纪元编进 token。**我们不跟**：

- 跨文档误用已被正确处理（`BROWSER_DOCUMENT_CHANGED`，`:4851`/`:4872`/`:5322`/`:5337`/`:8655`）；
- 改字符串 = 改协议面，消费者与已发文档全部受影响；
- 收益仅是"更早失败"，而 §4.3 已要求立即失败。

### 4.7 错误码

**不删除任何现有码**（仓库既有兼容政策，见 `docs/AGENT-BROWSER-RUNTIME-DESIGN.zh-CN.md:586`：需保持消费者对 `STALE_SNAPSHOT` 的兼容）。目标是：

- `STALE_SNAPSHOT` / `STALE_DOM_SNAPSHOT` / `STALE_AX_SNAPSHOT` 在**正常路径不可达**（注册表存在时不再发生），保留为 legacy / provenance 出口；
- 需要评审是否新增 `ELEMENT_TARGET_NOT_ACTIONABLE`：倾向**不新增**，沿用现有 `ELEMENT_TARGET_DISABLED` / `ELEMENT_NOT_EDITABLE` / `ELEMENT_TARGET_NOT_FOUND`（`:6451` 已有全集）。

---

## 5. 改动清单

| # | 位置 | 动作 | 说明 |
|---|---|---|---|
| 1 | `extension/background.js:3845` | 改 | `elementRefs` 提升为文档级注册表（含 `documentIdentity`、`minted`、`counter`、`byRef`） |
| 2 | `extension/background.js:3850-3854` | 改 | `refFor`：先查 `minted`，未命中发号后写回；元素上留回退标记 |
| 3 | `extension/background.js:4270` / `6116` | 改 | observation 写入注册表缓存；记录缺失不再是硬失败 |
| 4 | `extension/background.js:4843-4851`、`:5329-5337` | 改 | `staleSnapshotError` 降级为"缓存未命中 → 走注册表回退"，仅真正无法解释时报 legacy 码 |
| 5 | `extension/background.js:4246-4264` | 改 | page-map 路径复用同一注册表（消除 `previewRef` 估算与真实发号的分叉） |
| 6 | `extension/background.js:6810-6845` | 合并 | 与未提交的重试层合并为 §4.3 的单一契约 |
| 7 | `extension/background.js:3394` / `:3671` | 待核对 | AX ref 是否同样提升为文档级 |
| 8 | `extension/background.js:5342-5395` | 待核对 | DOM-CUA nodeId 的发放与解析路径 |
| 9 | `tests/extension-lifecycle.test.mjs` | 加/改 | 新增 §7.1 用例；调整 `:2230-2300` 区段的重试语义断言 |
| 10 | `tests/e2e-browser.mjs` | 改 | `:1203`/`:1215`/`:1226`/`:1238`/`:1256` 的 rebind 断言按新契约校准 |
| 11 | 文档面（§6） | 改 | 8 处模型描述与提示词 |

**回退项（当前工作区未提交的改动）**：`git diff` 显示它做了两件事 ——

- (a) 把 `STALE_SNAPSHOT`/`ELEMENT_TARGET_DETACHED` 加入 `executeWithLocatorWait` 的可重试集；
- (b) 新增 `runPageOperationResolvingTargets`，为三条 `executePageOperation` 路径补上有界等待。

**判定：(b) 保留并合并；(a) 回退** —— 在新模型下"记录没了"不再需要等待，而是立即走注册表回退路径；把它放进重试集正是 §4.3 的禁止项。

---

## 6. 消费者面与文档（必须同批更新）

| 文件 | 现状 | 改成 |
|---|---|---|
| `ARCHITECTURE.md:64` / `ARCHITECTURE.zh-CN.md:242` | "snapshot ref … bounded live observations within their originating document" | ref 为文档级派生短名；解析不依赖 observation 缓存 |
| `README.md:25` / `README-zh-CN.md:69` | 同上 | 同上 |
| `dsh-tool-control-chrome/README.md:60` | 同上 | 同上 |
| `codex/mcp-server.mjs:872`（instructions 字符串） | "Preserve browserId, tabFence, incarnation and **snapshotId**" | snapshotId 不再是使用 ref 的前提；改为"ref 在本文档内稳定，跨文档必须重新观察" |
| `codex/README.md:28` | 同上期望 | 同上 |
| `skills/pi-control-chrome/references/recovery.md:95,97,117`（两份拷贝） | "take a fresh snapshot and narrow the semantic target" | 明确"谓词优先；ref 失效时先试谓词，不要靠重拍快照" |
| `skills/pi-control-chrome/SKILL.md:18`、`:33` | 声明 ref 为 document-scoped，却要求 "Use the matching `snapshotId`" | 去掉"ref 必须与 snapshotId 成对记忆"这半句；文档边界仍是硬边界 |
| `.dsh/skills/pi-control-chrome/SKILL.md:69-70`（kernel 版，发布时同步） | 同上（"Pass the matching `snapshotId` with the ref"） | 同上 |
| `docs/AGENT-BROWSER-RUNTIME-DESIGN.zh-CN.md` | 0.5.x 时代的观测模型 | 追加一节 supersede，指向本文档 |

---

## 7. 测试计划

### 7.1 新增用例（单元 / 生命周期）

1. 同一元素两次快照得到**同一 ref**（当前应失败，修复后通过）。
2. 清空 observation 缓存后，ref 仍能解析（缓存非正确性前提）。
3. 文档变化后旧 ref **立即**失败（<10 ms）且码为 `BROWSER_DOCUMENT_CHANGED`，**不发生等待**。
4. 多候选时拒绝且不取第一个（现有断言保持）。
5. 重绑唯一性与一次性（`rebind_already_used`，现有断言保持）。
6. 禁用/隐藏元素：不进快照 ref 集；通过谓词定位时表现为有界等待。

### 7.2 回归基线

把临时目录的两个探针迁入 `tests/pw-ref-baseline/`（`spike.mjs`、`probe2.mjs`）：

- 手工运行，**不进 CI**（需要 `playwright-core` 与本机 Edge）；
- 用途：每次改动后重新对齐 §2.3 的行为表，防止我们"改回"到与参照实现相反的方向。

### 7.3 既有套件

`npm run test:ci` 全绿 + `npm run test:all`；`tests/e2e-browser.mjs` 需要真实浏览器，按既有流程执行。

### 7.4 真实站点手测

1. npm 站点：SPA 路由切换后连续多步操作，**全程不重拍快照**。
2. Jenkins：表单填写 + 多次点击，跨动作复用同一批 ref。
3. 长会话（>16 次快照）后继续使用早期 ref。

---

## 8. 验收标准（可证伪）

| # | 标准 | 判定方式 |
|---|---|---|
| 1 | `skills/pi-control-chrome/SKILL.md:18` 与 kernel 版 `:69-70` 中 **"Use/Pass the matching `snapshotId`"** 这半句可删除（ref 在同一文档内自带身份），删除后连续多步操作仍成立 | 步骤 7.4 手测通过 |
| 2 | 同一元素跨 ≥5 次快照得到**同一 ref** | 7.1.1 |
| 3 | 清空缓存后 ref 仍可解析 | 7.1.2 |
| 4 | 文档切换后旧 ref **<10 ms** 类型化失败，且不消耗等待预算 | 7.1.3 计时断言 |
| 5 | 连续 N 次动作共用同一快照，不重拍 | 7.4.1 |
| 6 | AX 与 DOM-CUA 路径行为一致（或明确记录为暂不支持） | §9 未决项结论 |

---

## 9. 风险与未决问题

| 风险 / 未决 | 说明 | 处置 |
|---|---|---|
| AX ref（`aN`）与 DOM-CUA nodeId | 契约（`SKILL.md:18`、`:33`）已声明其为 document-scoped，实现同样按快照发号 | 实现前先读 `:3394`/`:3671`/`:5342-5395`，再决定是否同批兑现 |
| `byRef` 的内存 | 强引用会阻止 GC | 用 `WeakRef` + 容量上限；上限只影响速度 |
| 缓存未命中时的回退查找成本 | 元素标记回退需要遍历 | 先测成本；必要时仅对"最近 N 个 ref"启用 |
| 错误码不可达但保留 | 消费者可能仍在分支处理 | 不删除，仅使正常路径不可达；文档标注 legacy |
| 与 0.8.0 批次的关系 | `codex/` → `mcp/` 重命名、默认面变更需原子落地 | **本分支独立**，可先合并；两批互不依赖 |
| 未提交改动的去留 | (a) 回退、(b) 保留 | 见 §5 |

---

## 10. 实施顺序与提交切分

| 提交 | 内容 | 验证 |
|---|---|---|
| 0 | 探针迁入 `tests/pw-ref-baseline/` | 手工跑通，记录基线 |
| 1 | 文档级注册表（发号稳定 + 解析不依赖缓存） | 7.1.1 / 7.1.2 + `test:ci` |
| 2 | 解析契约合并（含未提交 (b)，回退 (a)） | 7.1.3 / 7.1.6 |
| 3 | 谓词优先：错误路由 + 文档与提示词（§6） | 手测 7.4 + Skill 规则删除 |
| 4 | 错误码与既有测试校准（§5 #9/#10） | `test:all` + e2e |

每步独立可回退；提交 1 完成即可验证核心收益（验收 2、3、5）。

---

## 附录 A：Playwright 实测原始输出（要点）

```
[M2.ref-stability-across-snapshots] 8/8 same
[M4b.ref-after-label-change]  {"before":"e4","after":"e11","numberReused":false}
[M5b.ref-after-node-replacement] {"before":"e5","after":"e12","numberReused":false}
[M6c.old-ref-after-pushstate] OK in 56ms
[M7d.refs-on-new-document] {"heading:Second":"f1e2","button:Second":"f1e3"}
[A2.prefix-after-2nd-nav]  {"stable2":"f2e3"}
[M10b.selector-autowait-nonexistent] OK in 2942ms (element appears at ~2500ms)
[D2.raw-locator-on-dead-ref]  FAIL in 20008ms :: locator.click: Timeout 20000ms exceeded.
[D3.normalize-on-dead-ref]    FAIL in 1ms :: locator.normalize: No element matching aria-ref=f2e6
```

## 附录 B：复现命令

```powershell
# 临时目录（当前）
$d = Join-Path $env:TEMP 'pw-spike'
npm --prefix $d i playwright-core@1.64.0-alpha-2026-09-14
node "$d\spike.mjs"
node "$d\probe2.mjs"
```

前提：本机安装 Edge（`channel: 'msedge'`），无需下载浏览器。
