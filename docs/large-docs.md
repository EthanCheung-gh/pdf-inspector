# 大文档与多文档工作台

PDF Inspector 的大文档工作分为三部分：先让 1000 页级文档的翻页、搜索与后台分析互不阻塞；再让桌面端与 Web 端都能在多个文档标签之间切换；最后把 Web 的文档注册表做成有界、可按 id 激活的多文档模型。本文记录 H1–H4 的实现边界、标签页的快照语义、Web 单 sidecar 的激活/关闭语义与验证记录。

**结论：**

- H1–H4 已实现：双通道 sidecar、搜索分批与进度、页面列表窗口化与跳页、桌面与 Web 文档标签页。
- Web 与桌面端都显示文档标签栏。Web 的文档由服务端按 `documentId` 登记；sidecar 中始终只有 **活动文档** 一份，切换 = 按 id 激活并重新 `open`，随后恢复标签快照。
- Web 注册表上限为 8 份文档 / 总 512 MiB，超出时按最近最少激活淘汰非活动文档；关闭标签只删除该文档的临时副本，关闭最后一个标签时才清空活动文档。同一 `sourceUrl` 再次打开会去重并复用已保留的下载副本。
- 标签是会话状态，不写入 localStorage；Web 多文档不改变原有认证边界（Web 端本来就没有认证）。
- 桌面端最多两个 Python 进程（交互通道 + 懒启动的后台通道），且两个通道打开同一份活动文档；标签页只保存视图快照，不保存分析结果或第二份 PDF.js 文档。

## 双通道 sidecar

桌面端（Electron 主进程）与 Web 端（Node HTTP 后端）使用同一张路由表：`laneForMethod()` 位于 `src/main/sidecar-pool.ts`，Web 后端直接导入它，避免两侧策略漂移。

```
React 渲染层
  │ Electron IPC / HTTP /api/rpc
  ▼
SidecarPool
  ├─ interactive 通道 ── open / extract_page / extract_metadata / get_image_data / shutdown
  └─ background 通道 ─── analyze_fonts / audit_document / audit_pages
                          raw_document / raw_object / raw_page_content / diff_documents
        （lazy：第一次后台请求才创建）
```

### 请求路由表

| 方法 | 通道 | 超时（主进程/后端） | 说明 |
|---|---|---|---|
| `open` | interactive | `OPEN_PDF_TIMEOUT_MS` = 120s | 打开文档并扫描字体资源；sidecar 同时只保留一份，切换即重新 `open` 目标文件 |
| `extract_page` | interactive | `EXTRACT_PAGE_TIMEOUT_MS` = 120s | 当前页提取，正常远低于 1s |
| `extract_metadata` | interactive | 默认 30s | 轻量元数据 |
| `get_image_data` | interactive | 默认 30s | 图片对象预览 |
| `analyze_fonts` | background | `ANALYZE_FONTS_TIMEOUT_MS` = 120s | 整档字体分析 |
| `audit_document` / `audit_pages` | background | `AUDIT_TIMEOUT_MS` = 120s | 文档级审计 + 每 10 页一批 |
| `raw_document` / `raw_object` / `raw_page_content` | background | `RAW_TIMEOUT_MS` = 120s | 只读原始对象与内容流 |
| `diff_documents` | background | `DIFF_TIMEOUT_MS` = 300s（**无进展**预算） | 同时提取两份文档；每页指纹/配对完成后上报进度并重置该预算，因此总时长可以超过 300s |
| 未知方法 | interactive | 默认 30s | 保持引入双通道前的行为 |

所有预算都是**空闲（no-progress）预算**，不是总时长上限：sidecar 在处理过程中会为当前请求写独立的 stdout 行 `{"id": <request id>, "progress": {...}}`，主进程与 Web 后端的管理器收到后只重置该请求的计时器，既不 resolve 也不 reject，并保留 pending 条目。目前只有 `diff_documents` 会上报进度（`start` → 每页 `fingerprints` → 配对后 `pages` 0/N → 每页结果后 `pages` i/N → `done`），其他方法不产生进度行，行为与以前一致。超时文案统一为 `Request "<method>" timed out after <budget> without progress`。

