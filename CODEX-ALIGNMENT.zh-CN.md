# Codex `control-chrome` 对齐默认值

用户不需要逐项重新设计已经存在于 Codex 的浏览器行为。除明确标注的 Pi 版本差异外，第一版默认按本机 Codex Chrome 插件基线实现。

基线目录：

```text
C:/Users/liuyd/.codex/plugins/cache/openai-bundled/chrome/26.810.52044/
```

参考内容：

```text
skills/control-chrome/SKILL.md
docs/api.json
docs/tab-claiming-chrome.md
docs/tab-cleanup-chrome.md
docs/browser-safety.md
docs/file-uploads.md
docs/webmcp.md
```

## 一、浏览器选择默认值

- 用户明确指定 Chrome 时，只使用 Chrome；
- 用户明确指定 Edge 时，只使用 Edge；
- 用户没有指定浏览器时，按当前可用浏览器选择默认连接；
- 不因为某个浏览器登录失败就静默切换到另一个浏览器；
- 支持 Chrome、Edge，后续再兼容 Brave/Chromium；
- 同一套 Manifest V3 扩展代码支持 Chrome 和 Edge；
- 浏览器连接、Profile 和 Bridge 状态在 Pi session 中保持复用；
- 浏览器断开后自动重连，而不是每次操作重新初始化。

## 二、标签页发现和 claim 默认值

对齐 Codex 的用户标签页 API：

```text
browser.user.openTabs()
browser.user.claimTab(tab)
browser.tabs.list()
browser.tabs.get(id)
browser.tabs.new()
browser.tabs.selected()
```

默认行为：

- 先列出真实存在的标签页；
- 不猜测数字 tab ID；
- claim 必须使用当前快照中的精确标签页信息；
- 快照中的标题、URL、tab ID 或窗口信息变化后，claim 失败并要求重新获取；
- claim 用户标签页不会把它移动到 Agent 分组；
- claim 只授予当前 Pi session 的控制句柄；
- release 用户标签页时保留页面、窗口和用户原有分组；
- 默认不关闭用户标签页。

## 三、Agent 标签页和分组默认值

对齐 Codex 的 Agent 页面生命周期，同时加入用户指定的分组体验：

- Agent 创建的标签页带有 Pi session ownership；
- Agent 创建的页面自动放入一个独立的 Pi 分组；
- 默认分组名称：`Pi`；
- 默认分组颜色：蓝色；
- 如果同一 Profile 存在多个 Pi session，分组标题可以显示为 `Pi · <session name>`；
- 用户已有标签页不自动移动到 Pi 分组；
- Agent 页面默认是临时页面；
- 当前 turn 结束时，普通 Agent 页面自动关闭；
- `markDeliverable()` 页面保留为用户交付结果；
- `markHandoff()` 页面保留，等待用户后续操作；
- claim 的用户页面在 turn 结束时 release，不关闭；
- cleanup 只处理当前 Agent session 自己创建的页面；
- 清理操作幂等，不能误删其他 Pi session 或用户页面。

对应的 Pi 语义计划为：

```text
browser_mark_deliverable
browser_mark_handoff
browser_request_manual_handoff
browser_release
browser_cleanup
```

## 四、Tab 基础 API 默认值

第一版不删减 Codex 已有的基础 Tab 能力：

```text
back()
close()
forward()
goto(url)
reload()
title()
url()
screenshot()
getJsDialog()
```

每个 Tab Handle 都必须携带：

```text
browserId
windowId
tabId
title
url
snapshotVersion
owner
sessionId
groupId
```

旧 Handle 失效时必须 fail closed，重新获取页面状态后才能继续。

## 五、页面控制默认值

第一版按 Codex 当前 API 对齐，不只提供简单的 CSS 点击：

### Locator/Playwright

```text
locator
getByRole
getByText
getByLabel
getByPlaceholder
getByTestId
frameLocator
```

包括：

```text
click
dblclick
fill
type
press
selectOption
check
uncheck
focus
count
first
last
nth
filter
innerText
textContent
getAttribute
isVisible
isEnabled
waitFor
waitForURL
waitForLoadState
waitForEvent
```

