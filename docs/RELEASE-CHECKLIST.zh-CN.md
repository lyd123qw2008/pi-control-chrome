# 发布与依赖更新检查清单

配套执行 Skill：[`skills/pi-control-chrome-release/SKILL.md`](../skills/pi-control-chrome-release/SKILL.md)。执行发布任务时先加载该 Skill，再按本清单核对。

这份清单适用于同时维护 Pi 根包、Manifest V3 浏览器扩展、DSH 集成包、GitHub Release 和私有 `dsh-profile-config` Profile 配置仓库的发布流程。发布前必须逐项核对包名、目标版本、依赖版本、lockfile、发布 workflow、GitHub Release 和 active DSH Profile，不能只修改或发布其中一个发布面。`dsh-profile-config` 是新机器 bootstrap 使用的私有配置源，不是 npm 发布面；`<DSH_HOME>/profiles/web` 是安装后的运行副本，两者都要检查。

## 发布面清单

| 发布面 | 权威版本文件 | 必须同步检查的文件 | 发布方式 |
| --- | --- | --- | --- |
| Pi 根包 `pi-control-chrome` | `package.json` | `package-lock.json`、`CHANGELOG.md` | `.github/workflows/publish-pi-control-chrome.yml` |
| 浏览器扩展 | `extension/manifest.json` | `extension/background.js`、根包版本说明 | 随 Pi 根包发布；Manifest 版本号是否同步必须在发布矩阵中明确确认 |
| DSH 包 `@lyd123qw2008/dsh-tool-control-chrome` | `dsh-tool-control-chrome/package.json` | `dsh-tool-control-chrome/pnpm-lock.yaml`、`dsh-tool-control-chrome/pnpm-workspace.yaml`、`dsh-tool-control-chrome/README.md` | `.github/workflows/publish-dsh-tool-control-chrome.yml` |
| 私有 DSH Profile 配置仓库 | `dsh-profile-config/profiles/web/package.json`、`.agent-presets/` | `profiles/web/pnpm-lock.yaml`、`profiles/web/pnpm-workspace.yaml`、`.agent-presets/*/preset.yml`、`.agent-presets/*/agent.cordis.yml`、`README.md`、bootstrap 脚本 | 只提交并合并独立 Profile 配置 PR，不发布 npm 包 |
| active DSH Profile | `<DSH_HOME>/profiles/web/package.json` | Profile 的 `pnpm-lock.yaml`、`pnpm-workspace.yaml` | 不属于仓库发布；在 npm 发布成功后单独更新，由维护者手动重启 DSH |
| GitHub Release | 根包 `package.json` 版本对应的 `v<pi-version>` tag | release notes、目标 commit、CI/Compatibility 和 npm 链接 | npm 包发布成功后创建或更新；DSH 版本作为同一 Release 的 companion package 记录 |

根包版本、扩展 Manifest 版本、DSH 包版本和 active Profile 版本不是同一个字段。不能因为其中一个版本已经 bump，就假设其他发布面已经更新。GitHub Release 的 tag 以 Pi 根包版本为准；不能为同一个根包版本重复创建 tag，也不能把 DSH 版本误当成根包 tag。

## DSH 重启约束

发布 Agent **不得主动重启 DSH**，也不得调用 `/chrome restart`、重启脚本、`taskkill` 或另起一个 DSH 服务来代替重启。重启可能断开现有会话，也可能无法恢复到同一个运行时。Profile 依赖安装和 lockfile 校验完成后，必须停在“等待维护者手动重启”状态；只有维护者明确确认已经重启后，Agent 才能进行只读的 `/chrome status`、`browser_status` 和页面验证。维护者未确认重启时，不得宣称 active Profile 的运行时验证完成。

## 发布前必须建立版本矩阵

在修改文件、commit、push 或触发发布 workflow 之前，先记录以下矩阵并核对实际文件内容：

```text
包名/发布面                         当前版本       目标版本       依赖目标       发布 workflow / 路径
pi-control-chrome                   <read>         <confirm>       <read>         publish-pi-control-chrome.yml
extension/manifest.json             <read>         <confirm>       n/a            随根包或单独确认
@lyd123qw2008/dsh-tool-control-chrome <read>       <confirm>       pi-control-chrome <target> publish-dsh-tool-control-chrome.yml
私有 dsh-profile-config Profile      <read>         <confirm>       DSH <target>  独立 Profile PR（不发布 npm）
active DSH Profile                  <read>         <confirm>       pi-control-chrome <target> 本地安装
GitHub Release                      n/a            v<pi-target>   根包/DSH links gh release create/edit
```