渲染层在 IPC 之外还有一层计时器，统一比主进程预算多 5s（例如 `ANALYZE_FONTS_RENDERER_TIMEOUT_MS = 125s`）。这样主进程能先返回清晰的 `Request "…" timed out after …`，而不会先触发渲染层的 “Sidecar timeout” 重启。**Diff 是例外**：`diffPdfs` 不再经过渲染层计时器（也没有 `DIFF_RENDERER_TIMEOUT_MS`），因为固定的总时长会在合法的长时间 diff 上误判失败并重启健康的 sidecar；Diff 的超时完全由主进程/Web 后端的、可被进度续期的 300s 空闲预算决定。

### 懒启动与文档同步

- 交互通道在应用启动时创建；后台通道在**第一次**字体/审计/Raw/Diff 请求时才创建，因此只看页面的文档始终只跑一个 Python 进程。
- 后台通道首次使用时启动并打开**当前文档**一次；`backgroundOpenedPath` 记录已确认打开的路径，避免同一次启动重复 `open`。
- 文档切换时，交互通道先 `open` 新文件；如果后台通道已经运行，它在后台队列中异步同步到新路径，调用方不等待。队列每次执行都会重新读取 `documentPath`，因此连续切换最终落在最新文档上。
- 后台打开失败只记录日志，不影响交互式翻页；下一次后台请求会重试并返回自己的错误。
- `restart()` 重启两个通道：交互通道失败会向上返回；后台重启失败只记录，后续请求可自愈。`stop()` 同时停止两个通道，退出路径不会因为某条通道卡住而留下 Python 进程。
- 两个通道始终打开**同一份文档**，没有“每文档一个 sidecar”的实现；切换文档就是重新打开，不保留 N 份解析结果。

## 搜索分批与进度

搜索索引由 `usePdfSearch` 在第一次输入非空查询时构建，数据是每页 PDF.js `getTextContent()` 的字符串数组，不保存 PDF.js 页面对象。

- **分批：** `SEARCH_INDEX_BATCH_SIZE = 10`，按 `pageBatches()` 的闭区间批次读取。
- **进度：** `searchIndexProgress` 初始为 `{ done: 0, total }`，每批结束写入 `{ done: end, total }`。SearchBox 的计数槽显示 `Indexing 40/1000…`，索引完成后同一位置恢复为 `1/1` 形式的匹配计数；槽位宽度预留，避免工具栏抖动。
- **让出渲染：** 每页/每批之间都有 `await`，长文档索引期间当前页仍可滚动、翻页与渲染。
- **取消：** 查询被清空、搜索框关闭、组件卸载、文档切换时都会递增 `buildId` 并清空进度。正在运行的构建在每页与每批边界检查自己是否过期，过期立即返回，不写入结果。
- **合并请求：** 并发的 `ensureIndex()` 复用同一个 `pageTextsPromise`，不会为同一次输入启动多个索引。
- **陈旧查询：** 索引完成后会再次比较 `searchQuery`；用户继续输入时，旧查询的匹配结果被丢弃。空查询不会构建索引，并会取消正在运行的构建。
- **匹配导航：** 索引完成后计算全部匹配；有结果时跳到第一条，Enter/↓ 与 Shift+Enter/↑ 在结果间环绕，并复用带边界保护的页面导航。

搜索索引只保存文本，因此 1000 页的开销远小于保留 1000 个 PDF.js 页面对象；它属于当前文档，文档切换/关闭后释放，本阶段没有按字节的索引上限。

## 页面列表、跳页与对象上限

`StructureTree` 的页面列表面向 1000+ 页：

- **窗口化绘制：** 每个页面行使用 CSS `content-visibility: auto` 与 `contain-intrinsic-size: auto 30px`；滚动条高度保持真实，只有视口附近的行真正绘制。DOM 中仍有每页一个行节点，这是 CSS 窗口化而不是第三方虚拟列表。
- **只展开当前页：** 只有当前页的对象组会挂载；点击当前页的行可折叠/展开对象组，访问其他页时新页默认展开。1000 页时不会同时展开 1000 份对象树。
- **Go to page：** 面板顶部固定一个输入框和 `Go` 按钮，占位符显示 `1–1000`。输入必须是非负整数；空值、`3a`、负数被忽略并保留文本以便修正；超出范围会夹到 `1..pageCount`，然后走与 Prev/Next 相同的受保护导航。
- **对象上限：** 当前页 Words 最多显示 50 条，Rects/Lines/Curves/Images/Tables 每组最多 200 条；超出时显示 `Showing first N of M …`，不会静默截断。选中对象仍按类型/页/BBox 映射回完整对象，命中测试不受截断影响。

