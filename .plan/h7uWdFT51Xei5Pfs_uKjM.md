# 调整“追求目标”菜单为待目标发送行为

## 摘要与范围

将聊天输入框“+”菜单里的“追求目标”行为从“点击后立即把当前输入内容设置为目标”调整为“点击后进入待目标状态，下一次用户发送消息时再把该消息文本作为目标内容”。

范围包含：
- `InputArea.tsx` 中“追求目标”开关状态、发送行为、禁用条件和可见待状态提示。
- `use-chat-actions.ts` 中目标设置与普通用户消息发送的组合逻辑。
- 与隐藏 `<system-reminder>` 相关的用户消息内容构造，确保模型可见但聊天 UI 不直接显示。
- 必要的 `chat.json` i18n 文案补充。

不改动：
- Goal 数据库 schema、主进程 goal runtime、`/goal` slash command 的既有控制语义。
- GoalSessionBar 的既有暂停、恢复、清除、编辑逻辑，除非为显示待目标状态需要最小接入。

## 已确认需求

1. 点击“追求目标”菜单项不能立即读取当前输入并设置目标。
2. 点击“追求目标”只进入待目标状态，不清空、不修改当前输入框内容。
3. 待目标状态下，用户下一次发送仍作为正常聊天消息发送并触发模型运行。
4. 同一次发送会把用户消息文本内容设置/激活为当前 session 的目标 objective。
5. 触发目标修改时，需要向模型上下文增加 `<system-reminder>` 信息。
6. 该 `<system-reminder>` 不应直接显示在聊天 UI 中。
7. 空输入时也应允许先打开“追求目标”待状态，用户之后再输入目标。

## 验收标准

- 在输入框为空时，打开“+”菜单，“追求目标”可点击；点击后开关/提示进入待目标状态。
- 点击“追求目标”后，不调用 `setGoal`，不创建 goal，不清空输入框，不发送消息。
- 若点击前输入框已有文本，该文本保留；用户按发送后才作为目标内容。
- 待目标状态下按发送：
  - 普通 user message 正常出现在聊天记录中；
  - assistant 正常开始生成；
  - session goal 被设置为该条消息的文本 objective，状态为 `active`；
  - 模型上下文中包含隐藏 `<system-reminder>`，说明当前目标已设置/更新；
  - UI 中不显示 `<system-reminder>` 内容。
- 若用户在待目标状态再次点击“追求目标”，取消待目标状态，不改变已有 goal。
- 若已有 active goal，“追求目标”菜单不修改 goal；暂停、恢复、清除、编辑仍通过 GoalSessionBar 控制。
- `npm run typecheck` 和 `npm run lint` 通过。

## 设计方向

### 状态设计

在 `InputArea.tsx` 增加本地待目标状态，例如：
- `pendingGoalMode: boolean`

派生展示状态：
- `goalModeEnabled = pendingGoalMode || activeGoal?.status === 'active'`

行为规则：
- 无 active goal 且用户点击开启：只 `setPendingGoalMode(true)`，并聚焦输入框。
- pending 状态下再次点击：`setPendingGoalMode(false)`。
- 有 active goal 时菜单仅反映 active 状态，不通过菜单修改 goal。
- session/draft 切换时清理 pending 状态，避免待状态串到其他会话。
- 成功发送并提交 goal 后清理 pending 状态。

### 发送设计

在 `InputArea.tsx` 的 `handleSend` 中：
- 继续构造正常消息文本 `message`，不阻断普通发送。
- 如果 `pendingGoalMode` 为 true：
  - 从 `liveEditorState.serializedText.trim()` 提取 objective；
  - 用 `validateGoalObjective` 校验；
  - 校验失败则 toast 并不发送，等待用户修正或取消待状态；
  - 校验成功则调用 `onSend(message, images, { ..., goalObjective: objective })`。
- 如果 `pendingGoalMode` 为 false：保持现有普通发送逻辑。

### 目标设置与 hidden reminder 设计

