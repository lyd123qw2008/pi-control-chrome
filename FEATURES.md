# Codex `control-chrome` 功能对齐清单

这份清单用于在开发前确认第一版范围。优先级含义：

- **P0**：第一版必须具备，否则不算可用
- **P1**：第一版建议具备，影响日常体验
- **P2**：后续增强，先保留协议和接口位置

用户可以直接修改复选框、调整优先级或添加备注。

> 实现状态（2026-08-17）：阶段 1/2 核心代码已经完成。当前仓库已实现并验证 Chrome/Edge 扩展、Bridge、Pi 工具、标签页生命周期、完整基础 Locator、DOM/坐标 CUA、原生 CDP、Console、Network、Dialog、Upload、Download、Clipboard 和页面提取。以下复选框保留原始产品规划，不作为当前实现状态的唯一来源；当前能力以 README、架构文档和测试为准。第三阶段能力（多 Profile、WebMCP、GSuite、历史记录、发布包等）仍未实现。

---

## A. 浏览器连接与生命周期

### A1. 浏览器类型

- [x] **P0** Chrome 支持
- [x] **P0** Edge 支持
- [ ] **P1** Chromium/Brave 兼容
- [ ] **P1** 同一 Bridge 同时识别多个浏览器实例
- [x] **P1** Pi 工具中显示浏览器名称、Profile、版本和连接状态

### A2. 扩展与 Bridge

- [ ] **P0** Chromium Manifest V3 扩展
- [ ] **P0** Chrome/Edge 共用一套扩展业务代码
- [ ] **P0** 本地 loopback Bridge（默认只绑定 `127.0.0.1`）
- [ ] **P0** 扩展和 Pi Extension 的握手协议
- [ ] **P0** 随机配对 Token/Session Token
- [ ] **P0** Pi 启动时自动发现和重连扩展
- [ ] **P1** Bridge 断线自动重连
- [ ] **P1** Pi 重启后恢复浏览器连接
- [ ] **P1** Chrome/Edge 扩展 reload 后恢复连接
- [ ] **P1** Bridge 只接受本地扩展连接，拒绝普通网页发起的跨域命令
- [ ] **P2** 多 Pi 会话并行连接隔离

### A3. Pi 命令

- [ ] **P0** `/chrome status`
- [ ] **P0** `/chrome tabs`
- [ ] **P0** `/chrome connect`
- [ ] **P0** `/chrome disconnect`
- [ ] **P0** `/chrome pause`
- [ ] **P1** `/chrome setup`
- [ ] **P1** `/chrome profile`
- [ ] **P1** `/chrome group`
- [ ] **P1** `/chrome release`
- [ ] **P1** `/chrome cleanup`
- [ ] **P2** `/chrome doctor`
- [ ] **P2** `/chrome logs`

---

## B. 标签页、窗口和浏览器分组

### B1. 发现与选择

- [ ] **P0** 列出当前浏览器窗口和标签页
- [ ] **P0** 返回稳定的 `browserId`、`windowId`、`tabId`、标题、URL、favicon 和活动状态
- [ ] **P0** 获取当前活动标签页
- [ ] **P0** 创建新标签页
- [ ] **P0** 选择目标标签页
- [ ] **P0** 明确区分用户标签页和 Agent 标签页
- [ ] **P1** 显示窗口、Profile、分组和标签页层级
- [ ] **P1** 根据标题、URL、Profile、窗口和分组筛选标签页
- [ ] **P1** 标签页状态变化通知

### B2. Claim / Release

- [ ] **P0** `openTabs()`：读取用户当前打开的标签页
- [ ] **P0** 通过精确的 `tabId + title + URL` 快照 claim 用户标签页
- [ ] **P0** 如果标签页在 claim 前已变化，安全失败，不静默接管其他标签页
- [ ] **P0** claim 后返回 Pi 可持续使用的 Tab Handle
- [ ] **P0** `releaseTab()`：释放用户标签页控制权但不关闭标签页
- [ ] **P1** 支持用户明确提及/选择某个现有标签页
- [ ] **P1** 标签页被用户关闭、导航或重用后的 stale handle 检测
- [ ] **P1** 释放时保留用户标签页原有窗口和分组位置
- [ ] **P2** 支持恢复同一个 Pi 会话之前 claim 的标签页

