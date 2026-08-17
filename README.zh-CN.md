# pi-control-chrome

这是一个面向 Pi 的 Chrome/Edge 浏览器控制方案设计仓库，目标是尽可能对齐 Codex `control-chrome` 的体验和能力。

当前阶段只有：

- 功能对齐清单；
- 中文架构说明；
- 第一版验收范围；
- 暂不包含实际实现代码。

## 文档

- [功能对齐清单](./FEATURES.md)
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
实现代码：尚未开始
```

请先查看 [`FEATURES.md`](./FEATURES.md)，确认哪些功能属于第一版 P0，哪些可以放到 P1/P2。确认完成后再开始编码。

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

当前仓库只记录设计，不会修改：

- Pi 全局配置；
- Chrome/Edge 配置；
- 浏览器 Profile；
- 用户标签页；
- 本地 Bridge；
- 任何登录凭据。