调整 `use-chat-actions.ts` 中 `options.goalObjective` 逻辑：
- 不再在发送前 `setGoal(...)` 后直接 `return`。
- 在确保 session 存在、消息会正常发送的同一发送流程里：
  1. 校验 `goalObjective`；
  2. 调用 `useGoalStore.getState().setGoal({ sessionId, objective, status: 'active' })`；
  3. 若失败，toast 并中止本次发送，避免模型误以为目标已生效；
  4. 若成功，继续正常构建 user message 和 assistant placeholder。
- 在构建 user message 的 `textBlocks` 时，如果本次发送带有成功设置的 `goalObjective`，插入一个隐藏 reminder 文本块，类似现有 queued message 机制：
  - `type: 'text'`
  - `text: '<system-reminder>\nThe current session goal has been set/updated from this user message. Objective: ...\n</system-reminder>'`
- reminder 放在用户可见文本块之前，确保模型先获得状态提醒。
- 不把 reminder 作为单独可见消息插入。

### UI 显示设计

在 `InputArea.tsx`：
- pending goal 状态显示轻量 banner/chip，例如“追求目标已准备：下一条消息会作为目标并正常发送”。
- 使用 i18n key，不硬编码中文 UI。
- placeholder 可选地在 pending 状态下替换为“输入目标并发送...”文案。
- send 按钮仍遵循普通文本/附件发送规则；但 pending goal 要求文本 objective 有效。

在 `UserMessage.tsx`：
- 当前 `extractEditableUserMessageDraft` 已通过 `image-attachments.ts` 去除 system reminder，用于展示/编辑/复制的主要文本不会显示 reminder。
- 仍需检查 `fullText/displayFullText/memoizedTokens` 路径，避免 token 统计或折叠摘要把隐藏 reminder 纳入可见派生文本；建议改为基于 `displayText` 或显式过滤 text block。

## 文件级实施步骤

### 1. `src/renderer/src/components/chat/InputArea.tsx`

- 引入 `Target` 图标（若用于 pending banner）或复用现有图标体系。
- 新增 `pendingGoalMode` state。
- 新增派生变量：
  - `const goalModeActive = pendingGoalMode || activeGoal?.status === 'active'`
  - `const hasPendingGoalObjective = pendingGoalMode && !activeGoal?.status === 'active'`（实现时注意布尔优先级）。
- 修改 `handleGoalModeChange`：
  - 开启时不再读取 editor 内容、不再调用 `onSend`；只设置 pending。
  - 关闭 pending 时只清理 pending。
  - 有 active goal 时不通过该菜单修改 goal。
- 修改 `handleSend`：
  - pending 状态下提取并校验 objective；
  - `onSend` options 加入 `goalObjective: objective`；
  - 发送后 `resetComposer()` 并清理 pending 状态。
- 修改 `SkillsMenu` props：
  - `goalModeEnabled={goalModeActive}`；
  - `goalModeDisabled` 不再因为 `!finalSerializedText.trim() && !activeGoal` 禁用；只保留 disabled、streaming、optimizing、pending image read 等硬限制。
- 添加 pending goal banner/placeholder 文案调用。

### 2. `src/renderer/src/hooks/use-chat-actions.ts`

- 修改 `SendMessageOptions.goalObjective` 语义：从“仅创建 goal 并 return”改为“本次正常发送时同步设置 goal”。
- 删除或改造当前 `if (options?.goalObjective !== undefined && source !== 'continue') { ... return }` 分支。
- 在 session 准备完成后、构建用户消息前处理 `goalObjective`：
  - 禁止 `source === 'continue'` 使用；
  - 用 `validateGoalObjective` 校验；
  - `setGoal({ sessionId, objective, status: 'active' })`；
  - 设置成功后保留 `appliedGoalObjective` 供消息构建使用；
  - 保留首条消息自动标题生成，可使用普通 user text 或 objective，避免重复生成冲突。
- 在 user message 的 `textBlocks` 构建阶段，若 `appliedGoalObjective` 存在，插入隐藏 `<system-reminder>` text block。
- 如果本次发送同时是 queued insertion，要确保 queued reminder 和 goal reminder 顺序清晰；建议 queued reminder 先放，goal reminder 后放，再放 command/user text。

