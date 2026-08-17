# pi-control-chrome

这是一个面向 Pi 的 Chrome/Edge 浏览器控制方案设计仓库，目标是尽可能对齐 Codex `control-chrome` 的体验和能力。

当前阶段包含：

- 功能对齐清单；
- 中文架构说明；
- 第一版验收范围；
- 第一阶段 Bridge、浏览器扩展和 Pi Extension 核心实现。

## 文档

- [功能对齐清单](./FEATURES.md)
- [Codex 默认行为对齐说明](./CODEX-ALIGNMENT.zh-CN.md)
- [项目决策](./DECISIONS.zh-CN.md)
- [中文架构说明](./ARCHITECTURE.zh-CN.md)
- [英文架构说明](./ARCHITECTURE.md)

## 重点目标

### 浏览器接管

- Chrome 和 Edge 共用一套 Manifest V3 扩展；
- 复用当前用户的浏览器 Profile、登录状态和标签页；
- 安装和配对一次后，正常操作不重复请求授权或浏览器动作确认；
- 支持 Pi、Bridge 和浏览器扩展之间的自动重连。

### 标签页管理

- 发现当前窗口和标签页；
- claim/release 用户标签页；
- Agent 创建的页面自动进入 Pi 专属分组；
- Agent 页面带有 session ownership；
- 任务完成后释放或关闭 Agent 页面；
- 支持 handoff 和 deliverable 页面保留；
- 不误关闭其他 Pi 会话和用户页面。

### 页面和 CDP

- Accessibility Snapshot；
- DOM 和 Locator 操作；
- click、fill、type、press、scroll；
- 截图和图片回传；
- 原生 CDP；
- Runtime.evaluate；
- Console、Network、Dialog、Upload、Download；
- Chrome/Edge 页面能力检测。

## 当前状态

```text
功能清单：已完成初稿
中文架构：已完成初稿
第一阶段核心代码：已实现并通过 Edge E2E 冒烟测试
```

第一阶段当前包含：

- `extension/`：Manifest V3 Chrome/Edge 扩展；
- `bridge/`：本地 WebSocket Bridge；
- `pi-extension/`：Pi 原生浏览器工具和 `/chrome` 命令；
- `tests/bridge.test.mjs`：Bridge 单元/协议测试；
- `tests/e2e-browser.mjs`：真实 Edge + 扩展 + Bridge + Pi 协议冒烟测试。

功能范围已经按 Codex 默认行为确定，具体见 [`DECISIONS.zh-CN.md`](./DECISIONS.zh-CN.md)。后续开发继续按阶段实现，不再缩减核心浏览器控制能力。

## 第一阶段本地使用

安装依赖：

```powershell
cd D:\liuyongdan\code\pi-control-chrome
npm install
```

安装 Pi Package：

```powershell
pi install D:\liuyongdan\code\pi-control-chrome
```

加载 Chrome/Edge 扩展：

1. 打开 `chrome://extensions` 或 `edge://extensions`；
2. 开启 Developer mode；
3. 选择 Load unpacked；
4. 选择：
   ```text
   D:\liuyongdan\code\pi-control-chrome\extension
   ```
5. 重启 Pi。

在 Pi 中检查：

```text
/chrome status
/chrome tabs
```

运行测试：

```powershell
npm test
npm run smoke:e2e
```

`smoke:e2e` 默认使用 Edge，也可以指定 Chrome for Testing：

```powershell
$env:PI_CONTROL_CHROME_BROWSER = "C:\Users\liuyd\AppData\Local\ms-playwright\chromium-1224\chrome-win64\chrome.exe"
npm run smoke:e2e
```

## 对齐基线

当前以本机 Codex Chrome 插件的以下资料作为行为参考：

```text
C:/Users/liuyd/.codex/plugins/cache/openai-bundled/chrome/26.810.52044/
```

重点包括：

- `skills/control-chrome/SKILL.md`；
- `docs/api.json`；
- 标签页 claim/release；
- Agent 标签页分组和清理；
- 原生 CDP；
- 截图、上传、下载、Console、Network；
- handoff、deliverable 和标签页清理。

## 当前仓库状态

仓库内包含第一阶段实现代码；安装和运行时不会自动修改以下用户资源：

- Pi 全局配置；
- Chrome/Edge 配置；
- 浏览器 Profile；
- 用户标签页；
- 本地 Bridge；
- 任何登录凭据。