## 文档标签页（桌面与 Web）

标签栏在桌面端与 Web 端都出现：`supportsDocumentTabs()` 接受 `window.pdfInspector.openPdfPath`（桌面）或 `activatePdfDocument`（Web）中的任意一个；两者都没有时保持隐藏。两种构建的重新打开方式不同：

- 桌面标签按本地路径 `openPdfPath` 或 URL `openPdfUrl` 重新打开文档；
- Web 标签按服务端 `documentId` 调用 `activatePdfDocument`，由注册表在同一个 sidecar 中重新打开该文件，不重新上传或下载。

### 快照语义

```ts
interface DocumentTab {
  id: string;
  path: string;          // 本地路径、URL 文档临时副本，或 Web 的 /doc/:id URL
  sourceUrl: string | null;
  name: string;          // 标签显示名（URL 或 basename）
  documentId: string | null; // Web 服务端注册表 id；桌面为 null
  metadata: PdfMetadata;
  snapshot: {
    currentPage: number;
    zoom: number;
    overlayVisibility: Record<string, boolean>;
    leftTab: LeftPanelTab;
    inspectorTab: InspectorTab;
    searchQuery: string;
  };
}
```

快照只包含**视图状态**。切换时：

1. `saveActiveSnapshot()` 把当前 `pdf-store` / `workspace-store` 的状态写回旧标签；
2. 桌面端用 `openPdfPath`（本地文件）或 `openPdfUrl`（URL）无对话框地重新打开目标文档；Web 端用 `activatePdfDocument(documentId)` 让服务端激活已登记的同一份文档（不重新上传/下载）；
3. `setFile()` 换入新文档，同时重置旧文档的字体/审计/Raw 结果与选中对象；
4. `restoreViewSnapshot()` 恢复缩放、叠加层可见性、左右面板标签与查询字符串；
5. `navigate(clampSnapshotPage(...))` 恢复页码，超出新文档页数时夹到有效范围，并重新提取该页。

因此页面、缩放、叠加层和面板标签会保留；**字体分析、审计结果、Raw 展开状态不进入快照**，切回后需要重新运行。搜索查询会写回 store，但匹配结果与文本索引不跨文档保留，切换后搜索按当前文档重新建立。标签是会话状态，不写入 localStorage。桌面与 Web 只有“如何重新打开”不同：桌面按路径/URL 重新打开（URL 会重新下载），Web 按 id 激活服务端保留的副本；快照字段与恢复顺序一致。

### 打开、切换与关闭

- 打开本地文件或 URL 会新增标签；相同 `documentId`、相同 `sourceUrl` 或相同本地路径再次打开时聚焦已有标签，不重复创建。
- 标签栏位于工作区顶部，关闭按钮独立于标签文字；标签过多时横向滚动。
- 关闭非活动标签只移除该标签；Web 还会调用 `DELETE /api/documents/:id` 删除该文档的临时副本。关闭活动标签会先激活同位置的邻居（最后一个则前一个），再关闭旧标签；关闭最后一个标签回到空状态并停止文档跟踪。桌面关闭标签不会删除用户的本地文件。
- 桌面 URL 标签的临时下载文件由“当前文档”持有：切换到另一个文档会删除上一个下载副本，因此重新激活桌面 URL 标签会**重新下载**并得到新的临时路径与元数据，标签用新的路径/元数据更新，但 `sourceUrl` 保持不变。Web 的 URL 文档由注册表保留，重新激活复用同一副本（见下文）。
- Diff/Audit/Raw 工作区打开时标签栏隐藏，避免对不可见的 Inspect 文档执行切换。
- 切换期间只接受最新一次请求，慢的旧打开结果不会覆盖新选择；关闭活动标签复用同一流程。Web 激活或关闭失败时通常保留原标签并显示服务端错误；若服务端返回 404（文档已被 LRU 淘汰或已关闭），关闭操作会直接移除该陈旧标签，带 `sourceUrl` 的标签切换失败时会通过 URL 重新打开并自愈。

