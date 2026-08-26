# 发布与依赖更新检查清单

配套执行 Skill：[`skills/pi-control-chrome-release/SKILL.md`](../skills/pi-control-chrome-release/SKILL.md)。执行发布任务时先加载该 Skill，再按本清单核对。

这份清单适用于同时维护 Pi 根包、Manifest V3 浏览器扩展、DSH 集成包和私有 `dsh-profile-config` Profile 配置仓库的发布流程。发布前必须逐项核对包名、目标版本、依赖版本、lockfile、发布 workflow 和 active DSH Profile，不能只修改或发布其中一个包。`dsh-profile-config` 是新机器 bootstrap 使用的私有配置源，不是 npm 发布面；`<DSH_HOME>/profiles/web` 是安装后的运行副本，两者都要检查。

## 发布面清单

| 发布面 | 权威版本文件 | 必须同步检查的文件 | 发布方式 |
| --- | --- | --- | --- |
| Pi 根包 `pi-control-chrome` | `package.json` | `package-lock.json`、`CHANGELOG.md` | `.github/workflows/publish-pi-control-chrome.yml` |
| 浏览器扩展 | `extension/manifest.json` | `extension/background.js`、根包版本说明 | 随 Pi 根包发布；Manifest 版本号是否同步必须在发布矩阵中明确确认 |
| DSH 包 `@lyd123qw2008/dsh-tool-control-chrome` | `dsh-tool-control-chrome/package.json` | `dsh-tool-control-chrome/pnpm-lock.yaml`、`dsh-tool-control-chrome/pnpm-workspace.yaml`、`dsh-tool-control-chrome/README.md` | `.github/workflows/publish-dsh-tool-control-chrome.yml` |
| 私有 DSH Profile 配置仓库 | `dsh-profile-config/profiles/web/package.json`、`.agent-presets/` | `profiles/web/pnpm-lock.yaml`、`profiles/web/pnpm-workspace.yaml`、`.agent-presets/*/preset.yml`、`.agent-presets/*/agent.cordis.yml`、`README.md`、bootstrap 脚本 | 只提交并合并独立 Profile 配置 PR，不发布 npm 包 |
| active DSH Profile | `<DSH_HOME>/profiles/web/package.json` | Profile 的 `pnpm-lock.yaml`、`pnpm-workspace.yaml` | 不属于仓库发布；在 npm 发布成功后单独更新并重启 DSH |

根包版本、扩展 Manifest 版本、DSH 包版本和 active Profile 版本不是同一个字段。不能因为其中一个版本已经 bump，就假设其他发布面已经更新。

## 发布前必须建立版本矩阵

在修改文件、commit、push 或触发发布 workflow 之前，先记录以下矩阵并核对实际文件内容：

```text
包名/发布面                         当前版本       目标版本       依赖目标       发布 workflow
pi-control-chrome                   <read>         <confirm>       <read>         publish-pi-control-chrome.yml
extension/manifest.json             <read>         <confirm>       n/a            随根包或单独确认
@lyd123qw2008/dsh-tool-control-chrome <read>       <confirm>       pi-control-chrome <target> publish-dsh-tool-control-chrome.yml
私有 dsh-profile-config Profile      <read>         <confirm>       DSH <target>  独立 Profile PR（不发布 npm）
active DSH Profile                  <read>         <confirm>       pi-control-chrome <target> 本地安装
```

至少检查：

```powershell
npm pkg get name version
npm --prefix dsh-tool-control-chrome pkg get name version
npm view pi-control-chrome version dist-tags --json
npm view @lyd123qw2008/dsh-tool-control-chrome version dist-tags --json
```

如果目标包、目标版本或发布范围不明确，先确认再改文件；不要根据上一次发布的版本自行推断。

## 推荐发布顺序

当 DSH 包依赖新的 Pi 根包时，按以下顺序执行：

1. 在 PR 中提交 Pi 根包、扩展代码和对应测试；确认根包 `package.json`、`package-lock.json` 与 Changelog 已同步。
2. 等待 PR CI 通过并合并。
3. 触发 `publish-pi-control-chrome.yml`，确认 workflow 的 check、test、pack 和 publish 全部成功。
4. 用 npm 查询刚发布的根包，确认版本、`latest` 和依赖元数据：

   ```powershell
   npm view pi-control-chrome@<pi-version> version dist-tags dependencies --json
   ```