### B3. Agent 标签页分组与回收

- [ ] **P0** Agent 创建的标签页自动记录 ownership/session ID
- [ ] **P0** Agent 创建的页面放入独立标签页分组
- [ ] **P0** 分组名称可配置，例如 `Pi · <session-name>`
- [ ] **P0** 分组颜色可配置
- [ ] **P0** 不移动用户现有标签页到 Agent 分组
- [ ] **P0** 会话结束时关闭或释放 Agent 创建的标签页
- [ ] **P0** 对用户明确要求保留的标签页提供 handoff 标记
- [ ] **P0** 对交付页面提供 deliverable 标记
- [ ] **P1** Agent 创建的窗口也记录 ownership
- [ ] **P1** 只清理当前 Agent 会话创建的页面
- [ ] **P1** 遇到登录、验证码、支付、用户接管时保留并标记 handoff
- [ ] **P1** `/chrome cleanup` 可预览并确认将要释放/关闭的页面
- [ ] **P2** 失效会话的孤儿页面清理

### B4. 基本 Tab API

- [ ] **P0** `get()`
- [ ] **P0** `list()`
- [ ] **P0** `selected()`
- [ ] **P0** `new()`
- [ ] **P0** `close()`
- [ ] **P0** `goto()`
- [ ] **P0** `reload()`
- [ ] **P0** `back()`
- [ ] **P0** `forward()`
- [ ] **P0** `title()`
- [ ] **P0** `url()`
- [ ] **P1** `markDeliverable()`
- [ ] **P1** `markHandoff()`
- [ ] **P1** `requestManualHandoff()`
- [ ] **P2** 浏览历史查询

---

## C. 页面读取与定位

### C1. 页面状态

- [ ] **P0** 页面标题、URL、加载状态
- [ ] **P0** DOM 快照
- [ ] **P0** 可访问性树快照
- [ ] **P0** 当前选中文本
- [ ] **P0** 可见文本提取
- [ ] **P1** 页面变化通知
- [ ] **P1** 当前滚动位置和 viewport
- [ ] **P1** iframe/frame 树
- [ ] **P2** WebMCP 页面工具发现

### C2. Locator / DOM API

- [ ] **P0** `locator()`
- [ ] **P0** `getByRole()`
- [ ] **P0** `getByText()`
- [ ] **P0** `getByLabel()`
- [ ] **P0** `getByPlaceholder()`
- [ ] **P0** `getByTestId()`
- [ ] **P0** `count()`
- [ ] **P0** `first()` / `last()` / `nth()`
- [ ] **P0** `textContent()` / `innerText()`
- [ ] **P0** `getAttribute()`
- [ ] **P0** `isVisible()` / `isEnabled()`
- [ ] **P1** `filter()` / `and()` / `or()`
- [ ] **P1** `frameLocator()`
- [ ] **P1** `elementInfo()`
- [ ] **P2** `expect()` 风格断言

---

## D. 页面交互

### D1. DOM/定位器交互

- [ ] **P0** click
- [ ] **P0** double click
- [ ] **P0** fill
- [ ] **P0** type / pressSequentially
- [ ] **P0** focus
- [ ] **P0** press key
- [ ] **P0** select option
- [ ] **P0** check / uncheck
- [ ] **P0** scroll
- [ ] **P0** 等待页面加载
- [ ] **P0** 等待 URL 变化
- [ ] **P0** 等待文件选择器
- [ ] **P1** drag
- [ ] **P1** hover/move
- [ ] **P1** 处理 JavaScript dialog
- [ ] **P1** navigation 事件等待
- [ ] **P2** WebMCP 工具调用

### D2. CUA/坐标交互

- [ ] **P1** 坐标 click
- [ ] **P1** double click
- [ ] **P1** move
- [ ] **P1** scroll
- [ ] **P1** drag
- [ ] **P1** keypress
- [ ] **P1** type
- [ ] **P1** 可见 DOM + 坐标混合操作
- [ ] **P2** 视觉 CUA fallback

---

## E. 原生 CDP 控制

这是本项目第一版需要重点对齐的部分，不能只实现简单的 DOM 点击。