## Web 多文档（H4）

### 当前架构：有界注册表 + 单 sidecar

`server/web-server.ts` 的 `DocumentRegistry` 现在保存 `Map<id, OpenDocument>`，并用 `activeDocumentId` 标记 sidecar 中当前打开的那一份：

```ts
interface OpenDocument {
  id: string;               // 服务端生成，用于 /doc/:id 与激活/关闭
  filePath: string;
  name: string;
  isTemp: boolean;
  size: number;
  sourceUrl: string | null; // URL 打开时的原始地址；上传为 null
  metadata: unknown;        // sidecar open 结果，重新激活时刷新
  lastActiveAt: number;     // 单调递增的激活序号，用于 LRU
}
```

- sidecar 仍然只打开 **一份** 文档：`activeDocumentId` 指向它，其他条目只保存文件与元数据。切换 = 一次串行化的 `sidecar.open`，不是每文档 sidecar。
- 所有 `open` / `activate` / `close` 都经过同一个 mutation 队列串行执行；`/api/rpc` 只读活动文档。并发打开同一批文档时，sidecar 中最多只有一个 `open` 在飞行。
- 只有成功 `open` 后才修改 map：失败时保持原活动文档不变，并尽力重新打开它；若恢复也失败，则清空活动 id（`/api/rpc` 返回 409），但保留条目，`/doc/:id` 仍可读取。
- `/doc/:id/:name` 按 id 查表，与“是否活动”解耦：未激活的文档仍然可被浏览器用 Range 读取，因此 PDF.js 的对象 URL 不会因为切换而失效。
- 上传/下载文件按文档独立持有：每个 `OpenDocument` 的 `isTemp` 决定关闭/淘汰时是否删除；删除一个文档不会影响兄弟文档。服务关闭时 `cleanup()` 清空注册表并删除所有临时副本。

### API

| 端点 | 作用 |
|---|---|
| `GET /api/documents` | 返回 `{ activeDocumentId, documents: [{ id, name, size, sourceUrl, active }] }`；不暴露文件系统路径 |
| `POST /api/documents/:id/activate` | 激活已登记文档，返回与打开相同的 `{ canceled, path: "/doc/:id/:name", metadata, name, sourceUrl?, documentId }`；重复激活活动文档直接返回缓存元数据，不调用 sidecar |
| `DELETE /api/documents/:id` | 关闭文档并删除其临时副本，成功返回 `{ closed: true, activeDocumentId }` |
| `POST /api/open` / `POST /api/open-url` | 新增文档并激活，返回同样的打开响应；URL 打开按 `sourceUrl` 去重 |
| `POST /api/rpc` | 只作用于活动文档；没有活动文档时返回 409 `No active document` |

错误语义：未知 id 返回 404；活动文档仍有兄弟时 `DELETE` 返回 409（提示先激活另一个文档）；单个文件超过总预算返回 413；畸形 id 转义返回 400。路径方面只暴露注册表 id 与 `/doc/:id/:name` 形式，不返回磁盘路径。

### 激活语义（单 sidecar）

- `/api/open` 与 `/api/open-url` 成功时把新文档设为活动文档；旧文档仍保留登记，不会被替换或删除。
- `activate` 对非活动文档调用 `sidecar.open(filePath)`，成功后更新 `activeDocumentId`、`lastActiveAt` 与该文档的元数据；对活动文档是 no-op（不重复打开）。
- 标签切换时前端先保存旧标签快照，再通过 `activatePdfDocument` 恢复目标文档，最后 `setFile` + `restoreViewSnapshot` + 受保护的页码导航。页码超出目标文档页数时夹到有效范围。
- `/doc/:id` 与活动状态无关；切换失败时旧文档仍是活动文档，旧 id 的 URL 继续可用。

### 失败恢复

