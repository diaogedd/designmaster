# Shell 执行环境变量管理改造计划

## 1. 摘要与范围
- 为 OpenCoWork 的**本地 shell 执行链路**增加统一的环境变量管理。
- 本次覆盖：
  - Bash 工具前台执行（`shell:exec`）
  - Bash 工具后台进程（`process:spawn`）
  - 本地 Terminal 新建会话（`terminal:create`）
- 不覆盖：SSH 非交互执行（`ssh:exec`）、已有运行中终端会话的热更新、安全存储、按项目隔离环境变量。
- 环境变量优先级：**OpenCoWork 配置 > 当前 `process.env` / macOS 登录 shell 同步进来的环境**。

## 2. 已确认需求
- 需要在设置页提供 shell 环境变量管理入口。
- 配置值允许按现有 settings 体系明文保存在本机 OpenCoWork 配置中。
- 本次先只处理本地 shell，不处理 SSH。
- 目标是“整个本地 shell 执行”都能拿到同一套 OpenCoWork 环境变量，而不是只改 Bash 工具某一条路径。

## 3. 验收标准
1. 用户可以在设置页录入本地 shell 环境变量配置。
2. 新配置会持久化到 OpenCoWork 本地 settings 中，并在重启后仍可读取。
3. 新开的本地 shell 会话（前台 Bash、后台进程、本地 Terminal 标签页）都能拿到这些变量。
4. 当配置变量名与系统环境变量同名时，执行结果使用 OpenCoWork 配置值。
5. 不会影响 SSH 执行路径。
6. `npm run typecheck` 与 `npm run lint` 通过。

## 4. 设计方向
### 4.1 配置模型
- 在 renderer 设置 store 中新增一个持久化字段，例如：`shellEnvironmentVariablesText: string`。
- 录入格式采用**多行文本**，每行一个变量，首版支持：
  - `KEY=VALUE`
  - `export KEY=VALUE`
  - 空行
  - `#` 注释行
- 首版不做单独的安全存储；值按现有 settings 体系明文落地。

### 4.2 UI/交互
- 在 `SystemPanel` 现有 shell 设置区域下方增加“Shell 环境变量”编辑区。
- 提供简短语法说明：
  - 一行一个变量
  - OpenCoWork 配置优先生效
  - 只影响**新建**本地 shell 会话
- 在前端做基础校验：对非空、非注释行要求满足 `KEY=VALUE` 结构；非法内容禁止保存或即时提示。

### 4.3 运行时注入策略
- 不在 `shell-handlers.ts` / `process-manager.ts` / `terminal-store.ts` 各自重复拼装 env。
- 统一在 `src/main/ipc/terminal-handlers.ts` 的 `createTerminalSession(...)` 里构建最终 `env`，因为本地 3 条执行路径最终都经过这里。
- 最终环境变量构建顺序：
  1. 以当前 `process.env` 为基础
  2. 叠加 OpenCoWork 设置中的 shell 环境变量
  3. 保留 `TERM` 默认值（`xterm-256color`），但若用户显式配置 `TERM`，则用户配置优先
- 为兼顾常见 PATH/引用场景，首版在 main 侧增加**有限变量展开**：
  - POSIX：支持 `$VAR` / `${VAR}`
  - Windows：支持 `%VAR%`
  - 展开基于“基础环境 + 已解析的 OpenCoWork 变量”进行
- 解析失败或非法行不应导致主进程崩溃；运行时需要做兜底忽略与日志保护。

## 5. 文件级实施步骤
### 5.1 `src/renderer/src/stores/settings-store.ts`
- 新增 `shellEnvironmentVariablesText` 字段到 `SettingsStore` / `SettingsStoreData`。
- 设置默认值为空字符串。
- 在 `migrate(...)` 中为旧版本补默认值。
- 在 `partialize(...)` 中加入该字段，确保通过 `opencowork-settings` 持久化。
- 版本号从当前值上调 1（例如 `22 -> 23`），便于迁移语义明确。

### 5.2 `src/renderer/src/components/settings/SettingsPage.tsx`
- 在 `SystemPanel()` 的 shell 配置区域中新增环境变量编辑区（建议 `Textarea`）。
- 增加语法说明、优先级说明、以及“仅影响新建本地 shell 会话”的提示。
- 将输入绑定到 `settings.shellEnvironmentVariablesText`。
- 在“恢复默认设置”逻辑中清空该字段。
- 如采用即时校验，添加本地校验函数并在 UI 中展示错误状态/提示。