- [ ] **P0** 原生 CDP 命令发送入口
- [ ] **P0** `Runtime.evaluate`
- [ ] **P0** `Page.navigate`
- [ ] **P0** `Page.reload`
- [ ] **P0** `Page.captureScreenshot`
- [ ] **P0** `DOM.getDocument`
- [ ] **P0** `DOM.querySelector`
- [ ] **P0** `Runtime.consoleAPICalled`
- [ ] **P1** `Network.enable`
- [ ] **P1** 网络请求列表和响应状态
- [ ] **P1** 响应体读取
- [ ] **P1** Console 日志读取
- [ ] **P1** Performance/Timeline 基础信息
- [ ] **P1** Page 生命周期事件
- [ ] **P1** 浏览器下载事件
- [ ] **P1** 文件上传和 file chooser
- [ ] **P1** JavaScript alert/confirm/prompt
- [ ] **P1** iframe 和跨域 frame 的 CDP 控制
- [ ] **P2** WebSocket 网络事件
- [ ] **P2** 浏览器级 CDP target 管理
- [ ] **P2** 原始 CDP 命令白名单/能力发现

---

## F. 截图、文件和剪贴板

- [ ] **P0** 当前 viewport 截图
- [ ] **P0** 截图返回 Pi 图片内容
- [ ] **P0** 截图保存到工作区/临时目录
- [ ] **P1** 全页面截图
- [ ] **P1** 截图路径安全检查
- [ ] **P1** 截图文件大小和路径返回
- [ ] **P0** 剪贴板读文本
- [ ] **P0** 剪贴板写文本
- [ ] **P1** 剪贴板 HTML/图片
- [ ] **P1** 文件上传
- [ ] **P1** 下载文件并返回路径
- [ ] **P2** 下载媒体资源

---

## G. 内容提取与外部能力

- [ ] **P0** 当前页面 Markdown/纯文本提取
- [ ] **P1** URL 内容读取到临时标签页但不改变用户当前标签页
- [ ] **P1** 阅读模式/正文提取
- [ ] **P1** Google Docs/Sheets/Slides 等页面内容导出接口预留
- [ ] **P2** GSuite 专用导出
- [ ] **P2** WebMCP 页面工具发现和调用

---

## H. 第一版信任模式（已决定放开）

第一版采用和 Pi 类似的本地信任模型：安装扩展并完成一次本地配对后，不增加浏览器专用安全策略，不为每个会话、每个工具或每个敏感动作重复弹确认。

需要保留的只是 Bridge 正常运行所必需的工程性边界，不把它们做成用户侧授权流程：

- [ ] **P0** Chrome 扩展首次安装和本地配对作为唯一用户信任边界
- [ ] **P0** 本地 Bridge 默认只监听 `127.0.0.1`
- [ ] **P0** Bridge 使用内部配对 Token，防止普通网页伪造 Pi 请求
- [ ] **P0** Token 不进入模型上下文、不写入日志
- [x] **P0** 不实现浏览器专用的 action-time confirmation
- [x] **P0** 不实现逐会话 `/chrome authorize`
- [x] **P0** 不实现每个 click/fill/evaluate/CDP 调用的额外确认
- [ ] **P1** 插件 Popup 提供可选的 Pause/Resume/Disconnect
- [ ] **P1** Pi `/chrome pause` 作为手动紧急暂停，不作为常规授权流程
- [ ] **P1** Pi `/chrome revoke` 作为手动断开，不作为每次启动必需步骤
- [ ] **P2** 可选的浏览器操作审计日志
- [ ] **P2** 可选的 Cookie/Storage/敏感数据细粒度策略
- [ ] **P2** 可选的站点/域名权限

> 说明：本项目不绕过 Chrome 的扩展安装权限；用户安装并启用扩展后，Pi 按本地信任模式运行。

---

## I. 会话、状态和错误处理

