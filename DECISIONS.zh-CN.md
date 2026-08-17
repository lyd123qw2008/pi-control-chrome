# pi-control-chrome 项目决策

这些决策由项目默认采用，除非后续出现明确的兼容性问题或用户要求改变。

## 1. 产品目标

第一版目标不是做一个简单的 CDP 调用器，而是尽可能复刻 Codex `control-chrome` 的浏览器控制体验：

- 当前日常 Chrome/Edge Profile；
- 当前登录状态和标签页；
- Agent 页面分组；
- Tab claim/release；
- Agent 页面自动清理；
- DOM、CUA、Playwright 风格操作；
- 原生 CDP；
- handoff 和 deliverable；
- Pi session 之间自动重连。

## 2. 浏览器

### 首选支持

- Chrome：P0
- Edge：P0
- Chromium/Brave：P2

Chrome 和 Edge 使用同一套 Manifest V3 扩展代码。业务逻辑不分叉，只在安装入口、浏览器名称和少量能力检测上区分。

### Profile

第一版支持当前选中的 Chrome/Edge Profile，连接信息会记录 Profile 标识。

多 Profile 同时并行操作放到 P1，不阻塞第一版。

## 3. 标签页分组

### 分组名称

默认使用：

```text
Pi
```

### 分组颜色

默认使用：

```text
blue
```

### 分组粒度

每个浏览器 Profile 创建一个受 Pi 管理的分组。多个 Pi session 的页面共用该分组，但每个页面保留自己的 `sessionId` ownership。

如果同一 Profile 同时运行多个任务，分组标题可以显示为：

```text
Pi · <当前任务名>
```

如果 Chrome 的分组标题 API 不适合动态切换，则固定使用 `Pi`，任务名放在页面 ownership 元数据中。

## 4. Tab 生命周期

完全按 Codex 默认语义：

- Agent 创建的普通标签页：当前 turn 结束时关闭；
- `markDeliverable`：保留；
- `markHandoff`：保留，等待用户接管；
- 用户标签页 claim 后：当前 turn 结束时 release，不关闭；
- 用户标签页原有窗口和分组不改变；
- cleanup 只操作当前 Agent session 创建的页面；
- 不能关闭其他 Pi session 或用户页面。

## 5. 页面控制范围

第一版核心实现包含：

- 标签页发现和选择；
- claim/release；
- DOM snapshot；
- Accessibility snapshot；
- Locator/Playwright 风格操作；
- DOM CUA；
- 坐标 CUA；
- 截图；
- 剪贴板；
- JavaScript dialog；
- 文件上传和下载；
- 原生 CDP；
- Runtime.evaluate；
- Console 和 Network 基础读取。

WebMCP、GSuite 导出、历史记录、媒体下载和更多浏览器能力发现接口保留协议位置，但排在核心功能之后。

## 6. 授权模式

第一版使用 Trusted Local Mode：

- 安装扩展是一次性用户信任步骤；
- 初次本地配对是一次性连接步骤；
- 后续 Pi session 自动连接；
- 不使用 `/chrome authorize`；
- 不使用每个动作确认；
- 不使用敏感操作确认；
- 不使用浏览器操作审计策略。

Bridge 仍然只绑定本机地址并使用内部配对 Token，这是协议完整性要求，不作为用户侧反复授权流程。

## 7. 工具命名

Pi 侧使用通用 `browser_*` 命名，避免把实现绑定到 Chrome：

```text
browser_status
browser_tabs
browser_selected
browser_claim_tab
browser_select_tab
browser_new_tab
browser_snapshot
browser_back
browser_forward
browser_reload
browser_navigate
browser_back
browser_forward
browser_reload
browser_click
browser_double_click
browser_fill
browser_type
browser_press_key
browser_scroll
browser_screenshot
browser_evaluate
browser_cdp
browser_console
browser_network
browser_upload
browser_download
browser_clipboard
browser_release
browser_mark_handoff
browser_mark_deliverable
browser_cleanup
```

命令使用 `/chrome ...`，因为用户认知上它是 Chrome/Edge 控制入口：

```text
/chrome status
/chrome setup
/chrome tabs
/chrome cleanup
```

## 8. 实现顺序

### 阶段 1：可用闭环

1. Manifest V3 扩展；
2. 本地 Bridge；
3. Pi Extension；
4. 一次性配对；
5. 浏览器状态；
6. 标签页列表和选择；
7. Snapshot；
8. 当前标签页 claim/release；
9. 新建标签页和 Pi 分组；
10. Navigate、Click、Fill、Screenshot；
11. 基础 CDP evaluate；
12. turn/session 清理。

### 阶段 2：Codex 核心能力

1. 完整 Locator/Playwright 风格 API；
2. DOM CUA 和坐标 CUA；
3. Console；
4. Network；
5. Upload/Download；
6. Clipboard；
7. JavaScript Dialog；
8. handoff/deliverable；
9. 自动重连；
10. Chrome/Edge 双浏览器验收。

### 阶段 3：扩展能力

1. 多 Profile；
2. WebMCP；
3. GSuite 导出；
4. 历史记录；
5. 媒体下载；
6. Capability 发现；
7. Chrome Web Store 和 Edge Add-ons 发布包；
8. Brave/Chromium。

## 9. 验收标准

第一版必须能够完成：

1. Chrome 已登录 GitHub；
2. Pi 发现当前 GitHub 标签页；
3. Pi claim 该页面但不移动它；
4. Pi 读取页面 snapshot；
5. Pi 打开新标签页并放入 `Pi` 分组；
6. Pi 完成 navigate、click、fill、screenshot；
7. Pi 执行原生 `Runtime.evaluate`；
8. 普通 Agent 标签页在 turn 结束时自动关闭；
9. handoff/deliverable 页面保留；
10. 用户标签页 release 且不关闭；
11. Pi 重启后自动恢复连接；
12. Edge 使用同一套扩展完成同样流程。