### 5.3 `src/renderer/src/locales/en/settings.json`
- 新增英文文案键：标题、描述、占位符、格式说明、优先级说明、仅影响新会话提示、校验错误提示等。

### 5.4 `src/renderer/src/locales/zh/settings.json`
- 新增对应中文文案键，与英文保持结构一致。

### 5.5 `src/main/ipc/settings-handlers.ts`
- 在现有 `readSettings()` 基础上补一个主进程侧 helper（可放在本文件内导出），用于安全读取并解出 `opencowork-settings` 的 `state` 对象，避免每个 main 模块都手写 persisted-state 解包逻辑。
- 暴露一个面向 shell 的读取入口，例如读取 `shellEnvironmentVariablesText` 的 helper。

### 5.6 `src/main/ipc/terminal-handlers.ts`
- 新增本地 shell 环境变量解析/展开 helper：
  - 解析多行文本为键值对
  - 过滤空行与注释
  - 识别并忽略非法行（同时保留日志保护）
  - 做有限变量展开（PATH 等场景）
- 在 `createTerminalSession(...)` 中读取持久化设置，构建最终 env。
- 把当前 `spawn(...)` 中的 `env` 从固定 `{ ...process.env, TERM: 'xterm-256color' }` 改为“基础 env + OpenCoWork env 覆盖 + TERM 默认兜底/用户优先”。
- 保证这一处修改同时覆盖：
  - `shell:exec`
  - `process:spawn`
  - `terminal:create`

### 5.7 影响确认（预期无需代码改动，但要验证）
- `src/main/ipc/shell-handlers.ts`：继续通过 `createTerminalSession(...)` 受益。
- `src/main/ipc/process-manager.ts`：继续通过 `createTerminalSession(...)` 受益。
- `src/renderer/src/lib/tools/bash-tool.ts`：无需感知新字段，现有 IPC 路径保持不变。
- `src/renderer/src/stores/terminal-store.ts`：无需改执行逻辑，只验证新建标签页是否拿到 env。

## 6. 验证与测试
### 6.1 静态验证
- 运行：`npm run typecheck`
- 运行：`npm run lint`

### 6.2 手工验证
1. 在设置页写入：
   - `FOO=bar`
   - `HELLO=world`
2. 用 Bash 工具执行：`echo $FOO $HELLO`，确认输出为设置值。
3. 设置一个与系统同名的变量（例如代理类变量或自定义测试变量），确认 OpenCoWork 配置值覆盖系统值。
4. 设置 PATH 类值（如 `PATH=/tmp/test-bin:$PATH`），确认经过展开后新 shell 会话能读取到预期 PATH。
5. 新建本地 Terminal 标签页，执行 `echo $FOO`，确认能读取。
6. 触发一个后台命令，确认其运行环境也包含注入变量。
7. 修改设置后，不重启应用，**新建** shell 会话应使用新值；已有会话保留旧值。
8. SSH 执行路径不受影响。

## 7. 假设
- 现阶段接受环境变量以明文形式保存在本机 OpenCoWork settings 中。
- 本次环境变量是**全局应用级**配置，不做项目级/会话级覆盖。
- 环境变量修改只对**后续新建**本地 shell 会话生效，不对正在运行的会话热更新。

## 8. 风险
- 变量展开语义在不同平台/不同 shell 之间可能存在差异；首版需要将支持范围限制为“有限展开”，避免模拟完整 shell 语法。
- 若用户输入大量非法行，前端校验与主进程兜底需要保持一致，避免“能保存但不生效”的混乱体验。
- `PATH`、`TERM` 一类变量若处理顺序不当，可能影响终端可用性；需要专项验证覆盖顺序。

## 9. 非本次范围
- SSH `ssh:exec` 注入同一套环境变量
- 敏感值安全存储（keychain / secret service 等）
- 按项目、按工作目录、按 session 的差异化环境变量
- 读取 `.env` 文件、导入/导出环境变量配置
- 已运行终端会话的实时刷新/重载