- [ ] **P0** 浏览器会话名称
- [ ] **P0** Pi session 与浏览器 session 绑定
- [ ] **P0** 浏览器连接断开后的自动重连
- [ ] **P0** Tab Handle stale 检测
- [ ] **P0** 不猜测 numeric tab ID
- [ ] **P0** 页面变化后要求重新 snapshot
- [ ] **P1** 浏览器重启后恢复连接
- [ ] **P1** 扩展 reload 后恢复连接
- [ ] **P1** 连接超时、权限不足、页面不存在的可读错误
- [ ] **P1** 操作中断和取消
- [ ] **P1** 手动交接：登录、验证码、支付、权限弹窗
- [ ] **P2** 多窗口并发操作

---

## J. 可见性与用户交接

- [ ] **P0** 后台操作模式，不抢用户焦点
- [ ] **P1** 显示浏览器窗口
- [ ] **P1** 显示当前操作标签页
- [ ] **P1** 用户要求时切换到前台
- [ ] **P1** 用户接管后恢复到后台
- [ ] **P1** `handoff` 页面在后续 Pi turn 可继续
- [ ] **P1** `deliverable` 页面按用户要求保留
- [ ] **P2** 浏览器窗口/标签页焦点策略

---

## K. Chrome/Edge 兼容性

- [ ] **P0** Chrome Manifest V3
- [ ] **P0** Edge Manifest V3
- [ ] **P0** 使用 `chrome.*` 兼容 API
- [ ] **P0** 浏览器能力检测，不假设 `sidePanel` 等 API 一定存在
- [ ] **P1** Chrome 扩展加载和更新流程
- [ ] **P1** Edge 扩展加载和更新流程
- [ ] **P1** Chrome Web Store 构建包
- [ ] **P1** Edge Add-ons 构建包
- [ ] **P2** Brave/Chromium 测试

---

## L. 第一版建议验收场景

- [ ] **P0** Chrome 已登录 GitHub，Pi 找到现有 GitHub 标签页并读取页面状态
- [ ] **P0** Pi claim 现有标签页，不移动它、不改变用户分组
- [ ] **P0** Pi 打开一个新页面，自动放入 `Pi` 标签页分组
- [ ] **P0** Pi 在新页面中完成 snapshot、click、fill、screenshot
- [ ] **P0** 用户明确要求清理后释放用户标签页，关闭允许关闭的 Agent 临时页面
- [ ] **P0** 用户标记 handoff 的页面不被关闭
- [ ] **P0** 用户标记 deliverable 的页面保留
- [ ] **P0** Pi 直接执行一条原生 CDP `Runtime.evaluate`
- [ ] **P0** Pi 重启后重新连接 Chrome，不要求重复授权
- [ ] **P0** Edge 使用同一套扩展完成上述流程
- [ ] **P1** 上传一个本地文件并完成页面提交（Trusted Local Mode，不额外弹浏览器确认）
- [ ] **P1** 捕获 Console 错误和 Network 请求
- [ ] **P1** Pi 重启或新会话后不要求重复浏览器授权，并能自动恢复连接

---

## 默认决策和后续范围

## 当前默认决策

剩余功能点不再逐项询问，统一采用 Codex 当前行为作为默认基线，具体决策记录见 [`DECISIONS.zh-CN.md`](./DECISIONS.zh-CN.md)。

- **已决定**：第一版包含 Locator/Playwright 风格 API、DOM CUA、坐标 CUA 和原生 CDP。
- **已决定**：Network、Console、Dialog、Upload、Download 和 Clipboard 按 Codex API 对齐。
- **已决定**：Agent 页面默认进入 `Pi` 蓝色分组。
- **已决定**：claim 后允许用户授权的页面继续导航、点击和输入；release 时不关闭。
- **已决定**：任务完成和普通 turn 结束默认保留浏览器状态；只有用户明确要求 task finalize 或 Agent disposal 才按 ownership 清理普通 Agent 页面，handoff/deliverable 页面保留。
- **已决定**：`handoff` 和 `deliverable` 按 Codex 语义保留。
- **已决定**：Chrome 和 Edge 第一版同时支持；多 Profile 排在后续阶段。
- **已决定**：扩展安装/配对一次，后续不逐次授权。
- **已决定**：第一版采用 Trusted Local Mode，不实现浏览器专用 action-time confirmation。
- **决定**：WebMCP、GSuite 导出、历史记录、媒体下载和 Brave/Chromium 先作为后续扩展能力，不阻塞核心版本。
