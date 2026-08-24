# pi-control-chrome

[English](./README.md) · 简体中文

这是一个面向 Pi 的 Chrome/Edge 浏览器控制方案设计仓库，目标是尽可能对齐 Codex `control-chrome` 的体验和能力。

当前阶段包含：

- 功能对齐清单；
- 中文架构说明；
- 第一版验收范围；
- 第一、二阶段 Bridge、浏览器扩展和 Pi Extension 核心实现。

## 文档

- [功能对齐清单](./FEATURES.md)
- [Codex 默认行为对齐说明](./CODEX-ALIGNMENT.zh-CN.md)
- [项目决策](./DECISIONS.zh-CN.md)
- [中文架构说明](./ARCHITECTURE.zh-CN.md)
- [英文架构说明](./ARCHITECTURE.md)
- [变更记录](./CHANGELOG.md)
- [Pi Skill](./skills/pi-control-chrome/SKILL.md)
- [浏览器能力显式激活方案](./BROWSER-ACTIVATION-DESIGN.zh-CN.md)

本项目的浏览器工具采用 Skill 门控：当前会话显式加载 `pi-control-chrome` Skill 之前，Pi 和 DSH 都不会向模型提供完整的 `browser_*` schema。普通公开网页搜索不会因此启动当前浏览器。仓库内的 `skills/pi-control-chrome/scripts/browser.mjs` 只用于明确的人工/开发者流程和自动化测试，不能作为模型绕过 Skill 门控的路径。

## 重点目标

### 浏览器接管

- Chrome 和 Edge 共用一套 Manifest V3 扩展；
- 复用当前用户的浏览器 Profile、登录状态和标签页；
- 安装和配对一次后，正常操作不重复请求授权或浏览器动作确认；
- 支持 Pi、Bridge 和浏览器扩展之间的自动重连。

- Bridge 使用本机配对令牌和实例 ID；同一用户控制域中的 DSH 或 Pi Host 都可以通过显式 `/chrome restart` 请求协作式重启。
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
- 普通当前标签页视口截图不打开 DevTools 调试会话；完整页面和后台标签页截图使用短时、会话归属的调试租约；
- 原生 CDP；
- Runtime.evaluate；
- Console、Network、Dialog、Upload、Download；
- Chrome/Edge 页面能力检测。

## 当前状态

```text
功能清单：已完成初稿
中文架构：已更新实现状态
阶段 1/2 核心代码：已实现并通过 Edge + Chrome for Testing 高覆盖 E2E 测试
```

当前实现包含：

- `extension/`：Manifest V3 Chrome/Edge 扩展；
- `bridge/`：本地 WebSocket Bridge；
- `pi-extension/`：Pi 原生浏览器工具和 `/chrome` 命令；
- `dsh-tool-control-chrome/`：DSH `browser_*` 工具和 `/chrome status|doctor|restart|tabs` 命令；
- `tests/bridge.test.mjs`：Bridge 单元/协议测试；
- `tests/skill-script.test.mjs`：Skill 快速脚本的实时 Bridge 集成测试；
- `tests/e2e-browser.mjs`：真实 Edge/Chrome for Testing + 扩展 + Bridge 的高覆盖 E2E 测试；覆盖 Locator、DOM/坐标 CUA、Console、Network、Dialog、Upload、Download、Clipboard 和 cleanup。

功能范围已经按 Codex 默认行为确定，具体见 [`DECISIONS.zh-CN.md`](./DECISIONS.zh-CN.md)。后续开发继续按阶段实现，不再缩减核心浏览器控制能力。

## 本地使用

安装依赖：

```powershell
cd <path-to>/pi-control-chrome
npm install
```

安装 Pi Package：

开发中的本地路径：

```powershell
pi install <path-to>/pi-control-chrome
```

发布到 npm 后：

```powershell
pi install npm:pi-control-chrome
```

也可以直接从 GitHub 安装：

```powershell
pi install git:github.com/lyd123qw2008/pi-control-chrome
```

项目同时包含 `skills/pi-control-chrome/SKILL.md`。该 Skill 会指导 Pi 优先使用本项目的 `browser_*` 工具控制已连接的 Chrome/Edge，并遵循标签页 ownership、handoff 和 cleanup 规则。

同一个 Bridge 当前只接受一个活动中的扩展连接。Chrome 和 Edge 可以同时打开，但如果两个浏览器都加载这套扩展并连接到同一个 Bridge，后连接的扩展会替换先连接的扩展，Pi 的控制目标可能在两个浏览器之间切换。实际使用时请为一个 Bridge 只连接一个受控浏览器。

## DSH 集成

仓库还包含独立的 [`@lyd123qw2008/dsh-tool-control-chrome`](./dsh-tool-control-chrome/README.md) 包。默认 `lazyTools: true` 时，插件只注册 `pi-control-chrome` Skill 的名称和描述；Skill 成功加载后，才把完整的 38 个现有 `browser_*` 工具注册到当前 Agent 会话。设置 `lazyTools: false` 可保留旧的插件加载即显示工具行为。Pi 使用同一批原生工具定义和 active-tool 隐藏机制。DSH 还提供人工使用的 `/chrome status|doctor|restart|tabs` 命令；这些命令不替代 Skill 激活。

在 DSH Profile 中安装该包，把它的 `config/cordis.patch.yml.example` 中的 `insert` 条目合并到现有 `cordis.patch.yml`，不要覆盖其他 patch 条目，并把 Bridge 配置放到 `<DSH_HOME>/settings.yaml` 的 `control-chrome` 命名空间。DSH Profile 应包含标准的 `@deepseek-ai/dsh-skill` 服务，以便使用运行时 Skill 注册表和 `skill` 工具；浏览器插件本身不强制注入该可选服务。DSH 包复用本项目的 Bridge 和 Manifest V3 扩展，不会自动安装浏览器扩展，不读取 Chrome Profile 文件，也不会把 Bridge 暴露到 loopback 之外。

加载 Chrome/Edge 扩展：

1. 打开 `chrome://extensions` 或 `edge://extensions`；
2. 开启 Developer mode；
3. 选择 Load unpacked；
4. 选择：
   ```text
   <path-to>\pi-control-chrome\extension
   ```
5. 重启 Pi。

在 Pi 中检查：

```text
/chrome status
/chrome tabs
```

运行测试：

```powershell
npm run check
npm test
npm run test:skill
npm run test:all
npm run pack:check
npm run smoke:e2e
```

`smoke:e2e` 默认使用 Edge，也可以指定 Chrome for Testing：

```powershell
$env:PI_CONTROL_CHROME_BROWSER = "<path-to>\chrome-for-testing\chrome.exe"
npm run smoke:e2e
```

该测试使用隔离的临时浏览器 Profile，不会修改用户日常 Profile。部分已安装的 Google Chrome 版本会拒绝命令行加载 unpacked extension 的参数；验证正常 Chrome Profile 时，应在 `chrome://extensions` 中手动加载 `extension/`。

## 对齐基线

当前以本机 Codex Chrome 插件的以下资料作为行为参考：

```text
<CODEX_HOME>/plugins/cache/openai-bundled/chrome/<version>/
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
- 浏览器登录凭据。

Pi 或 DSH Host 可以按配置启动或复用本地 Bridge，并在默认位置创建配对令牌文件；这不等于读取或修改浏览器 Profile、配置或登录凭据。
