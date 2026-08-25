# Codex 对齐的浏览器运行时生命周期方案

## 目标

浏览器运行时应当跨多个 turn 复用。普通 turn 结束不应关闭 Tab、断开 Bridge、清除浏览器上下文或要求模型再次加载 Skill。

模型负责表达浏览器任务的资源意图，运行时负责校验 ownership、执行安全操作、处理并发和提供最终兜底。Tab、浏览器上下文、Bridge 和工具激活不是同一个生命周期。

本方案以仓库中的 Codex 对齐默认值为行为基线，明确 Pi Extension 和 DSH 插件的实现差异。

## 核心决策

### Turn 不是浏览器任务边界

turn 结束只表示一次模型调用完成，不表示浏览器任务完成。浏览器任务可以跨多个 turn 继续使用同一组 Tab、同一浏览器 target 和同一 Bridge 连接。

普通 turn 结束执行轻量 checkpoint，不执行破坏性清理：

- 不关闭 Tab 或 Tab group；
- 不 release claim；
- 不断开 Bridge；
- 不清除浏览器插件上下文；
- 不隐藏或注销 browser tools；
- 不向聊天 transcript 注入清理消息；
- 不自动重新加载 Skill。

checkpoint 只更新运行时状态，例如最后使用时间、活动请求和浏览器 target 的观察结果。checkpoint 没有模型可见的工具结果。

### Skill activation 是 Session 级状态

首次明确需要浏览器时，模型加载一次浏览器 Skill，运行时激活当前 Agent/session 的 browser tools。激活状态持续到 Agent/session 结束、插件卸载或模型明确请求 context reset。

后续 turn 直接复用已经激活的工具，不重复加载 Skill，不重复写入 Skill 内容，不重新初始化 Bridge。

工具 schema 仍可能出现在后续模型请求中。减少 schema token 成本属于工具目录分层或工具 facade 的优化，不通过每个 turn 清除并重新激活来解决。

### 模型决定任务级资源意图

任务完成默认保留浏览器状态，不自动调用 finalize。只有用户明确要求关闭临时 Tab、释放 claim 或清理浏览器任务时，模型才调用浏览器 finalize 操作。模型的请求不是对浏览器 API 的无条件授权，运行时必须根据 ownership 和资源状态执行或拒绝。

建议保留现有 browser_cleanup 名称以减少工具迁移成本，但将其语义定义为用户明确要求后执行的 task finalize，而不是任务完成时自动调用，也不是工具注销或 session reset：

- 关闭当前 Agent 创建且允许关闭的临时 Tab；
- 释放当前 Agent 对用户 Tab 的 claim，但不关闭用户 Tab；
- 保留 handoff 和 deliverable Tab；
- 按请求释放 DevTools lease；
- 保留当前 session 的 browser tools；
- 保留健康的 Bridge 连接；
- 返回紧凑的结构化结果，不生成额外聊天说明。

如果需要清除浏览器上下文或隐藏 browser tools，模型必须调用单独的显式 context reset 操作。task finalize 不应隐式执行 context reset。

### Bridge 是宿主资源

Bridge 通常由多个浏览器操作和可能的多个 session 共享。模型可以提出断开当前浏览器客户端的请求，但不能直接停止共享 Bridge 进程。

默认规则如下：

- 普通 turn 不停止 Bridge；
- task finalize 不停止 Bridge；
- 健康 Bridge 跨 turn 和多个浏览器任务复用；
- Bridge 断开时自动重连或重建客户端连接；
- 插件卸载、宿主退出或人工生命周期命令负责停止 Bridge；
- 如果提供模型可见的 disconnect 操作，它只能断开当前客户端，并必须检查活动请求和共享使用者。

## 资源所有权

### Tab 分类

每个受浏览器插件管理的 Tab 必须携带可验证的 ownership 和 provenance：

- 用户已有 Tab；
- 当前 Agent 创建的 Tab；
- 当前 Agent claim 的用户 Tab；
- handoff Tab；
- deliverable Tab；
- 其他 session 创建或管理的 Tab。

运行时不能根据 Tab 标题、当前选中状态或模型文字推断所有权。关闭、release 和 handoff 操作必须使用扩展保存的 ownership 记录。

### Tab 和 Tab group 规则

模型可以请求关闭 Tab 或 Tab group，但运行时必须执行以下规则：

| 资源 | finalize 时的默认处理 |
| --- | --- |
| 当前 Agent 创建的临时 Tab | 模型请求关闭且没有保留标记时可以关闭 |
| 当前 Agent claim 的用户 Tab | release，保留页面和用户原有分组 |
| 用户已有 Tab | 不关闭 |
| handoff Tab | 保留并释放控制权 |
| deliverable Tab | 保留并释放控制权 |
| 其他 session 的 Tab | 拒绝操作 |
| 混合 ownership 的 Tab group | 不关闭整个 group，只处理明确属于当前 Agent 的 Tab，或返回需要人工确认的结果 |

Tab group 的关闭不能绕过单个 Tab 的 ownership 检查。空的 keep 列表也不能因此关闭共享 runtime、Bridge 或宿主辅助进程。