- 新上传/URL 打开失败：注册表不新增条目，重新打开上一个活动文档；上传/下载的新副本由调用方删除，不泄漏。
- 激活失败：map 不变，重新打开之前活动的文档；标签保持原状并显示错误，不会把界面切到未成功打开的目标。
- 恢复也失败：`activeDocumentId` 置空、sidecar 不持有文档，`/api/rpc` 返回 409；已有条目与 `/doc/:id` 仍保留。
- 关闭失败：
  - `404`（文档已被淘汰或关闭）：服务端已无该文档，前端静默移除陈旧标签，不再保留不可操作的状态。
  - `409`、`5xx` 或网络错误：前端保留标签并显示服务端错误，不删除本地标签状态。

### `/doc/:id` 可寻址性

浏览器标签保留的是 `/doc/:id/:name` 对象 URL；服务端按 id 查找，未激活文档也继续以 Range 读取。关闭或 LRU 淘汰后该 id 返回 404；正常关闭成功后前端移除对应标签，若关闭时发现服务端已返回 404，也会把该标签当作陈旧条目移除。文件名只是展示用的最后一段，实际路径始终来自注册表。

### 上限与 LRU

- 默认最多 8 份文档（`MAX_DOCUMENTS = 8`），登记文件总大小不超过 512 MiB（`MAX_DOCUMENT_TOTAL_BYTES = 512 * 1024 * 1024`）。
- 超过任一上限时，从 **非活动** 文档中按 `lastActiveAt` 最旧优先淘汰，并删除其临时副本；活动文档永远不会被淘汰。单个文件超过总预算时在进入 sidecar 前直接返回 413。
- 淘汰只丢弃文件与元数据，不影响其他文档；被淘汰的 `/doc/:id` 返回 404，对应标签需重新打开或上传。

### 关闭规则

- 关闭非活动标签：直接 `DELETE /api/documents/:id`，只删除该文档的临时副本，不触碰 sidecar。
- 关闭活动标签：必须先把邻居激活（或关闭最后一个文档）。服务端对“仍有兄弟的活动文档”返回 409，因此前端先切换邻居再删除旧 id；切换失败则保留旧标签与文档。
- 关闭最后一个标签：服务端只剩这一份登记文档时，删除成功、注册表清空，`/api/rpc` 之后返回 409，前端回到空状态；若刷新后服务端仍留有其他已登记文档，`DELETE` 会返回 409，标签保留。
- 桌面标签关闭不调用服务端删除，也不删除用户文件。

### URL 去重与复用

- `POST /api/open-url` 先按规范化后的 `sourceUrl` 查注册表；已存在则直接激活，不再下载，也不新增条目。
- 并发打开同一 URL 时，下载完成后会再次查找；后到的请求删除自己的新下载并激活先注册的文档。
- URL 文档的临时副本归注册表所有，重新激活不会重新下载；只有关闭、LRU 淘汰或服务关闭才删除。桌面 URL 标签仍按“当前文档持有副本”的语义重新下载，两者不要混淆。

### 浏览器 E2E 验证记录

在真实 Web 构建（`npm run build:web` + `npm run build:web-server`，Chrome，1440×900）中验证：

| 操作 | 结果 |
|---|---|
| 上传 `basic.pdf`（4 页）再上传 `large.pdf`（120 页） | 顶部出现两个标签；第二个上传后 `large.pdf` 为活动标签，工具栏显示 `1 / 120` |
| 点击 `basic.pdf` 标签 | 服务端按 id 激活；工具栏显示 `1 / 4`，两个标签都保留，该文档的 `/doc/:id` 路径不变 |
| 点击 `basic.pdf` 标签后切回 `large.pdf` | 服务端按 documentId 激活；两个标签都保留，页码分别恢复为 `1 / 4` 与 `1 / 120` |
| 关闭非活动的 `large.pdf` 标签 | 只删除 `large.pdf` 的临时副本；`basic.pdf` 继续显示且可翻页 |
| 服务端已关闭某文档后点击其陈旧标签的关闭按钮 | 404 被识别为“文档已不存在”，标签被移除，相邻标签继续可用 |
| 再次打开同一个 URL | 不新增文档、不重复下载，返回同一个 `documentId` |
| 服务状态 | 验证期间 `/api/status` 保持 `{"running":true}` |