至少检查：

```powershell
npm pkg get name version
npm --prefix dsh-tool-control-chrome pkg get name version
npm view pi-control-chrome version dist-tags --json
npm view @lyd123qw2008/dsh-tool-control-chrome version dist-tags --json
```

如果目标包、目标版本或发布范围不明确，先确认再改文件；不要根据上一次发布的版本自行推断。

## PR 描述格式门禁

创建、编辑或合并 PR 前，必须确认 GitHub 上的正文是实际 Markdown 换行，而不是字面量的 `\n`、`\r` 或 `\t`。PowerShell、JSON 和 shell 命令中的转义方式不同；不要把包含 `\n` 的普通双引号字符串直接传给 `gh pr create --body` 或 `gh pr edit --body`。

推荐使用真实换行的 here-string 或正文文件：

```powershell
@'
## Summary

- concise change summary

## Validation

- `npm run test:all`
- `npm run check`
'@ | Set-Content -Encoding utf8 pr-body.md

gh pr create --title "<title>" --body-file pr-body.md
# 修改已有 PR 时使用：
gh pr edit <number> --body-file pr-body.md
```

PR 创建或编辑后，必须读取远端正文进行渲染前检查：

```powershell
gh pr view <number> --repo <owner>/<repo> --json title,body,state,mergeStateStatus,url
$body = (gh pr view <number> --repo <owner>/<repo> --json body --jq '.body') -join "`n"
$literalEscapeCount = [regex]::Matches($body, '\\[nrt]').Count
$realLineBreakCount = [regex]::Matches($body, "`r?`n").Count
[pscustomobject]@{ literalEscapeCount = $literalEscapeCount; realLineBreakCount = $realLineBreakCount }
if ($literalEscapeCount -ge 2 -and $literalEscapeCount -gt $realLineBreakCount) {
  throw 'PR body appears to contain encoded line breaks; fix it before merge'
}
```

检查结果必须同时满足：标题正确、`##` 标题和项目符号正常分行、代码块可读、验证命令完整、状态和合并条件符合预期。发现字面量转义符或 Markdown 粘连时，先用 `--body-file` 修复并再次读取确认，禁止直接合并。

## 发布前置 Gate 与发布 workflow

推送到 `main` 后，`CI` 与 `Compatibility and Profile Validation` 会针对同一个 commit 并行运行。它们是发布的正式验证 Gate：

- `CI`：静态检查、Bridge tests、包内容 dry-run，以及真实安装 npm tarball 的 `test:package-install` smoke test；
- `Compatibility`：Root Node 22/24、DSH Node 22/24、Chrome/Edge 隔离浏览器 E2E；
- 同一个 workflow/ref 的旧 push run 会被新 push 自动取消，避免过期 commit 占用浏览器 runner；
- `checkout`、`setup-node` 和 `pnpm/action-setup` 使用 Node 24 运行时版本，避免 Actions Node 20 弃用告警。

公开仓库的 CI **不校验私有 Profile**。私有 `dsh-profile-config` 的兼容性由该私有仓库自己的 workflow 负责（见下方“私有 Profile 校验”）。这样公开构建不依赖任何私有仓库或密钥，外部贡献者 fork 后无需额外凭据也能拿到绿色构建。

## 私有 Profile 校验

私有 Profile 的校验归属私有仓库 `lyd123qw2008/dsh-profile-config`，公开仓库不参与：

- 校验脚本 `profile-compatibility.mjs` 与其测试位于该私有仓库，不在本仓库；
- 该仓库的 `profile-check` workflow 在 Profile 或脚本变更时自动校验 Profile 元数据、lockfile importer、packages/snapshots 条目与 workspace 版本允许列表的一致性；
- **跨仓库断言**（Profile 固定的插件/根包版本是否等于本次发布的版本）是发布时的显式步骤，在私有仓库执行：

  ```powershell
  node profile-compatibility.mjs --profile profiles/web --plugin-version <dsh-version> --pi-version <pi-version>
  ```

这样设计的原因：公开仓库不应当为了判断自己的构建是否通过而访问私有仓库，也不应当把私有仓库的名称、目录结构和版本固定策略暴露给外部贡献者。私有 Profile 的 lockfile 只有在包发布之后才能引用对应版本，因此这项校验天然只能在发布之后、在私有侧执行。