### Agent disposal 兜底

Agent disposal、session switch/fork 和插件卸载是宿主生命周期边界，不是普通任务边界。宿主在这些边界执行最终 cleanup：

- 关闭仍属于当前 Agent 的临时 Tab；
- release 当前 Agent claim 的用户 Tab；
- 保留 handoff 和 deliverable Tab；
- 清理该 Agent 的 DevTools lease；
- 隐藏或注销该 Agent 的 browser tools；
- 不影响其他 Agent、session 或共享 Bridge。

如果模型在 disposal 前没有表达 handoff 或 deliverable 意图，运行时只能依据已记录的 ownership 状态执行兜底规则，不能依据聊天文本猜测。

## 生命周期状态

浏览器工具激活、任务资源和 Bridge 状态分别维护。

### 工具激活状态

    inactive
      -> Skill 成功加载
    active-sticky
      -> 显式 context reset / Agent disposal / session 结束
    inactive

普通 turn、task finalize 和 Bridge reconnect 不改变 active-sticky。

### 任务资源状态

    no-resources
      -> browser operation
    owned
      -> model finalize
    finalizing
      -> cleanup success
    released

    owned
      -> cleanup failure
    cleanup-unknown
      -> retry or disposal cleanup

只有 cleanup 明确成功时，资源才可以从 owned 或 cleanup-unknown 转为 released。失败不能清除 ownership 记录，也不能把资源标记为 clean。

### Bridge 状态

    stopped
      -> first browser operation
    connected
      -> connection failure
    reconnecting
      -> health restored
    connected

    connected
      -> plugin disposal / explicit host disconnect
    stopped

Bridge 状态变化不应自动改变 browser tools activation，也不应自动关闭 Tab。

## 显式模型操作

### browser_cleanup / task finalize

该操作只能在用户明确要求关闭临时 Tab、释放 claim 或清理浏览器任务后使用，用于表达当前浏览器任务的资源意图，而不是结束当前 session。建议支持以下信息：

- 要保留的 Tab id 或 ownership handle；
- 要关闭的 Agent-created Tab；
- 要 release 的 claimed user Tab；
- 是否释放 DevTools lease；
- 是否将 Tab 标记为 handoff 或 deliverable。

运行时应返回紧凑结果，例如：

    {
      "ok": true,
      "closed": [12, 15],
      "released": [18],
      "kept": [21],
      "toolsActive": true,
      "bridge": "connected"
    }

成功 finalize 后，browser tools 仍然可用。模型下一次需要浏览器时不需要重新加载 Skill。

### browser_context_reset

该操作只能在用户明确要求清除当前浏览器插件上下文后使用。它可以：

- 清除当前 Agent 的 target tracker；
- 清除已完成的 task ownership 状态；
- 隐藏或注销 browser tools；
- 保留健康 Bridge，除非调用方明确要求断开当前客户端；
- 保留 handoff 和 deliverable Tab。

context reset 必须先完成可执行的 resource finalize。cleanup 失败时不得清除 recovery record 或伪造成功结果。

### Bridge disconnect

Bridge disconnect 不是 task finalize 的隐含步骤。若实现模型可见的 disconnect 操作，运行时必须：

- 阻止新的当前客户端请求；
- 等待或取消活动请求；
- 保留未完成资源记录；
- 断开当前客户端而不是无条件停止共享 Bridge；
- 返回后续 reconnect 所需的最小状态。

## 错误、取消和恢复

cleanup、context reset 和 disconnect 都必须幂等，并按 session 串行化。并发的 finalize、turn checkpoint、Agent disposal 和 plugin disposal 不能互相覆盖状态。

失败处理规则如下：

- Bridge 离线时保留工具 activation 和 ownership 状态；
- cleanup 返回明确的失败结果，不得伪装成成功；
- 当前流程可以重试 browser_status、finalize 或 reconnect；
- session 切换不能因为 cleanup 失败而丢弃旧 session 的 recovery record；
- 不自动切换到另一个浏览器 target；
- plugin disposal 继续尝试最终 cleanup，但不能阻塞宿主退出；
- 其他 session 的资源和 Bridge 请求不能被当前 session 的失败清理影响。

Pi 的工具错误必须通过 Pi 认可的错误通道传播。仅返回普通文本 Browser error 不能作为 cleanup 失败的内部状态判断依据。

## Pi 和 DSH 实现要求

### Pi Extension

Pi 继续使用 pi.registerTool() 和 pi.setActiveTools()，但需要调整生命周期：

- Skill 成功后保持 active tool set，直到 session 或显式 context reset；
- turn_end 只做 checkpoint，不调用 cleanup；
- browser_cleanup 只 finalize 任务资源，不 reset activation；
- 只有成功的 browser_context_reset、session teardown 或 plugin disposal 才隐藏 browser tools；
- 浏览器工具必须串行执行，或通过 session-local operation queue 保护共享状态；
- errorResult 不能让 cleanup 失败在 tool_result 中表现为成功；
- session switch/fork 失败时保留旧 session 的 recovery record；
- 健康 Bridge 在 turn 和 task 之间保持复用。