### 3. `src/renderer/src/components/chat/UserMessage.tsx`

- 确认 `displayText/copyText/editText` 均不包含 `<system-reminder>`。
- 调整 `fullText` 或 `displayFullText` 计算，避免隐藏 reminder 进入 token 展示或折叠派生内容。
- 保持图片、文件引用、skill directive、system command card 展示逻辑不变。

### 4. `src/renderer/src/locales/en/chat.json` 与 `src/renderer/src/locales/zh/chat.json`

新增必要 i18n key，例如：
- `input.goalModePending`
- `input.goalModePendingDesc`
- `input.placeholderGoalPending`
- `goal.toasts.objectiveInvalid` 如已有则复用，不重复新增。

### 5. 可选检查：`src/renderer/src/components/chat/SkillsMenu.tsx`

- 仅在需要更明确区分 pending/active 视觉状态时扩展 props。
- 优先保持现有 `goalModeEnabled` 布尔接口，不扩大组件复杂度。

## 验证与测试

执行静态验证：
- `npm run typecheck`
- `npm run lint`

手动验证场景：
1. 空输入点击“追求目标”：菜单开关变为开启/出现 pending 提示；未创建 goal。
2. 输入文本后点击“追求目标”：文本保留；未创建 goal；按发送后普通消息可见、goal active。
3. 先点击“追求目标”再输入文本发送：普通消息可见、assistant 运行、goal objective 等于输入文本。
4. 待目标状态再次点击“追求目标”：pending 取消；之后普通发送不设置 goal。
5. active goal 下点击菜单不会修改 goal；暂停/恢复仍通过 GoalSessionBar 操作。
6. pending goal + 图片附件 + 文本：图片正常发送，goal objective 来自文本。
7. pending goal + 空文本/仅图片：仅图片消息照常发送，不提交 goal，pending goal 保留等待后续文本。
8. 检查聊天气泡、复制、编辑、折叠、朗读、翻译均不显示 `<system-reminder>`。
9. 检查模型上下文中可收到 goal reminder，可通过调试日志或请求体确认。

## 假设

- “用户消息内容作为目标内容”指文本/序列化文本，不包含图片二进制本身。
- 设置 goal 失败时应中止本次发送，避免隐藏 reminder 和真实 goal 状态不一致。
- pending goal 是输入框级别的临时 UI 状态，不需要持久化到数据库。
- `/goal` slash command 仍保持现有命令式交互，不纳入本次改动。

## 风险

- `goalObjective` 语义改变可能影响其他调用方；目前搜索到主要调用来自 `InputArea.tsx`，实施前仍需再次全局搜索确认。
- system reminder 注入到 user content array 后，部分 UI 派生文本路径可能仍会纳入 token 统计，需要重点检查。
- 发送流程里提前 `setGoal` 会在模型运行前改变状态；如果后续模型请求失败，goal 仍已设置。这与“发送时设置目标”一致，但需要接受。
- 如果 queued message 同时携带 goalObjective，队列插入 reminder 顺序和 pending 状态清理需要避免重复或丢失。

## 不在范围内

- 重做目标系统、目标预算、自动继续策略。
- 修改数据库表结构或主进程 goal runtime。
- 改造 GoalSessionBar 的完整视觉设计。
- 为目标 objective 支持图片、多模态结构化内容。

## 实施记录

- `InputArea.tsx` 使用本地 pending goal 状态：菜单点击只切换 pending，不读取、不校验、不发送、不清空输入。
- 下一次包含文本的正常发送携带 `goalObjective`；仅附件发送照常发送，并保留 pending goal 等待后续文本。
- `use-chat-actions.ts` 在消息实际执行前设置 goal，并把隐藏 `<system-reminder>` 写入该用户消息的 text block。
- 用户消息展示、复制、编辑与 Markdown 导出均复用 system reminder 过滤，避免隐藏提醒泄露到 UI。
- 保留 active goal 通过菜单关闭时的既有暂停逻辑；`npm run typecheck` 与本次改动 TS 文件 targeted eslint 已通过。