截图（1440×900，真实 Web 构建）：

![Web 双文档标签](images/web-tabs.png)

两个标签 `basic.pdf` 与 `large.pdf` 同时保留，当前 `large.pdf` 显示 `1 / 120`；切换与关闭都按服务端 `documentId` 操作，标签快照按文档恢复。

## 清理与内存边界

| 资源 | 边界 |
|---|---|
| 交互 sidecar | 应用启动即创建，1 个进程；退出时优雅关闭后强制结束 |
| 后台 sidecar | 第一次后台请求才创建，最多再 1 个进程；本阶段不做空闲自动退出，退出/重启统一处理 |
| 打开文档 | sidecar 每个通道同时 1 份；切换即重新打开，不保留 N 份解析结果 |
| Web 文档注册表 | 最多 8 份、总 512 MiB；活动文档在 sidecar 中打开，其余只保存文件与元数据；超出时 LRU 淘汰非活动文档 |
| PDF.js | 仍只保留当前活动文档；标签不持有第二份 PDF.js 文档 |
| 标签快照 | 仅页码、缩放、叠加层、面板标签、查询字符串与元数据，不保存字体/审计/Raw/搜索索引 |
| 搜索索引 | 当前文档每页一个文本字符串数组；文档切换/关闭/搜索取消时丢弃 |
| 桌面 URL 临时文件 | 桌面临时副本由当前文档持有；替换文档或退出时删除；标签切回 URL 会重新下载 |
| Web 上传/下载临时文件 | 系统临时目录 `pdf-inspector-web/uploads`、`downloads`；每个文档独立持有，关闭该文档/LRU 淘汰/关闭服务时删除；URL 下载按 `sourceUrl` 复用 |
| Web Diff 上传 | `pdf-inspector-web/diff`；最多 16 份、总计 512 MiB、10 分钟 TTL，token 单次使用并在 finally 删除 |
| 异常退出 | 清理是尽力而为；崩溃或强杀可能残留系统临时目录文件，需要手动清理 |

## 验证

### 命令

```bash
npx tsc -b
npx tsc -p tsconfig.web.json
npx vitest run
.venv/bin/python -m pytest sidecar/__tests__ -q
npm run build:web
npm run build:web-server
```

本阶段记录（Linux，Node 22 / Python venv；Chrome 157 headless）：

- `npx tsc -b`：通过；`npx tsc -p tsconfig.web.json`：通过。
- `npx vitest run`：99 个测试文件、1367 个用例全部通过。
- `.venv/bin/python -m pytest sidecar/__tests__ -q`：489 个用例通过。
- `npm run build:web`、`npm run build:web-server`：构建成功（Vite 仅提示既有 chunk > 500 kB）。
- `git diff --check`：无空白错误。

### `huge.pdf` 夹具

`python scripts/generate-web-samples.py` 现在额外输出 `web-samples/huge.pdf`，并打印其绝对路径：

- 1000 页，固定元数据、固定文本、`invariant=1`，无时间戳/随机数，两次生成 SHA-256 一致。
- 每页只有标题、`Search marker: huge marker NNNN`、一行说明和页脚，便于验证翻页/跳页/搜索规模，而不是字体或版面复杂度。
- 既有 `basic.pdf`、`large.pdf`、`annotations.pdf`、`raw.pdf`、Diff 示例的 SHA-256 在重新生成前后保持不变。
- 文件约 735 KB；用 pdfplumber 抽查第 1/500/1000 页的文本与页码均正确。

### 浏览器实测（1440×900 截图；1280/1440/1600 宽度检查）

| 检查 | 结果 |
|---|---|
| 打开 `/samples/huge.pdf` | 工具栏显示 `1 / 1000`，左侧页面树有 1000 个页面行，Go to page 占位符 `1–1000` |
| Go to page 输入 `1000` | 工具栏变为 `1000 / 1000`，页面 1000 被标记为当前页并重新提取 |
| 页面列表 | 滚动到末尾显示 `Page 977 … Page 1000`，当前页折叠时仍保持选中 |
| `Ctrl+F` 搜索 `huge marker 0999` | SearchBox 显示 `Indexing 100/1000…`；索引结束后显示 `1/1`，并跳到第 999 页 |
| 控制台/页面错误 | 无 |
| 横向溢出（搜索框展开） | 1280/1440/1600 均 `scrollWidth == clientWidth`；≤1280 隐藏文件名但输入框、计数、上/下与关闭按钮全部可见；1440/1600 文件名继续显示 |

