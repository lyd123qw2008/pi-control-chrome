# pi-control-chrome 架构草案（中文）

> 第一阶段核心 Bridge、浏览器扩展和 Pi Extension 已实现；本文继续作为后续 Codex 能力对齐的架构基线。

## 一、整体架构

```text
Chrome / Edge Manifest V3 扩展
  ├── Service Worker
  ├── Content Script / DOM 适配层
  ├── 原生 CDP 适配层
  ├── 标签页、分组和 ownership 管理
  └── 本地 Bridge 客户端
          ↕ 127.0.0.1 + 配对 Token
本地 Bridge
  ├── 会话注册
  ├── 请求路由
  ├── 断线重连
  ├── 授权状态
  └── 审计日志
          ↕ Pi Extension 协议
Pi Extension
  ├── 浏览器生命周期管理
  ├── 浏览器工具
  ├── /chrome 命令
  ├── 标签页 Handle 和清理状态
  └── Pi UI、状态栏和确认对话框
```

## 二、为什么需要 Chrome/Edge 扩展

单纯使用 CDP 端口只能连接浏览器调试端点，不能完整复用官方浏览器插件的用户体验。

扩展可以直接运行在用户日常浏览器 Profile 中，因此能够处理：

- 当前已打开的标签页；
- 已登录的网站；
- 现有 Cookie 和浏览器扩展；
- 当前窗口、标签页分组和活动状态；
- 页面 DOM、脚本和浏览器事件。

Pi 端不直接读取 Chrome Profile 文件，也不读取 Cookie 数据库，而是通过扩展提供的本地 Bridge 调用浏览器能力。

## 三、核心组件

### 1. Chrome/Edge 扩展

扩展使用 Manifest V3，Chrome 和 Edge 共用一套业务代码。

主要职责：

- 连接本地 Bridge；
- 读取浏览器窗口和标签页；
- 创建、选择、导航和关闭标签页；
- 管理 Agent 创建的标签页分组；
- 执行 DOM 操作；
- 执行原生 CDP 命令；
- 处理截图、下载、上传和浏览器事件；
- 在扩展 Popup 中提供暂停、恢复和断开控制。

### 2. 本地 Bridge

Bridge 只监听本机回环地址：

```text
127.0.0.1
```

主要职责：

- 接收 Pi Extension 请求；
- 转发请求到 Chrome/Edge 扩展；
- 为 Pi 会话分配 session ID；
- 维护扩展连接状态；
- 处理断线和重连；
- 校验本地配对 Token；
- 记录必要的审计信息；
- 拒绝普通网页通过 CORS 直接调用浏览器控制接口。

### 3. Pi Extension

Pi Extension 负责把浏览器能力注册成 Pi 原生工具和命令。

当前已提供的工具（阶段 1/2）：

```text
browser_tabs
browser_snapshot
browser_select_tab
browser_new_tab
browser_navigate
browser_back
browser_forward
browser_reload
browser_click
browser_fill
browser_type
browser_press_key
browser_scroll
browser_screenshot
browser_evaluate
browser_console
browser_network
browser_upload
browser_download
browser_cdp
```

计划提供的命令：

```text
/chrome status
/chrome setup
/chrome connect
/chrome disconnect
/chrome pause
/chrome resume
/chrome profile
/chrome group
/chrome claim
/chrome release
/chrome cleanup
```

## 四、浏览器连接生命周期

### 首次安装

用户只需要：

1. 安装 Chrome/Edge 扩展；
2. 在扩展中允许本地 Pi Bridge；
3. 启动 Pi；
4. 完成一次本地配对。

之后不应该每个 Pi 会话或每个浏览器动作重新要求授权。

### 后续启动

```text
Pi 启动
  ↓
Pi Extension 尝试连接本地 Bridge
  ↓
Bridge 查找已安装的 Chrome/Edge 扩展
  ↓
扩展发送浏览器、Profile 和版本信息
  ↓
Pi 恢复浏览器连接
```

### 断线恢复

需要支持：

- Chrome/Edge 重启后自动重连；
- 扩展 Service Worker 暂停后恢复；
- Bridge 重启后恢复；
- Pi `/reload` 后重新绑定；
- 目标标签页关闭后的明确错误；
- Tab Handle 失效后的重新 snapshot。

## 五、标签页和分组模型

### 用户标签页

用户已经打开的标签页默认属于：

```text
owner: user
```

Agent 需要先通过精确的标签页快照进行 claim：

```text
tabId + title + URL + windowId
```

如果 claim 前标签页已经改变，必须安全失败，不能静默接管另一个标签页。

claim 用户标签页之后：

- 可以对它进行后续操作；
- 不应该自动把它移动到 Agent 分组；
- 释放时保持它原来的窗口和分组；
- 默认不关闭用户标签页。

### Agent 标签页

Agent 新建的标签页需要记录：

```text
owner: agent
sessionId
browserId
windowId
tabId
groupId
createdAt
```

默认放入独立分组：

```text
Pi · <session-name>
```

例如：

```text
Pi · GitHub PR review
```

### 标签页清理

每个标签页需要支持以下状态：

```text
created
claimed
released
handoff
deliverable
stale
closed
```