### DSH Plugin

DSH 继续使用 Agent-scoped dynamic registration 和 registration disposer：

- Skill 成功后注册当前 Agent 的 browser tools；
- 普通 session/event turn/end 不调用浏览器 cleanup，也不调用 disposer；
- task finalize 清理资源但保留 activation；
- context reset 成功后才调用当前 activation 的 disposer；
- Agent disposal 和 plugin disposal 执行最终 cleanup；
- cleanup 失败时保留 activation、ownership 和 recovery record；
- Bridge client 在插件级复用，不随 turn 或 task 停止；
- 多个 Agent 的 cleanup、target tracker 和 Bridge 请求按 session 隔离并安全串行化。

## 模型上下文和 Token 成本

浏览器 runtime 状态不应通过每个 turn 的自然语言消息持续追加到聊天上下文。模型只在以下场景获取状态：

- 首次 Skill 加载结果；
- 模型主动调用 browser_status；
- 浏览器操作返回必要的状态；
- cleanup、handoff 或 deliverable 操作返回结果。

如果 browser tool schema 的长期 token 成本过高，应优先采用以下方案之一：

1. 将核心 Tab 操作和高级 CDP/Network/Console 工具分层；
2. 对高级能力采用显式 capability activation；
3. 提供低参数数量的 browser facade；
4. 让模型使用 browser_status 按需获取结构化状态。

不应通过每个 turn 注销工具、重新加载 Skill 和追加 lifecycle 消息来降低 token 成本。

## 测试计划

### 生命周期单元测试

1. Skill 成功后 browser tools 在连续多个 turn 保持激活；
2. 普通 turn 结束不关闭 Tab、不 release claim、不停止 Bridge；
3. task finalize 只处理当前 Agent 有权处理的资源；
4. claimed user Tab 被 release 而不是 close；
5. handoff 和 deliverable Tab 始终保留；
6. 混合 ownership 的 Tab group 不会整体关闭；
7. task finalize 成功后 browser tools 仍然激活；
8. context reset 成功后才隐藏或注销 browser tools；
9. cleanup 失败保留 ownership、activation 和 recovery record；
10. cleanup 重试成功后状态才转为 released；
11. Agent disposal 关闭临时 Agent Tab，但不影响用户 Tab 或其他 session；
12. Bridge 在普通 turn 和 task finalize 后保持连接；
13. plugin disposal 等待活动请求并停止 Bridge；
14. 并发 finalize、checkpoint 和 disposal 按 session 串行化。

### Pi 和 DSH 集成测试

1. 连续多个 turn 的 assembled tool set 不重复加载 Skill；
2. Skill 内容只产生一次模型可见加载结果；
3. task finalize 的结果不会隐藏 browser tools；
4. context reset 后旧 tool snapshot 在执行层被拒绝；
5. session switch/fork 会执行最终 cleanup；
6. cleanup 失败后 session recovery 可以继续重试；
7. Bridge 断开后 reconnect 不丢失仍有效的 session ownership；
8. Pi sibling browser calls 不会与 finalize 并发；
9. DSH Agent-scoped disposer 只在显式 context reset 或 Agent disposal 时执行。

### 真实验收

1. 新建 session，不请求浏览器，确认没有 browser tools；
2. 明确请求浏览器，确认 Skill 只加载一次；
3. 连续多个 turn 操作同一个 Tab，确认 Tab、Bridge 和 browser tools 持续可用；
4. 普通 turn 结束后检查没有自动 close、release、disconnect 或 lifecycle transcript 噪音；
5. 模型调用 task finalize，确认指定资源按 ownership 处理，但 browser tools 仍可用；
6. 模型调用 context reset，确认工具状态按显式请求重置；
7. 不调用 finalize 直接销毁 Agent，确认宿主兜底 cleanup 生效；
8. Bridge 暂时断开后重试 cleanup，确认 ownership 状态没有丢失；
9. 多 session 同时使用浏览器时，确认一个 session 不能清理另一个 session 的资源。

## 发布边界

本方案改变的是浏览器插件的运行时生命周期，不改变 DSH 的 get_goal、repeat-tool-reminder 或其他 goal 语义。

实现时应同步更新 Pi Extension、DSH browser plugin、Skill 文案、README、测试和 changelog。构建和单元测试通过后，还必须在真实 Pi/DSH runtime 中验证跨 turn 复用、显式 finalize、context reset、session teardown 和 plugin disposal。

## 外部参考

- [Codex 对齐默认值](../CODEX-ALIGNMENT.zh-CN.md)
- [Codex browser runtime setup 和 handle 生命周期](https://github.com/openai/codex/issues/27128)
- [Codex Tab ownership 和用户 Tab 保护](https://github.com/openai/codex/issues/35231)
- [Codex finalize 与 turn completion 的清理竞态](https://github.com/openai/codex/issues/35425)
- [Codex browser Tab 跨 turn 保持](https://github.com/openai/codex/issues/33133)