5. 更新 DSH 仓库包的依赖 specifier、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml`；重点检查 `overrides.pi-control-chrome`，它可能把 DSH 依赖强制固定到旧版本。
6. 将 DSH 包自己的 `package.json` 版本 bump，并同步 README 中的安装示例。
7. 运行 DSH 检查，创建并合并 DSH release PR。
8. 触发 `publish-dsh-tool-control-chrome.yml`，确认发布成功。
9. 用 npm 查询 DSH 包，确认 DSH 版本和它实际声明的 `pi-control-chrome` 依赖：

   ```powershell
   npm view @lyd123qw2008/dsh-tool-control-chrome@<dsh-version> version dist-tags dependencies --json
   ```

10. 在私有 `dsh-profile-config` 仓库中更新 `profiles/web/package.json`、`profiles/web/pnpm-lock.yaml`、`profiles/web/pnpm-workspace.yaml`、`.agent-presets/` 下的自定义 preset composition 和 `preset.yml` 元数据，以及 README 和 bootstrap 相关说明。该仓库的 bootstrap 脚本会从 npm 安装发布包并复制自定义 presets；只更新 active Profile 不会更新新机器的配置源，也不能把这个仓库当作 npm 发布包。
11. 从 `dsh-profile-config` 的 `profiles/web` 运行安装和依赖解析检查，创建并合并独立的私有 Profile 配置 PR；不要为该仓库触发 npm 发布：

    ```powershell
    corepack pnpm --dir profiles/web install --frozen-lockfile
    corepack pnpm --dir profiles/web list @lyd123qw2008/dsh-tool-control-chrome --depth 0
    corepack pnpm --dir profiles/web why pi-control-chrome
    ```

12. 配置 PR 合并后，重新 bootstrap 或把配置同步到 `<DSH_HOME>`，再重启 DSH 做运行验证。

已发布的 npm 版本不可覆盖。如果发现包内容或依赖遗漏，使用新的修订版本修复，不要尝试重新发布同一个版本号。

## 每个包都要运行的检查

Pi 根包：

```powershell
npm run check
npm run test:all
npm run pack:check
```

DSH 包：

```powershell
corepack pnpm --dir dsh-tool-control-chrome run pack:check
```

发布 PR 必须附上实际运行的命令和结果。`npm pack --dry-run` 只能证明 tarball 内容，不等于 npm publish 成功；workflow 成功和 `npm view` 元数据检查都必须完成。

## 发布后更新 active DSH Profile

仓库中的 DSH 依赖更新不会自动修改 active Profile。根包和 DSH 包发布成功后，执行精确版本安装：

```powershell
corepack pnpm --dir <DSH_HOME>/profiles/web add @lyd123qw2008/dsh-tool-control-chrome@<dsh-version>
```

然后检查 Profile 是否存在旧的 root override：

```powershell
corepack pnpm --dir <DSH_HOME>/profiles/web why pi-control-chrome
```

如果 `pnpm-workspace.yaml` 中存在类似配置：

```yaml
overrides:
  pi-control-chrome: <old-version>
```

必须把它更新到目标根包版本，并将该版本加入 `minimumReleaseAgeExclude`（如果 Profile 启用了该策略），再安装一次：

```powershell
corepack pnpm --dir <DSH_HOME>/profiles/web install
corepack pnpm --dir <DSH_HOME>/profiles/web list @lyd123qw2008/dsh-tool-control-chrome --depth 0
corepack pnpm --dir <DSH_HOME>/profiles/web why pi-control-chrome
```

最终应同时看到目标 DSH 版本和目标 `pi-control-chrome` 版本。仅看到 `package.json` 已更新不够，必须检查 `node_modules` 和 lockfile 的实际解析结果。

## 重启后的运行验证

安装 Profile 依赖后必须重启 DSH。然后检查：

```text
/chrome status
```

并通过浏览器工具确认：

- `connected: true`；
- Bridge 版本为目标根包版本；
- extension 已连接；
- `targetStability.stable: true`；
- `turnCleanup`、`turnScopedMarks`、`retainedCleanup` 和 `debuggerLeaseRecovery` 能力存在。

如果出现 `bridge_only` 或 `extension_not_connected`：

1. 先重试一次 `browser_status` 或 `/chrome status`；
2. 不要在扩展未连接时继续发送浏览器操作；
3. 必要时重新加载 unpacked extension 或执行 `/chrome connect`；
4. 恢复后再验证页面快照、JavaScript、turn cleanup 和 session switch。

扩展 Manifest 版本可能与 npm 根包版本不同，不能单独用扩展显示版本判断根包是否发布成功；必须同时看 Bridge health、Profile 依赖解析和 npm 元数据。

## 发布执行约束

后续任何“提交并发布”请求都必须先完成版本矩阵检查，并在执行前明确列出：

- 将要提交的包名和版本；
- 将要发布的包名和版本；
- 依赖更新涉及的 package.json、lockfile、override 和 README；
- 对应的 GitHub Actions workflow；
- 发布后 active Profile 是否需要更新。

没有完成这份核对时，不应直接 commit、merge 或 publish。
