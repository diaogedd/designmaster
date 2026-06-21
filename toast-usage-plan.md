# toast 方法使用点整理与处理计划

## 目标
梳理项目中 `toast` 的所有使用位置，明确每个调用点的业务场景、触发条件、提示文案来源，以及后续是否需要统一抽象或收敛处理方式。

## toast 调用点清单（精确到行）

### 1) `src/renderer/src/App.tsx`
- `378`：`toast.warning('Renderer recovered in reduced-memory mode')`
  - 场景：Renderer 从 OOM / 低内存恢复后提示
- `821-823`：`toast.success(t('app.update.downloadedTitle'), { description: t('app.update.downloadedDescription', { version: d.version }) })`
  - 场景：更新下载完成
- `830`：`toast.error(t('app.update.failed'), { description: d.error })`
  - 场景：更新流程错误
- `848`：`toast.info(t('app.update.downloading'))`
  - 场景：开始下载更新
- `856`：`toast.error(t('app.update.downloadFailed'), { description: result.error })`
  - 场景：更新下载失败
- `900-902`：`toast.error(t('app.errors.unhandledTitle'), { description: e.reason?.message || String(e.reason) })`
  - 场景：全局未捕获 Promise rejection

### 2) `src/renderer/src/components/layout/TitleBar.tsx`
- `246`：`toast.success(t(autoApprove ? 'autoApproveOff' : 'autoApproveOn'))`
  - 场景：自动审批开关切换成功

## 结论
目前已定位到的 `toast` 调用点共 7 处，全部集中在 renderer 侧：
- `App.tsx`：6 处
- `TitleBar.tsx`：1 处

## 计划任务

### 1. 继续全量校验
- 逐文件确认是否还有遗漏的 `toast` 调用。
- 重点检查 `from 'sonner'`、`from "sonner"` 以及项目内可能的二次封装。

### 2. 归类到业务场景
- 更新流程
- 恢复提示
- 全局错误处理
- 设置/交互反馈

### 3. 形成后续重构清单
- 标记每个调用点是否建议保留、合并或抽象。
- 若存在重复文案，统一抽到常量或通知工具层。

### 4. 最终交付
- 输出一份可直接用于重构的 markdown 清单，包含文件、行号、场景、toast 类型和建议。