清理规则：

- 普通 Agent 临时标签页：任务完成后关闭；
- 用户 claim 的标签页：释放但不关闭；
- `handoff` 标签页：保留，等待用户继续操作；
- `deliverable` 标签页：保留，作为用户可见交付结果；
- 其他 Pi session 创建的标签页：不能清理；
- 清理操作必须幂等，重复执行不能误关闭页面。

## 六、页面控制层

### 页面读取

第一版至少需要：

- 页面标题和 URL；
- 可见文本；
- DOM Snapshot；
- Accessibility Tree；
- 当前选中文本；
- 当前 viewport；
- iframe/frame 信息。

### Locator 操作

需要尽可能提供接近 Playwright 的定位方式：

```text
locator
getByRole
getByText
getByLabel
getByPlaceholder
getByTestId
```

并支持：

```text
count
first
last
nth
filter
textContent
innerText
getAttribute
isVisible
isEnabled
```

### 基础交互

```text
click
doubleClick
fill
type
press
focus
selectOption
check
uncheck
scroll
drag
```

操作之后应该返回页面变化摘要，避免模型每次都需要重新截图确认。

## 七、原生 CDP 层

原生 CDP 是本项目的重点，不应该只做简单 DOM 点击。

第一版需要至少支持：

```text
Runtime.evaluate
Page.navigate
Page.reload
Page.captureScreenshot
DOM.getDocument
DOM.querySelector
```

后续支持：

```text
Network.enable
Network.requestWillBeSent
Network.responseReceived
Network.getResponseBody
Runtime.consoleAPICalled
Page.lifecycleEvent
Page.fileChooserOpened
Page.javascriptDialogOpening
```

Pi 端建议提供一个受控工具：

```text
browser_cdp
```

参数包括：

```json
{
  "method": "Runtime.evaluate",
  "params": {
    "expression": "document.title"
  }
}
```

第一版采用本地信任模式，原始 CDP 不增加浏览器专用的能力白名单、动作确认或审计策略。Pi 可以直接调用已连接扩展提供的 CDP 方法。

仍然保留两个纯工程性要求：

- Bridge 只监听本机回环地址；
- 请求必须通过已配对的本地连接，避免普通网页伪造 Pi 请求。

## 八、第一版信任模式

目标是：

```text
安装并启用 Chrome/Edge 扩展
→ 完成本地配对
→ 后续浏览器操作不再重复授权或确认
```

第一版明确不实现：

- `/chrome authorize` 逐会话授权；
- click/fill/evaluate/CDP 的逐调用确认；
- Cookie、Storage、密码、OTP、上传、提交表单的额外确认；
- 浏览器操作审计日志；
- 站点级细粒度权限策略。

用户可以在扩展 Popup 中手动暂停或断开，但这不是每次操作的必需流程。

安全边界只有：

```text
Chrome/Edge 扩展安装权限
本地配对 Token
本机 Bridge 连接
```

这套模式与 Pi 的整体本地信任方式保持一致，目标是避免社区 CDP 工具那种每次 shell/动作反复授权。

## 九、截图、文件和对话框

### 截图

- 当前 viewport 截图；
- 全页面截图；
- 保存到临时目录或项目目录；
- 返回 Pi 图片内容；
- 检查输出路径，拒绝路径穿越；
- 页面发生变化后可以重新截图。

### 文件

- 文件上传；
- 下载文件；
- 下载路径返回；
- 文件选择器处理；
- 需要确认上传敏感文件；
- 需要确认下载和保存敏感数据。

### 浏览器对话框

- alert；
- confirm；
- prompt；
- beforeunload。

## 十、会话和用户交接

每个浏览器控制任务需要有短名称，例如：

```text
🔎 GitHub PR review
```

Browser session 和 Pi session 绑定，但 Tab Handle 不能只依赖数字 tab ID。

如果页面发生以下情况：

- 页面导航；
- 页面关闭；
- 浏览器重启；
- 标签页 ID 被复用；
- 页面标题或 URL 发生变化；

必须重新获取标签页快照，不能盲目重试旧 Handle。

遇到以下场景需要进入 handoff：

- 登录；
- CAPTCHA；
- OTP；
- 支付；
- 权限弹窗；
- 用户需要自己确认的浏览器对话框。

## 十一、第一版建议实现顺序

### 第 1/2 阶段：连接、读取和基础交互（已完成）

已完成 Chrome/Edge 扩展、本地 Bridge、Pi Extension、一次性配对、状态/标签页、claim/release、Pi 分组、snapshot、Locator、DOM/坐标 CUA、导航和页面交互、截图、Clipboard、Upload/Download、Dialog、Console/Network、原生 CDP 以及 session/turn 清理。

### 第 3 阶段：扩展能力

1. `Runtime.evaluate`；
2. Console；
3. Network；
4. Dialog；
5. Upload；
6. Download；
7. CDP 能力白名单。

### 第 4 阶段：Codex 体验对齐

1. handoff；
2. deliverable；
3. 后台/前台显示；
4. stale handle；
5. 多窗口和 Profile；
6. WebMCP；
7. 完整安全确认策略。
