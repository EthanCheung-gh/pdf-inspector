# 会话恢复与最近文件

会话恢复把“上次退出时打开了什么”和“最近打开过什么”保存在本机，并在下次启动/刷新时尽力恢复标签与视图。实现刻意只持久化**定位信息 + 视图快照**：PDF 字节、页面对象、字体/审计/Raw/Diff 结果、搜索索引和当前选中对象都不写盘；桌面端本地路径只写入本机 `localStorage`，Web 端不会把上传文件的本地路径或内容写到服务端。

**结论：**

- 桌面重启后默认恢复上次的标签，以及每个标签的页码、缩放、叠加层、左右面板标签与查询字符串。
- Web 刷新后按服务端 `documentId` 恢复仍登记的文档；服务端重启后 URL 文档可按 `sourceUrl` 重新下载，上传文档无法恢复，跳过并提示重新上传。
- 最近文件列表与“上次会话”默认自动恢复相互独立：关闭自动恢复只影响启动时是否打开，不影响最近文件与手动恢复。
- 恢复是尽力而为：单个文件丢失/无权限/URL 失效/`documentId` 404 只跳过该项，不阻塞其他标签；失败提示只给出数量，不包含路径。
- 最近文件最多 20 条、会话最多 20 个标签；损坏或写入失败的存储回退到内存，不影响应用启动。

## 存储键与数据

| 键 | 内容 |
|---|---|
| `pdf-inspector:session:v1` | `{ tabs, activeIndex, savedAt, restoreLastSession }`；`tabs` 按标签栏顺序保存，每项是定位信息 + 视图快照 |
| `pdf-inspector:recent:v1` | `RecentDocument[]`；按最近打开时间倒序，最多 20 条 |

每个会话标签（`SessionTabRecord`）保存：

- `kind`：`local` / `url` / `web` / `upload`；
- `path`：本地路径，或 URL 文档的源 URL（**不是**临时下载副本）；`web` / `upload` 只保存服务端显示路径，不用于打开；
- `sourceUrl`、`documentId`：重新打开所需的最强定位信息；
- `name`：标签显示名（不翻译）；
- `snapshot`：`currentPage` / `zoom` / `overlayVisibility` / `leftTab` / `inspectorTab` / `searchQuery`；
- `lastActiveAt`：仅用于排序，不写入报告。

最近文件（`RecentDocument`）保存 `id`（定位信息的散列，不是路径本身）、`kind`、`name`、`path` / `sourceUrl` / `documentId` 与 `openedAt`。`id` 由“类型 + 定位信息散列”生成，因此最近列表本身不会把本地路径当作标识符暴露给其他界面。

### 不持久化的内容

- PDF 字节、PDF.js 页面对象、字体文件或页面内容；
- 字体分析、审计、Raw、Diff、安全扫描、无障碍结构、注释索引等分析结果；
- 搜索文本索引、搜索结果、高亮与当前选中对象；
- 对话框输入、导出选项、Diff/Audit/Raw 工作区的展开状态；
- Web 上传文件的本地路径与内容（Web 端只保留显示名与可选的 `documentId`）。

## 上限、去重与容错

| 规则 | 实现 |
|---|---|
| 会话标签上限 | `MAX_SESSION_TABS = 20`，超出部分不保存/不恢复 |
| 最近文件上限 | `MAX_RECENT_DOCUMENTS = 20`，超出淘汰最旧项 |
| 字符串上限 | 名称/路径/URL 最多 2048 字符，超长截断 |
| 去重键 | 本地文件按路径；URL 文档按 `sourceUrl`；Web 文档优先 `sourceUrl`（同 URL 重开会拿到新 `documentId`），否则按 `documentId`；上传按 `documentId` |
| 排序 | 最近列表按 `openedAt` 降序；同一毫秒打开时新项仍在前 |
| 损坏数据 | 读取时逐字段 sanitize；非法枚举/时间戳/快照回退默认值，缺定位信息的记录直接丢弃，损坏的 JSON 不会阻止启动 |
| 存储失败 | 隐私模式、quota、`localStorage` 抛错时整页降级为内存存储，读写不抛到 UI |
| 空会话 | 关闭最后一个标签会写入空会话，下次启动不恢复已关闭的文档；最近列表仍保留 |

## 恢复规则

恢复按标签顺序**串行**打开，最多 20 个；每次成功后 `setFile` → `addTab` → 恢复视图快照 → 受保护地 `navigate`，最后按保存的 `activeIndex` 重新激活上次的活动标签。

| 平台/类型 | 恢复方式 | 失败处理 |
|---|---|---|
| 桌面本地文件 | `openPdfPath(path)` | 文件被移动/删除/无权限时跳过该项 |
| 桌面 URL 文档 | `openPdfUrl(sourceUrl)` 重新下载 | URL 失效时跳过 |
| Web URL 文档 | 优先 `activatePdfDocument(documentId)`；`PdfDocumentNotFoundError` 时按 `sourceUrl` 重新打开 | 重新下载失败则跳过 |
| Web 上传文档 | 只调用 `activatePdfDocument(documentId)` | 404/失效时跳过，**不会**伪造内容或重新上传 |
| 已打开文档 | 恢复只在没有打开文档时执行 | 用户先打开文档（命令行/拖拽/点击）时不抢占 |
| 可恢复项为空 | 不显示恢复；空状态展示最近文件 | 同时清空无效会话，避免每次启动重试 |