发布 workflow 不再重复执行全量测试。它们会先用 `gh run list` 校验当前 commit 已有成功的 `CI` 和 `Compatibility` run，然后只执行发布所需的轻量步骤：版本校验、必要的 DSH 构建、pack 和 npm publish。发布 workflow 保留 `cancel-in-progress: false`，避免发布过程中被后续 push 中断。

如果本地已经完成全量测试，可以直接 push；不需要为了触发发布再次本地重复测试。正式发布前仍必须等待 GitHub 上同一 commit 的两个 Gate 成功。

## GitHub Release 维护规则

每次公开 npm 发布都必须同步维护 GitHub Release：

- Pi 根包目标版本 `<pi-version>` 对应 tag `v<pi-version>`；该 tag 必须指向本次发布所验证的精确 commit；
- Release notes 使用真实 Markdown 文件，至少包含功能摘要、Pi/扩展/DSH 版本、CI/Compatibility run 链接和 npm 链接；
- 根包首次发布时使用 `gh release create`；同一根包版本的 DSH companion 发布或 Profile 更新完成后，使用 `gh release edit` 补充 notes，不重复创建 tag；
- 创建或编辑前先执行 `gh release view v<pi-version>`，发现已有 release 时不得覆盖成另一个 commit；
- 创建或编辑后必须重新读取 `gh release view`，确认 `isDraft: false`、`isPrerelease: false`、tag、目标 commit 和正文均正确；
- GitHub Release 是发布记录，不替代 npm Trusted Publishing，也不允许用 Release 页面状态代替 workflow 和 `npm view` 验证。

推荐命令（`<notes-file>` 必须包含真实换行）：

```powershell
gh release view v<pi-version> --json tagName,targetCommitish,isDraft,isPrerelease,url
# 不存在时：
gh release create v<pi-version> --target <commit-sha> --title "v<pi-version> — <title>" --notes-file <notes-file>
# 已存在且需要补充 companion package 或验证链接时：
gh release edit v<pi-version> --target <commit-sha> --title "v<pi-version> — <title>" --notes-file <notes-file>
gh release view v<pi-version> --json tagName,targetCommitish,isDraft,isPrerelease,body,url
```

## 推荐发布顺序

当 DSH 包依赖新的 Pi 根包时，按以下顺序执行：

1. 在 PR 中提交 Pi 根包、扩展代码和对应测试；确认根包 `package.json`、`package-lock.json` 与 Changelog 已同步。
2. 等待 PR CI 通过并合并，并等待合并后同一个 commit 的 `CI` 与 `Compatibility` Gate 全部成功。
3. 触发 `publish-pi-control-chrome.yml`，填写 `expected_version`；workflow 会校验当前 commit 的两个 Gate，然后执行版本校验、pack 和 publish。
4. 用 npm 查询刚发布的根包，确认版本、`latest` 和依赖元数据：

   ```powershell
   npm view pi-control-chrome@<pi-version> version dist-tags dependencies --json
   ```

