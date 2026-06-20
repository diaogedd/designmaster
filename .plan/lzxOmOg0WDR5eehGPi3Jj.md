# 修复亮色模式 Markdown 代码块对比度

## 摘要与范围

- 目标：修复亮色模式下 Markdown 代码块文字过浅、不可读的问题。
- 截图对应入口：`src/renderer/src/components/chat/PlanReviewCard.tsx` 的计划评审内容区域。
- 已确认范围：覆盖项目内使用 Tailwind Typography `prose` 渲染 Markdown 的代码块样式，而不是只修截图里的单一卡片。
- 变更类型：样式修复；不改数据模型、计划流程、Markdown 解析逻辑或语法高亮依赖。

## 已确认需求

- 亮色模式下 fenced code block / `pre code` 必须保持足够对比度。
- 截图中的计划评审卡片必须恢复可读。
- 同类 `prose` Markdown 区域应同步受益，避免 `prose-pre:bg-muted` 搭配 Tailwind Typography 默认浅色 `pre` 文本的问题再次出现。
- 深色模式现有观感不应明显回退。

## 接受标准

- 在亮色模式下，计划评审卡片内代码块文字使用前景色或等效高对比颜色，不再接近背景色。
- 在亮色模式下，其他 `prose` Markdown 区域的代码块也不再出现浅底浅字：例如系统命令展开内容、AskUserQuestion Markdown 预览、团队消息/压缩上下文、SubAgent/Orchestration 报告。
- 行内代码仍有轻量背景和可读文字。
- 深色模式下代码块背景仍跟随 `--muted` / 现有暗色 token，文字可读。
- `npm run typecheck` 和 `npm run lint` 不因本次变更新增失败。

## 设计方向

- 根因：Tailwind Typography 的默认 `--tw-prose-pre-code` 是为默认深色 `pre` 背景准备的浅色文本；多个组件又把 `pre` 背景覆盖为 `bg-muted` 这类浅色背景，导致亮色模式代码块浅底浅字。
- 采用全局 `prose` token 覆盖，而不是逐个组件硬编码同一组 `prose-pre:text-*` class：
  - 在 `src/renderer/src/assets/main.css` 中为 `.prose` 覆盖代码相关 typography 变量。
  - 设置亮色：`--tw-prose-code`、`--tw-prose-pre-code`、`--tw-prose-pre-bg` 对齐项目主题 token。
  - 设置暗色：在 `.dark .prose` 下同步覆盖 `--tw-prose-invert-code`、`--tw-prose-invert-pre-code`、`--tw-prose-invert-pre-bg`。
- 预期 token：
  - 代码文字：`var(--foreground)`。
  - 代码块背景：`var(--muted)`。
  - 行内代码背景继续沿用现有组件 class 或 typography 默认；必要时只补最小 CSS，不重构组件。

## 文件级实施步骤

1. `src/renderer/src/assets/main.css`
   - 在主题变量定义之后、全局基础样式区域附近新增一段 Markdown prose 代码块样式覆盖。
   - 建议内容只覆盖 Tailwind Typography CSS 变量，避免改动普通 `pre` 或非 Markdown 代码展示：
     - `.prose { --tw-prose-code: var(--foreground); --tw-prose-pre-code: var(--foreground); --tw-prose-pre-bg: var(--muted); }`
     - `.dark .prose { --tw-prose-invert-code: var(--foreground); --tw-prose-invert-pre-code: var(--foreground); --tw-prose-invert-pre-bg: var(--muted); }`
   - 如果视觉验证发现 `pre code` 仍被组件 class 覆盖，再追加限定在 `.prose :where(pre code)` 的最小 override，保持 `not-prose` 排除语义。

2. `src/renderer/src/components/chat/PlanReviewCard.tsx`
   - 只在需要时补充局部 class；优先依赖全局 `.prose` token。
   - 验证 `prose-pre:bg-muted` 不再导致浅色文本。

3. 覆盖面检查，不做不必要重构
   - 通过搜索确认以下 raw `prose + Markdown` 区域受全局覆盖：
     - `src/renderer/src/components/chat/AskUserQuestionCard.tsx`
     - `src/renderer/src/components/chat/SystemCommandCard.tsx`
     - `src/renderer/src/components/chat/MessageItem.tsx`
     - `src/renderer/src/components/chat/ContextCompressionMessage.tsx`
     - `src/renderer/src/components/layout/SubAgentsPanel.tsx`
     - `src/renderer/src/components/layout/DetailPanel.tsx`
     - `src/renderer/src/components/layout/OrchestrationConsole.tsx`
   - 对已经使用 `createMarkdownComponents()` 或 `not-prose` 自定义代码块的区域不重构：`AssistantMessage.tsx`、`markdown-components.tsx`、`MarkdownViewer`、`PreviewPanel`、`ChangelogDialog` 等保持逻辑不变。

## 验证计划

- 静态检查：
  - `npm run typecheck`
  - `npm run lint`
- 视觉烟测：
  - 切到亮色模式，打开截图中的计划评审卡片，确认代码块文字可读。
  - 检查一处普通 Markdown 文档预览或 changelog，确认代码块无回退。
  - 切到深色模式，确认代码块文字和背景仍协调。
- 若当前无可复现数据，使用包含 fenced code block 的 Markdown 内容做手动预览验证。

## 假设

- 截图中的“显示有问题”指代码块文字与浅色背景对比度不足，不是代码块高度、滚动条、字体或缩进问题。
- 用户已确认修复范围为覆盖 `prose` Markdown，而不是只修截图卡片。
- 项目使用 Tailwind Typography 的 `.prose` 变量机制；全局变量覆盖会覆盖所有相关 `prose` Markdown 入口。

## 风险

- 全局 `.prose` token 会影响所有 Tailwind Typography Markdown 代码块；需要视觉检查文档预览、release notes、SubAgent 报告等区域。
- 如果 Tailwind v4 生成顺序让自定义 CSS 变量被后续 utility 覆盖，可能需要把 override 放到更靠后的 CSS 位置或补更具体的 `.prose :where(pre)` 选择器。
- 某些区域使用自定义 `not-prose` 或 `react-syntax-highlighter`，不会被这次全局 typography token 覆盖；这是刻意保留，避免扩大改动面。

## 明确不做

- 不重写 Markdown 渲染管线。
- 不替换 `react-markdown`、Tailwind Typography 或 `react-syntax-highlighter`。
- 不新增主题配置 UI。
- 不调整代码块复制按钮、语法高亮配色方案或字体体系。