### DOM CUA

```text
get_visible_dom
click
double_click
keypress
scroll
type
downloadMedia
```

### 坐标 CUA

```text
click
double_click
move
scroll
drag
keypress
type
downloadMedia
```

### 页面状态

```text
domSnapshot
elementInfo
elementScreenshot
getJsDialog
```

## 六、原生 CDP 默认值

原生 CDP 是 P0/P1 的核心能力，不做成只有少数固定动作的封装。

第一版至少支持：

```text
Runtime.evaluate
Page.navigate
Page.reload
Page.captureScreenshot
DOM.getDocument
DOM.querySelector
Runtime.consoleAPICalled
Network.enable
Network.requestWillBeSent
Network.responseReceived
Network.getResponseBody
Page.lifecycleEvent
Page.fileChooserOpened
Page.javascriptDialogOpening
```

Pi 工具提供通用入口：

```text
browser_cdp
```

能够发送扩展允许的原生 CDP 方法，并返回原始结果和页面身份。

根据用户对第一版“放开”的决定：

- 不实现浏览器专用 action-time confirmation；
- 不实现每个 CDP 方法的二次确认；
- 不实现审计策略；
- CDP 通过本地已配对的扩展连接直接调用。

## 七、截图、文件、剪贴板默认值

对齐 Codex 当前能力：

- 当前 viewport 截图；
- 全页面截图；
- 截图保存到临时目录或项目目录；
- 截图以 Pi 图片内容返回；
- file chooser 上传；
- 下载事件和下载路径；
- 剪贴板文本读写；
- 剪贴板 HTML/图片能力预留；
- JavaScript alert/confirm/prompt/beforeunload 处理。

## 八、内容和可选能力默认值

不因为第一版暂时排后就删除接口：

- 页面正文/Markdown 提取；
- 临时后台标签页内容提取；
- Google Workspace 导出；
- 浏览历史；
- WebMCP 页面工具发现和调用；
- 浏览器级 capability 发现；
- Tab 级 capability 发现；
- Dev/Console 能力发现。

这些功能按 Codex API 的 capability 模型保留，核心浏览器控制完成后再补齐完整实现。

## 九、会话和交接默认值

- Pi session 有对应的 browser session；
- 浏览器 session 可以命名；
- 浏览器连接和 tab handle 在多个 Pi turn 间复用；
- 页面变化后重新 snapshot；
- 浏览器重启后自动重连；
- 登录、验证码、支付、权限弹窗等流程可以进入 handoff；
- handoff 页面不自动清理；
- deliverable 页面不自动清理；
- 用户接管后，Pi 释放页面控制但保留页面。

## 十、明确的 Pi 版本差异

只有下面这些是有意区别于 Codex 运行时的实现方式：

1. 不复制 Codex 私有的 `agent.browsers` 和 `browser-client.mjs`；
2. 使用 Pi Extension API 注册浏览器工具；
3. 使用 Chrome/Edge MV3 扩展和本地 Bridge；
4. 浏览器页面通过 Pi 工具名暴露，而不是 Codex Node API；
5. 第一版采用用户决定的 Trusted Local Mode，不实现 Codex 文档中的浏览器动作确认策略。

除以上明确差异外，行为、Tab 生命周期、claim/release、handoff、deliverable、清理和能力范围均以 Codex 为默认基线。

## 十一、用户不需要再确认的事项

以下事项直接采用 Codex 默认行为：

- Locator/Playwright 级页面操作；
- DOM CUA 和坐标 CUA；
- 原生 CDP；
- Console、Network、Dialog、Upload、Download；
- claim/release；
- Agent 页面分组；
- Agent 页面自动回收；
- handoff/deliverable；
- stale tab 处理；
- Chrome/Edge 双浏览器；
- 浏览器断线重连；
- Pi session 之间的浏览器状态复用。

只需要确认：

- `Pi` 分组名称和颜色是否采用默认值；
- 第一版是否先实现 P0/P1，再补 WebMCP、GSuite 导出和历史记录等可选能力。
