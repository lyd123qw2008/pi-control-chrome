# pi-control-chrome

Pi 的 Chromium 浏览器控制方案，目标是尽可能对齐 Codex `control-chrome` 的用户体验和能力。

> 阶段 1/2 核心实现已完成；后续继续按 Codex 行为补齐扩展能力。

## 目标

安装一次 Chrome/Edge 扩展后，让 Pi 能够通过本地 Bridge 无需每个动作重复授权地使用用户日常浏览器：

- 复用现有 Chrome/Edge Profile、登录状态、Cookie 和扩展；
- 读取和接管用户明确选择的现有标签页；
- 将 Agent 创建的标签页放入独立浏览器分组；
- 会话结束时释放或清理 Agent 创建的标签页；
- 支持 DOM、可访问性树、Playwright 风格定位器、坐标操作和原生 CDP；
- 对齐 Codex 的标签页 claim/release、handoff 和 deliverable 语义。

## 对齐基线

本项目以本机 Codex Chrome 插件版本作为行为基线：

```text
C:/Users/liuyd/.codex/plugins/cache/openai-bundled/chrome/26.810.52044/
```

重点参考：

```text
skills/control-chrome/SKILL.md
docs/api.json
docs/tab-claiming-chrome.md
docs/tab-cleanup-chrome.md
docs/browser-safety.md
docs/confirmations.md
docs/file-uploads.md
docs/chrome-file-upload-troubleshooting.md
docs/visibility.md
docs/webmcp.md
```

中文入口见 [`README.zh-CN.md`](./README.zh-CN.md)。完整待确认功能清单见 [`FEATURES.md`](./FEATURES.md)，Codex 默认行为对齐说明见 [`CODEX-ALIGNMENT.zh-CN.md`](./CODEX-ALIGNMENT.zh-CN.md)，项目决策见 [`DECISIONS.zh-CN.md`](./DECISIONS.zh-CN.md)，中文架构说明见 [`ARCHITECTURE.zh-CN.md`](./ARCHITECTURE.zh-CN.md)，英文架构说明见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 设计原则

1. **一次安装、低摩擦使用**：安装扩展和首次配对是唯一的用户授权步骤，正常浏览器操作不逐次弹 Pi shell 或浏览器动作确认。
2. **浏览器扩展是信任边界**：Chrome/Edge 扩展负责用户 Profile、标签页和页面能力；Pi 只通过本地 Bridge 调用。
3. **用户标签页默认不被移动**：claim 只建立控制权，不把用户标签页强制移动到 Agent 分组。
4. **Agent 标签页可回收**：Agent 创建的标签页、窗口和分组带有 ownership/session 标记，结束时按策略释放或关闭。
5. **信任本地运行模式**：第一版不增加浏览器专用的动作确认、逐会话授权或审计策略；安装扩展并完成本地配对即视为用户信任边界，后续按 Pi 的整体信任模型运行。
6. **Chrome 和 Edge 共用一套扩展代码**：使用 Chromium Manifest V3 和能力检测，不维护两套业务逻辑。
7. **不复制 Codex 私有运行时代码**：对齐公开可观察行为和 API 语义，Pi 侧使用自己的 Extension API 和 Bridge 协议。

## 当前状态

- [x] 创建独立仓库
- [x] 完成功能对齐清单初稿
- [x] 完成 Bridge/扩展/Pi Extension 架构草案
- [x] 按 Codex 默认行为确定第一版范围
- [x] 实现阶段 1/2 核心 Bridge、扩展和 Pi 工具
- [x] 通过真实 Edge + Chrome for Testing + Extension + Bridge 高覆盖 E2E 测试
- [x] 完成 Locator、DOM/坐标 CUA、Console、Network、Dialog、Upload、Download、Clipboard 和生命周期清理

## 当前后续范围

以下能力仍按第三阶段排期，不阻塞当前核心闭环：

- 多 Profile 并行控制；
- WebMCP、GSuite 导出和浏览历史；
- 媒体下载专用接口；
- Capability discovery；
- Chrome Web Store/Edge Add-ons 发布包；
- Brave/Chromium 专项验收。