截图（均为 1440×900，来自真实 Web/桌面构建）：

| 截图 | 内容 |
|---|---|
| ![1000 页页面列表与 Go to page](images/large-doc-pages.png) | `/samples/huge.pdf` 跳到第 1000 页：工具栏 `1000 / 1000`，左侧页面列表末尾与 Go to page 输入框 |
| ![大文档搜索索引进度](images/large-doc-search.png) | `huge marker 0999` 搜索期间 SearchBox 显示 `Indexing 100/1000…`，输入框、计数与上/下/关闭按钮全部可见，页面仍可查看 |
| ![桌面双文档标签](images/large-doc-tabs.png) | Electron 桌面端通过 URL 打开两个文档后的真实标签栏；切回第一个文档后工具栏显示 `1 / 4` |
| ![Web 双文档标签](images/web-tabs.png) | 真实 Web 构建上传 `basic.pdf` 与 `large.pdf` 后的标签栏；当前 `large.pdf` 显示 `1 / 120` |

桌面标签截图由真实 Electron 28 + `xvfb` 驱动（通过 CDP 固定 1440×900 视口）：先打开 `http://localhost:8080/samples/basic.pdf`，再打开 `http://127.0.0.1:8080/samples/large.pdf`，随后点击第一个标签切回。两个标签都保留，切回后工具栏显示 `1 / 4`；页码、缩放与面板快照的恢复逻辑由 H3 单元测试覆盖。

搜索进度截图是在 CDP 将渲染进程 CPU 限速为 6× 时捕获的，以便让 1000 页索引的瞬态进度可见；截图中的 `Indexing 100/1000…` 是真实状态，没有合成或手工绘制。

## 已知限制与后续

- **Web 多文档是会话级、单 sidecar：** sidecar 中始终只有活动文档，切换是串行重新打开；不能同时分析多份文档，也没有每文档 sidecar。注册表最多 8 份 / 总 512 MiB，超出时按最近最少激活淘汰非活动文档，被淘汰的标签需重新打开。
- **Web 没有认证或多用户隔离：** H4 不改变 Web 端的信任边界；部署仍需用 `HOST` 或反向代理限制访问。
- **关闭 Web 活动标签需先激活邻居：** 服务端拒绝删除仍有兄弟的活动文档；激活失败会保留原标签与文档，关闭最后一个标签才清空活动文档。
- **桌面 URL 标签切换会重新下载：** 桌面下载副本由当前文档持有；重新激活 URL 标签需要重新下载，可能比本地文件慢，并产生新的临时路径。Web URL 文档由注册表保留并按 `sourceUrl` 去重。
- **分析结果不随标签保留：** 字体、审计、Raw 结果切换后重置/重新运行；搜索索引也不跨标签保留。
- **后台通道不自动空闲退出：** 一旦使用过字体/审计/Raw/Diff，第二个 Python 进程会保留到退出或重启；这是当前阶段的简化。
- **搜索索引没有字节上限：** 只保存文本，1000 页可接受；更大的文档仍依赖取消与文档切换释放。
- **页面列表是 CSS 窗口化：** 1000 页仍有 1000 个行节点，只是减少绘制；更大数量若出现卡顿，再评估真正的虚拟列表。
- **窄窗口搜索：** 搜索框展开时工具栏使用可收缩的 SearchBox；窗口宽度 ≤1280px 时隐藏文件名（不是控件），输入框、计数、上/下与关闭按钮保持可见；>1280px 时文件名继续显示。1280/1440/1600 实测均无横向溢出。
- **标签是会话状态：** 桌面与 Web 都不写入 localStorage，刷新或重启后不恢复标签或最近文件。Web 刷新会丢失标签栏，但服务端已登记的文档会保留到关闭、LRU 淘汰或服务退出。