其他行为：

- 启动恢复每次页面加载最多执行一次（React StrictMode 的重复 effect 也只执行一次）。
- 恢复过程中用户打开其他文档时，恢复立即停止并保留用户打开的文档。
- 恢复完成后重新保存会话，使失效项自然淘汰，不会反复失败。
- 单个标签的页面提取失败不会中止其余标签；活动标签重新激活失败只记录一项失败。

## 恢复开关与手动恢复

- `restoreLastSession` 默认 `true`，控制**启动时是否自动恢复**；在最近文档对话框底部的 `Restore last session` 开关可随时修改并立即持久化。
- 关闭开关后，启动不自动打开标签，但最近文件列表和上次会话数据仍然保留。
- 空状态的 `Restore last session` 按钮与命令面板的 `File: Restore last session` 是**显式请求**：即使自动恢复开关关闭也会强制恢复（`force: true`）。手动恢复仍遵守其他前提：当前没有打开文档、存在非空会话、构建支持标签切换。
- 手动恢复会先重置“每次页面加载只恢复一次”的保护标记，因此启动尝试过（即使拒绝执行）也不影响之后的显式请求；恢复开关本身不会被手动恢复修改。

## 界面入口

### 空状态（未打开文档）

画布中的空状态提供：

- `Open PDF…`、`Open URL…`；
- `Recent documents…`：打开最近文档对话框；
- `Restore last session`：有可恢复会话时可用，恢复中显示忙碌状态；
- 最近最多 5 条文档的快捷按钮（名称 + 路径/URL，超长省略并保留完整 `title`）；
- 一行隐私说明：最近文件和上次会话只保存在本机；Web 上传不保存内容或本地路径。

有文档打开时该空状态不渲染。

### 最近文档对话框

- 分组：`Local files` / `URL documents` / `Web documents`（上传归入 Web 组）。
- 每行：名称、路径或 URL、类型、上次打开时间、`Open`、`Remove`。
- `Open`：本地走 `openPdfPath`，URL 走 `openPdfUrl`，Web/上传走 `activatePdfDocument`；Web 遇到 404 且仍有 `sourceUrl` 时自动按 URL 重新打开。打开成功后关闭对话框。
- 失败时保留列表并只在对应行显示错误；上传文档失效时明确提示该上传来自上次会话、已不可用，需要重新上传，而不是泛化的“无法打开”。
- 底部：`Restore last session` 开关、`Clear recent`（需要二次确认）、`Close`；空列表显示空状态说明。
- 最近项只代表“打开过”，打开时使用默认视图（第 1 页、100% 缩放），不携带旧标签的页码/缩放。

### 命令面板

`Ctrl/Cmd+K` 的 `File` 分组提供：

- `File: Recent documents…`：打开最近文档对话框；
- `File: Restore last session`：仅在未打开文档且存在会话标签时可用，强制恢复上次会话；
- `File: Clear recent documents`：清空最近列表，无最近项时禁用。

### 状态栏

- 恢复期间显示 `Restoring n/m documents…`。
- 完成后若有失败项，显示可关闭的警告 `N document(s) could not be restored`（只给数量，不含路径）。
- 整体失败（例如恢复计划损坏）显示可关闭的错误提示，不阻塞继续使用。

## 隐私边界

- 桌面端本地路径只写入本机 `localStorage`；Web 端不把上传文件的本地路径或内容写到服务端，也不写入任何服务端最近文件表。
- Web 上传的最近记录只包含显示名与可选的 `documentId`，不包含 PDF 内容；服务端重启后该记录无法恢复，需要用户重新上传。
- 恢复失败提示不包含路径/URL；对话框中的名称、路径与 URL 属于用户数据，保持原样、不翻译。
- 会话与最近文件不参与导出报告、Diff、Audit、CLI 或 GitHub Action。

## 非目标

- 不做跨设备同步、账号、服务端最近文件或团队共享。
- 不持久化 PDF 内容、分析结果或搜索索引。
- 不恢复 Web 上传文件的内容/路径，也不自动重新上传。
- 不实现崩溃恢复对话框，也不保留“被拒绝恢复的标签”历史。
- 不新增数据库；只用 `localStorage`，所有失败都降级为内存状态。

## 验证

```bash
npx vitest run src/renderer/store/__tests__/session-store.test.ts \
  src/renderer/store/__tests__/session-restore-store.test.ts \
  src/renderer/hooks/__tests__/useSessionRestore.test.ts \
  src/renderer/services/__tests__/session-restore.test.ts \
  src/renderer/services/__tests__/session-restore-force.test.ts \
  src/renderer/components/Workspace \
  src/renderer/components/StatusBar \
  src/renderer/App.test.ts
npx vitest run
npx tsc -b
npx tsc -p tsconfig.web.json --noEmit
```