5. 创建或更新 GitHub Release `v<pi-version>`，以本次 Gate 验证的精确 commit 为目标；notes 先记录 Pi 和扩展版本、功能摘要、CI/Compatibility 链接，后续再补充 DSH companion 信息。
6. 更新 DSH 仓库包的依赖 specifier、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml`；重点检查 `overrides.pi-control-chrome`，它可能把 DSH 依赖强制固定到旧版本。
7. 将 DSH 包自己的 `package.json` 版本 bump，并同步 README 中的安装示例。
8. 运行 DSH 检查，创建并合并 DSH release PR。
9. 触发 `publish-dsh-tool-control-chrome.yml`，填写 `expected_version`；workflow 会校验当前 commit 的两个 Gate，执行必要的 install/build、pack 和 publish。
10. 用 npm 查询 DSH 包，确认 DSH 版本和它实际声明的 `pi-control-chrome` 依赖：

   ```powershell
   npm view @lyd123qw2008/dsh-tool-control-chrome@<dsh-version> version dist-tags dependencies --json
   ```

11. 更新同一个 `v<pi-version>` GitHub Release notes，补充 DSH 版本、DSH publish workflow、npm 元数据和 Profile 验证链接；不要为 DSH companion 单独创建一个与根包版本混淆的 `v<dsh-version>` tag。
12. 在私有 `dsh-profile-config` 仓库中更新 `profiles/web/package.json`、`profiles/web/pnpm-lock.yaml`、`profiles/web/pnpm-workspace.yaml`、`.agent-presets/` 下的自定义 preset composition 和 `preset.yml` 元数据，以及 README 和 bootstrap 相关说明。该仓库的 bootstrap 脚本会从 npm 安装发布包并复制自定义 presets；只更新 active Profile 不会更新新机器的配置源，也不能把这个仓库当作 npm 发布包。
13. 从 `dsh-profile-config` 的 `profiles/web` 运行安装、依赖解析和 Profile 兼容性检查，创建并合并独立的私有 Profile 配置 PR；不要为该仓库触发 npm 发布：

    ```powershell
    corepack pnpm --dir profiles/web install --frozen-lockfile
    corepack pnpm --dir profiles/web list @lyd123qw2008/dsh-tool-control-chrome --depth 0
    corepack pnpm --dir profiles/web why pi-control-chrome
    node profile-compatibility.mjs --profile profiles/web --plugin-version <dsh-version> --pi-version <pi-version>
    ```

    该私有仓库自带 `profile-check` workflow，会自动校验 Profile 元数据与 lockfile 的一致性；带 `--plugin-version` / `--pi-version` 的跨仓库断言是发布时的额外确认步骤。

14. 配置 PR 合并后，重新 bootstrap 或把配置同步到 `<DSH_HOME>`，再重启 DSH 做运行验证。

已发布的 npm 版本不可覆盖。如果发现包内容或依赖遗漏，使用新的修订版本修复，不要尝试重新发布同一个版本号。

## 每个包都要运行的检查

Pi 根包：

```powershell
npm run check
npm run test:all
npm run pack:check
npm run test:package-install
```

DSH 包：

```powershell
corepack pnpm --dir dsh-tool-control-chrome run pack:check
```

发布 PR 必须附上实际运行的命令和结果。`npm pack --dry-run` 只能证明 tarball 内容，不等于 npm publish 成功；workflow 成功和 `npm view` 元数据检查都必须完成。

## 发布后更新 active DSH Profile

仓库中的 DSH 依赖更新不会自动修改 active Profile。根包和 DSH 包发布成功后，执行精确版本安装。如果 Profile 链接了本地 DSH workspace 包，并由运行中的 DSH 安装提供 peer 依赖，先在 `pnpm-workspace.yaml` 顶层声明：

```yaml
# <DSH_HOME>/profiles/web/pnpm-workspace.yaml
# pnpm 11 使用 workspace YAML 的 camelCase 配置，不要依赖 .npmrc 中的旧写法。
autoInstallPeers: false
```

这样 lockfile 的 `settings.autoInstallPeers` 也必须为 `false`。pnpm 11 不可靠地读取 `.npmrc` 中的 `auto-install-peers=false`；如果存在该旧配置，应迁移到 workspace YAML。然后带显式的一次性参数执行更新：

```powershell
corepack pnpm --dir <DSH_HOME>/profiles/web add @lyd123qw2008/dsh-tool-control-chrome@<dsh-version> --config.auto-install-peers=false
```

如果命令因本地链接 DSH 包产生的 `>=0.1.1 <0.2.0-0` 等 peer 范围报 `ERR_PNPM_NO_MATCHING_VERSION`，不要发布新版本或回退包版本；这是把 workspace peer 当成 registry 依赖解析造成的。设置 `autoInstallPeers: false`、重新生成 lockfile 后重试。`pnpm peers check` 仍可能把由 DSH 安装提供的 peers 列为 missing，这属于预期警告，不作为失败条件；应以 `pnpm list`、`pnpm why`、实际 `node_modules` manifest 和重启后的运行验证为准。

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
- `turnCleanup`、`turnScopedMarks`、`retainedCleanup`、`debuggerLeaseRecovery` 和 `tabIncarnationFence` 能力存在；
- 显式 `browser_cleanup({ recoverStale: true })` 只忘记未知 runtime 的 ownership 记录，不关闭 Tab，并在 `recovered` 返回记录的 id。

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
- 对应的 GitHub Release tag、notes 和目标 commit；
- 发布后 active Profile 是否需要更新。

没有完成这份核对时，不应直接 commit、merge 或 publish。
