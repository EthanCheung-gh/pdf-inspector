# PDF Inspector

面向开发者的 PDF 结构检查工具——在 PDF.js 渲染结果之上叠加 pdfplumber 的坐标级对象数据，直观检查字符、单词、线条、曲线、矩形、表格和图片，并以只读方式检查注释、链接、表单字段、原始对象树与内容流。提供 Electron 桌面应用与浏览器（Node HTTP 后端）两种运行方式。

[![CI](https://github.com/EthanCheung-gh/pdf-inspector/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/EthanCheung-gh/pdf-inspector/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-v0.2.0-blue.svg)](https://github.com/EthanCheung-gh/pdf-inspector)
[GitHub](https://github.com/EthanCheung-gh/pdf-inspector) · [GitCode](https://gitcode.com/EthanCheung/pdf-inspector)

|  |  |
| :---: | :---: |
| ![工作区总览：Objects / Outline / Fonts / Layers 标签与可调整面板](docs/images/overview.png) | ![对象检查](docs/images/inspector.png) |
| ![Islands 主题：工具栏、左右面板、画布与状态栏作为圆角浮动卡片，中间留出间隙](docs/images/theme-islands.png) | **Dark / Islands 主题**<br>工具栏右侧的 `Theme` 按钮在默认 `Dark` 与 VS Code 风格 `Islands` 之间切换；Islands 把主要面板变成带 1px 边框、圆角与柔和阴影的浮动卡片，Diff / Audit / Raw 工作区同样适用。 |
| ![字体分析：嵌入状态徽标与 Standard 14 汇总](docs/images/fonts.png) | ![URL 打开](docs/images/url-dialog.png) |
| ![图层面板](docs/images/layers.png) | **Layers**<br>七类对象开关、计数、All/None、Solo 与透明度。 |
| ![按元素类型导出](docs/images/export-dialog.png) | **按元素类型导出**<br>选择当前页/整档、JSON/CSV 与要包含的元素类型；未勾选的类型不会写入文件。 |
| ![表格单元格网格与选中单元格](docs/images/table-cells.png) | **表格单元格**<br>选中表格后显示单元格网格、合并/缺失标记与选中单元格的 BBox；悬停或点击单元格时画布同步高亮。 |
| ![页面几何：五个页面框与标尺](docs/images/page-geometry.png) | **页面几何**<br>`Page` 标签页列出 MediaBox / CropBox / TrimBox / BleedBox / ArtBox，可切换 pt/mm 并显示标尺。 |
| ![Diff 工作区：并排旧/新页面、变更摘要与列表、右侧选中变更详情](docs/images/diff-workspace.png) | **PDF Diff**<br>并排查看旧/新页面；左侧按页汇总变更，选中条目后右侧显示旧/新文本、BBox 与字段差异，顶部可重新选择旧/新文件或导出 JSON。 |
| ![叠加模式：同一页上叠加旧/新对象框](docs/images/diff-overlay.png) | **叠加模式**<br>在同一页叠加旧/新对象框（移除红、新增绿、移动橙、修改蓝），适合定位同一区域的改动。 |
| ![Visual 模式：像素热力图叠加在页面上，顶部显示 changed / total 像素统计](docs/images/diff-visual.png) | **Visual 像素对比**<br>在 Diff 工作区切到 `Visual`，以新页为底叠加旧页（`Blend`）或逐像素热力图（`Heatmap`），并在页面栏显示 `changed / total px`；`Boxes` 只显示对象框。 |
| ![忽略区域：在并排页面上拖动矩形后显示虚线框、区域列表与重新运行按钮](docs/images/diff-regions.png) | **忽略区域**<br>打开 `Ignore region` 后在任一页拖动矩形，左侧列出页码/侧/bbox，虚线框同步绘制；`Apply & re-run` 重新比较并过滤相交的变更。 |
| ![页面重排：页面列表显示 Old 2 → New 1、Old 3 → New 2 等对齐结果与新页 5 为 added](docs/images/diff-reordered.png) | **页面对齐与重排**<br>页面按内容指纹配对，列表与页面栏显示 `Old 2 → New 1` 等旧/新页码；插入/删除页保持单侧，`--fail-on reordered` 可把这些配对作为 CI 门禁。 |
| ![文档体检工作区：严重级别汇总、筛选器、发现列表与右侧选中发现详情](docs/images/audit-workspace.png) | **文档体检**<br>跨字体、页面、图片、元数据、结构与安全的整档审计；按严重级别汇总，可按严重级别/类别筛选，选中条目查看证据与修复建议，并可跳转到对应页面。 |
| ![PDF 审计 HTML 报告：文档信息、严重级别汇总与逐条发现](docs/images/audit-report.png) | **审计报告（HTML）**<br>CLI `audit --format html` 生成单文件报告：文档信息、严重级别汇总与逐条发现（证据、建议）；内联 CSS、无脚本、无外部资源。 |
| ![注释、链接与表单：Annots 列表、画布框选与 Inspector 只读表单详情](docs/images/annotations.png) | **注释、链接与表单**<br>`Annots` 标签页列出当前页的链接、表单字段、标记与注释；画布同步绘制只读框，选中后在 Inspector 查看字段值、选项与链接目标。 |
| ![Raw 对象树：Catalog → Pages → Page → Resources 逐层展开，右侧显示图片 XObject 的流元数据](docs/images/raw-object-tree.png) | **原始对象树**<br>工具栏 `Raw` 打开只读工作区；左侧从 trailer 根开始按引用懒加载，展开 `Pages`、页面与 `Resources` 后选中对象，右侧显示字典、数组与流元数据。 |
| ![内容流：第 1 页解码后的操作符与操作数，包含 BT、Tf、Tj、Do](docs/images/raw-content-stream.png) | **内容流**<br>`Content stream` 标签页按页解码内容流，逐条列出 offset、操作符与操作数；`BT` / `Tf` / `Tj` / `Do` 等操作符只读取、不执行。 |
| ![1000 页页面列表与 Go to page：工具栏显示 1000 / 1000，左侧列表末尾为 Page 1000](docs/images/large-doc-pages.png) | **大文档页面列表与跳页**<br>打开 1000 页示例，左侧页面树使用 CSS 窗口化；Go to page 把输入夹到 `1..pageCount`，只展开当前页对象。 |
| ![大文档搜索：SearchBox 显示 Indexing 100/1000…，页面与页面列表仍可用](docs/images/large-doc-search.png) | **分批搜索索引**<br>搜索按 10 页一批建立文本索引，SearchBox 显示 `Indexing done/total…`；关闭搜索或切换文档会取消构建。 |
| ![桌面文档标签栏：两个通过 URL 打开的文档标签，切换到 basic.pdf 后工具栏显示 1 / 4](docs/images/large-doc-tabs.png) | **桌面文档标签**<br>桌面端可同时保留多个文档标签，切换时恢复页码、缩放、叠加层与面板标签；Web 端通过服务端 `documentId` 激活标签。 |
| ![Web 文档标签栏：basic.pdf 与 large.pdf 两个标签，当前 large.pdf 显示 1 / 120](docs/images/web-tabs.png) | **Web 文档标签**<br>Web 与桌面端都显示文档标签栏；切换按 `documentId` 激活并恢复视图快照，未激活文档的 `/doc/:id` 仍可读取，关闭标签只删除该文档的临时副本。 |

*截图来自 Web 构建与真实 Electron 桌面构建；页面列表/搜索、主题与 Diff/Audit/Raw 为 1440×900，桌面标签为 Electron + xvfb 实测（CDP 1440×900 视口）。详见 [docs/large-docs.md](docs/large-docs.md)。*

## 功能特性

### 渲染与检查

- PDF.js 多页渲染，支持翻页、缩放与适合页面宽度。
- char / word / line / curve / rect / table / image 七类对象的边界框叠加层，可在 Layers 标签页统一控制可见类型与透明度。
- 悬停或点击选中对象，Inspector 的 `Inspect` 标签页展示页码、坐标、字体、字号、颜色及原始 JSON；图片对象提供内嵌预览。
- 文本选择层支持直接选中页面文字。

### 导航与结构

- 左侧面板包含五个标签页：`Objects`（按页展示全部对象）、`Outline`（PDF 书签）、`Fonts`（字体统计）、`Layers`（叠加层控制）与 `Annots`（当前页注释、链接与表单字段）。
- `Objects` 标签页的对象树按页展示全部对象，页面节点可折叠/展开。
- `Outline` 标签页读取 PDF 书签（outline），点击条目直接跳转到对应页面。
- 当前页码显示与上一页/下一页导航，并实时显示缩放比例。

### 工作区与布局

- 左右面板可通过分隔条拖拽调整宽度，并可折叠；工具栏的 Left / Right 按钮与面板内的折叠按钮保持同步。
- 面板收起后，画布边缘会出现 `Objects` / `Inspector` 恢复条，点击即可重新打开；专注模式下左上角显示 `Show panels` 恢复按钮。
- `F` 或工具栏 Focus 进入专注模式，隐藏左右面板、只保留画布；再次按 `F` 或点击 Focus 退出。
- Inspector 面板分为 `Inspect / Filter / Results / Page` 四个标签页：查看对象属性、组合筛选条件、管理筛选或框选结果、查看页面几何。
- 面板宽度、折叠状态、Focus 模式、当前标签页与叠加层透明度会保存在 localStorage，下次启动自动恢复。

### 主题与外观

- 工具栏右侧的 `Theme: Dark` / `Theme: Islands` 按钮切换界面主题，按钮文字始终显示当前主题，并通过 `aria-pressed` 暴露 Islands 的激活状态。
- `Dark` 是默认主题，保持原有的紧凑、无缝面板外观；`Islands` 使用近黑色渐变画布，把工具栏、文档标签栏、左右面板、画布、Inspector、Diff / Audit / Raw 工作区与状态栏都变成带 1px 边框、圆角与柔和阴影的浮动卡片，面板之间保留间隙。
- Islands 只改变外观：面板宽度、分隔条拖拽、Focus 模式与 1280 / 1440 / 1600 下的布局尺寸保持不变，不会产生横向溢出。
- 主题持久化在 localStorage 的 `pdf-inspector:theme:v1`，启动时在第一帧渲染前写入 `document.documentElement.dataset.theme`；存储不可用（隐私模式、jsdom 等）时回退到 `Dark`，不影响使用。
- 结构色集中在 `src/renderer/theme.css` 的 CSS 变量中；PDF 页面白底、PDF 对象类型色、注释类型色与页面框颜色不随主题变化。

### 搜索与导出

- `Ctrl/Cmd+F` 跨页全文搜索，逐条导航并高亮匹配位置。
- 导出当前页或整份文档，格式为 JSON 或 CSV；导出时可勾选要包含的元素类型（char / word / line / curve / rect / table / image）。桌面端使用原生保存对话框，Web 端触发浏览器下载。
- CSV 按对象类型分段，便于在表格工具中继续分析。
- JSON 导出新增可选字段：`metadata.fontInfo`（字体嵌入详情）、每页的 `page.boxes` / `page.rotation`、表格的 `table.cellBoxes` / `table.cellSpans`，以及图片的 `content_hash`（可读取时的 SHA-256）；CSV 各段的列定义保持不变。

### 大文档与多文档

- **双通道 sidecar**：交互通道负责 `open` / `extract_page` / `extract_metadata` / `get_image_data`，后台通道负责 `analyze_fonts` / `audit_*` / `raw_*` / `diff_documents`；路由表由 `laneForMethod()` 统一，桌面端与 Web 端共用。翻页不会被正在运行的字体、审计、Raw 或 Diff 请求挡住。
- **后台通道懒启动**：只有第一次请求字体/审计/Raw/Diff 时才创建第二个 Python 进程；两个通道打开同一份文档，切换文档时后台通道异步重新打开，失败只影响后台功能。因此正常查看始终只有一个进程，最多两个。
- **搜索分批与进度**：搜索按 10 页一批建立当前文档的文本索引，SearchBox 显示 `Indexing 40/1000…`；清空查询、关闭搜索、切换文档或离开 Inspect 会取消构建，过期构建不会写回结果。索引只保存文本，不保留 PDF.js 页面对象。
- **页面列表窗口化与跳页**：1000 页的 `Objects` 列表使用 CSS `content-visibility` 窗口化，只绘制视口附近的行；只有当前页展开对象组。顶部 Go to page 输入 `1..pageCount`，越界会夹取，非法输入被忽略，并复用与 Prev/Next 相同的受保护导航。
- **对象上限**：当前页 Words 最多显示 50 条，其他对象组最多 200 条，超出显示 `Showing first N of M …`；选中对象仍映射回完整对象。
- **桌面文档标签**：打开多个本地文件或 URL 文档后，工作区顶部出现标签栏；相同路径/URL 再次打开会聚焦已有标签。切换标签会保存旧标签的页码、缩放、叠加层、左右面板标签与查询字符串，重新打开目标文档后恢复；字体、审计、Raw 结果不进入快照，切回后重新运行。关闭活动标签激活邻居，关闭最后一个回到空状态。
- **桌面 URL 标签**：桌面端 URL 文档下载到临时副本，临时文件归“当前文档”所有；切换到其他文档会删除上一个副本，因此重新激活桌面 URL 标签会重新下载，但保留同一个 `sourceUrl` 和标签身份。Web 端的 URL 副本由注册表保留，见下条。
- **Web 文档标签**：Web 与桌面端都显示文档标签栏。Web 文档由服务端按 `documentId` 登记，只有活动文档在 sidecar 中打开（交互/后台两个通道打开同一份）；切换标签调用激活接口，在同一 sidecar 中重新打开目标文件，并恢复该标签的页码、缩放、叠加层、面板标签与查询字符串。注册表最多 8 份文档 / 总 512 MiB，超出时淘汰最久未激活的非活动文档。关闭标签只删除该文档的临时副本，关闭最后一个标签才清空活动文档；同一 `sourceUrl` 再次打开会去重并复用已保留的下载副本。标签是会话状态，不写入 localStorage，也不改变 Web 端原有的认证边界（Web 端本来就没有认证）。
- **清理与限制**：桌面与 Web 标签都只保存视图快照，不保留 N 份 PDF.js 文档或分析缓存；Web 端不做每文档 sidecar，切换是串行的 sidecar 重新打开；后台通道在本阶段不做空闲自动退出；异常退出后临时文件清理是尽力而为。完整路由表、快照语义、Web 多文档 API 与验证记录见 [docs/large-docs.md](docs/large-docs.md)。

### 过滤与叠加层

- 七类对象的开关已从工具栏移入 `Layers` 标签页：每类一行显示当前页对象计数，并提供 All / None 批量开关、Solo 单独查看与 Opacity 透明度滑杆；工具栏的 `Layers n/7` 按钮可直接打开该标签页。
- 筛选仍在 Inspector → `Filter` 标签页：按字体、字号、颜色与类型组合筛选对象。
- 拖拽框选区域，支持“相交（intersect）”与“包含（contain）”两种匹配方式。
- 筛选或框选结果显示在 Inspector → `Results` 标签页，并在画布上高亮；可直接导出该子集。

### 字体分析

- 统计整份文档的字体使用情况：页数、字符数、字号范围、颜色。
- 每个字体显示嵌入状态徽标：`Embedded` / `Standard 14` / `Not embedded` / `Unknown`，并区分子集字体（`Subset`）与字体子类型（如 `Type1`）。
- 展开字体条目可查看细节：嵌入状态、Subtype、是否子集、Encoding、ToUnicode 与字体文件类型。
- 顶部汇总分别统计未嵌入字体与标准 14 字体（例如 `8 fonts · 0 not embedded · 8 standard 14`），不会把 Standard 14 当作缺失字体。
- 按每 10 页一批顺序分析，并实时显示进度。
- 分批处理让页面提取有机会穿插执行，分析长文档时界面保持可用。
- 点击字体条目跳转到首个使用页，并通过筛选高亮该字体的对象。

### 表格单元格

- 选中表格对象后，Inspector → `Inspect` 的 Table 区显示与 `cells` 对齐的单元格网格；合并覆盖的槽位显示 `▨`，缺少几何数据的槽位显示 `∅`。
- 悬停单元格可预览，点击可选中并查看行、列、Span、文本、BBox 与尺寸；画布叠加层同步绘制该表格的单元格网格，并高亮悬停或选中的单元格。
- 表格文本仍按 `cells` 矩阵导出，CSV 表格段的列（`page, table_index, row, col, text`）保持不变。

### 页面几何

- Inspector 新增 `Page` 标签页：显示当前页尺寸与 `/Rotate` 旋转角，并可在 pt 与 mm 之间切换。
- 列出 MediaBox、CropBox、TrimBox、BleedBox、ArtBox 的原始坐标；每个框可独立显示或隐藏，画布以不同颜色和虚线样式叠加。
- 画布可显示页面顶部与左侧标尺，单位跟随 pt/mm；状态栏显示页面尺寸、旋转角以及光标相对 MediaBox 原点的坐标（与 Inspector 的对象坐标一致）。

### 注释、链接与表单

- **当前页注释列表**：左侧 `Annots` 标签页列出当前页由 PDF.js 解析出的注释（Link、Widget、Text、Highlight 等），顶部显示 `N annotations · L links · F form fields` 汇总；可按 Kind 与 Subtype 过滤，`Show boxes` 控制画布框的显示。
- **画布框与选中**：注释按类型着色——链接蓝、表单紫、标记黄、注释橙、图章青、其他灰；悬停加亮，选中使用金色描边。点击注释框会选中该注释并切换到 Inspector，点击对象则清除注释选中，两者不会同时高亮。
- **Inspector 详情**：`Inspect` 显示 subtype / kind / 页码 / Rect、标题与内容、修改时间、颜色与不透明度；链接额外显示目标与 `Open link` / `Go to page N`，表单字段显示字段名、类型、值、默认值、Flags 与选项。
- **内部与外部链接**：外部链接只在用户显式点击 `Open link` 时打开，且仅允许 `http(s)`；PDF.js 的原始 `unsafeUrl` 只用于显示，不安全目标会禁用按钮并提示“仅支持 http(s)”。渲染层、桌面主进程与 Web 适配器都会再次校验 URL，打开失败不会影响文档状态。内部目标解析为页码后，使用与 Prev/Next 相同的翻页导航。
- **表单只读**：字段值、默认值、Flags 与选项全部以文本呈现，没有输入框、没有重置/提交按钮，也没有写回 PDF 的路径；签名字段只作为字段显示并标注未验证。
- **隐藏与弹出注释**：Popup 注释不单独列出（改为显示父注释的内容）；隐藏注释在列表中带 `Hidden` 标记，但默认不绘制画布框。
- **范围**：只处理当前页，翻页时重新加载并清除上一页的选中；这是纯读取功能，不修改 PDF。数据来源、链接策略与非目标详见 [docs/annotations.md](docs/annotations.md)。

### 原始 PDF 对象树与内容流

- **Raw 工作区**：工具栏 `Raw` 打开独立的只读工作区，与 Diff、Audit 互斥；Inspect 保持挂载但被隐藏，页码、缩放、选中与筛选状态不受影响，`Back to Inspect` 随时返回。Raw 不使用左侧第六个标签页，因此在 200px 最小面板宽度下左侧仍只有五个标签。
- **Trailer 根**：对象树从 trailer 的 `Root`（catalog）、`Info`、`Encrypt`、`ID` 以及 catalog 的 `Pages` 引用开始，只读取这些根，不做整图遍历。
- **懒加载引用**：`15 0 R` 这样的引用本身就是一个节点，展开或点击时才读取该对象；引用不会自动递归解析，循环引用不会展开成死循环，树上限 8 层并提示深度限制。
- **字典、数组与流**：右侧 `Object` 标签页显示对象摘要与值树，区分 null / 布尔 / 数字 / 字符串 / 名称 / 引用 / 数组 / 字典 / 流；字典与数组可展开，流只显示长度、过滤器、Subtype 与有界文本预览，二进制字节永不返回。
- **内容流操作符**：`Content stream` 标签页按页解码页面内容流，逐条列出序号、offset、操作符与操作数（`BT` / `Tf` / `Tj` / `Do` / `cm` 等）；操作数中的引用可点击跳转到对应对象，所有文本按普通文本渲染，操作符只读取、不执行。
- **上限与截断**：嵌套 4 层、每个容器 100 项、字符串与预览 4096 字符、每页 5000 个操作符、每页 20 条内容流；超限时标记 `truncated` 并在界面提示，而不是静默截断。
- **只读**：不能编辑对象、重写流、解密或执行内容流，也不提供 raw diff、导出或 CLI。序列化语义、上限与安全边界详见 [docs/raw.md](docs/raw.md)。

### PDF Diff

- **对象级变更**：对 word / char / rect / line / curve / image / table 七类对象逐页比较，报告 `added` / `removed` / `moved` / `modified`；每条变更包含旧/新页码、BBox、文本与细节（字体、字号、颜色、描边/填充、content hash、表格单元格等）。
- **页面级变更**：识别页面新增/删除、页面尺寸与 `/Rotate` 旋转角变化；这些变化以页面级说明展示，而不是对象框。
- **表格单元格**：表格按单元格文本比较，`details.cellChanges` 列出变化的行、列与旧/新文本，并报告行列数变化。
- **容差与忽略**：可调位置容差（pt，默认 1.0）与文本比较模式（`exact` / `normalized` / `case-insensitive`，默认 `normalized`），并可忽略字体、颜色、图片或指定对象类型。对比对话框提供位置容差与忽略字体/颜色/图片；文本容差与 `--ignore-types` 通过 CLI 使用。
- **对比工作区**：顶部摘要（页数、页面变更、各类对象计数）加左侧按页变更列表，支持按 Kind / Type 过滤；中间为并排（Side by side）、叠加（Overlay）或视觉（Visual）视图，共享页码与缩放；右侧显示选中变更的新旧文本、Box 与字段差异。
- **叠加配色**：叠加模式以页面所属文档为底图（有旧页用旧页，新增页用新页），绘制旧/新对象框——移除红、新增绿、移动橙、修改蓝，便于在同一位置快速定位改动。
- **Export JSON**：把当前结果导出为 `DiffResult` JSON（`schemaVersion: 1`）。
- **不影响当前检查**：Diff 在独立的旧/新文档上运行，Inspect 中打开的文档、页码、缩放与选中状态保持不变；`Back to Inspect` 返回原文档。

#### PDF Diff 2.0

- **页面对齐与重排**：页面先按内容指纹（页面尺寸、旋转、文本哈希、对象计数、表格文本）配对，结果在每个 `DiffPage` 上新增 `match: { score, reordered }`，摘要新增 `pagesReordered`。`reordered` 表示配对页在修订版中换了页码（`oldIndex != newIndex`），不是对象顺序变化；插入/删除页保持单侧（`match: null`）。页面列表与页面栏显示 `Old 2 → New 1` 形式的新旧页码。
- **Visual 视觉差异**：`Visual` 视图以新页为底图、旧页半透明叠加（`Blend`），或逐像素比较并绘制热力图（`Heatmap`），也可只看对象框（`Boxes`）；页面栏显示 `changed / total px (百分比)`。逐像素比较在浏览器 canvas 中完成，通道差阈值固定为 24，并按上限缩放位图；结果不写入 CLI/JSON。
- **忽略区域**：打开 `Ignore region` 后在并排/叠加页面拖动矩形，区域按页与 MediaBox 坐标记录（`DiffIgnoreRegion`：`oldPage` / `newPage` / `bbox`），虚线框与左侧区域列表同步显示；`Apply & re-run` 显式重新比较，与区域相交的变更从 JSON/UI/HTML 中消失，`Remove` 后重新运行即可恢复。区域只读，不修改 PDF。
- **忽略区域 CLI/Action**：`--ignore-regions PATH` 读取与 UI 相同的 camelCase JSON 数组；action 提供同名输入 `ignore-regions`。
- **重排阈值**：`--fail-on reordered` 在存在 `pagesReordered > 0` 时返回 1，适合把“页序变化”作为独立门禁；原有 `added` / `removed` / `modified` / `page-count` / `none` 语义不变。
- **生成示例**：`web-samples/diff-visual-old.pdf` / `diff-visual-new.pdf`（第 1 页文字、颜色与位置小幅变化）与 `web-samples/diff-reordered-old.pdf` / `diff-reordered.pdf`（删除首页草稿、追加发布说明，4 个配对页换位）由 `scripts/generate-web-samples.py` 确定性生成。
- **详细说明**：页面对齐语义、视觉模式、区域 JSON、CLI/action 示例与阈值见 [docs/diff.md](docs/diff.md)。

#### 对象级与视觉级的关系

- **对象仍是事实来源**：变更列表、过滤、导出 JSON、CLI 与 action 都基于提取出的对象及其元数据；视觉视图只是额外的 UI 视图，不替代对象级结果，也不做 OCR。

### 文档体检

- **整档检查**：跨字体、页面、图片、元数据、结构与安全执行确定性检查，覆盖未嵌入字体、缺少 ToUnicode、混合页面尺寸、旋转页面、页面框越界、低分辨率图片、图片页无可提取文本、扫描页、空页面、缺失元数据、加密与未标记 PDF 等场景。
- **严重级别**：发现分为 `error` / `warning` / `info`，不提供“健康分”。页面提取失败是当前的 `error` 来源；未嵌入字体为 `warning`，Standard 14 字体不会被视为缺失。
- **分批进度**：文档级检查完成后按每 10 页一批顺序执行页面检查，并实时显示 `Auditing pages N/M…`；批次之间界面保持可用。
- **独立工作区**：工具栏 `Audit` 打开文档体检工作区（与 Diff 互斥），顶部显示文件与 `Run` / `Re-run`，左侧按严重级别汇总并可按严重级别/类别筛选，中间为发现列表，右侧显示选中发现的说明、证据与修复建议。
- **跳转到页面**：带页码的发现提供 `Open page`，点击后关闭 Audit 并在 Inspect 中导航到该页；Inspect 中打开的文档、页码、缩放与选中状态保持不变，`Back to Inspect` 可随时返回。
- **JSON 导出**：`Export JSON` 保存完整的 `AuditReport`（`schemaVersion: 1`），包含 tool、document、summary 与 findings；CLI `audit --format json` 输出同一 schema。
- **报告与集成**：CLI 支持 `summary` / `json` / `html` 三种格式，HTML 为单文件、内联 CSS、无脚本；`audit/action.yml` 可在 CI 中运行审计并按 `fail-on` 决定步骤成败。详见 [docs/audit.md](docs/audit.md)。
- **启发式检查**：审计基于提取出的对象、字体信息、页面框与 catalog 元数据，不做 PDF/A 认证或签名验证，也不做 OCR；旋转页或 CropBox 偏移页上的发现只到页面级。

### 打开方式

- 打开本地 PDF，或通过 `http(s)` URL 打开远程文档（先下载到临时目录再解析）。
- 桌面端与 Web 端能力一致，仅底层通道不同。

### 桌面与 Web

- **桌面端**：Electron 主进程负责窗口、原生菜单/对话框与 Python 侧车生命周期。
- **Web 端**：React UI 在浏览器中运行，由无 Electron 依赖的 Node HTTP 后端提供同样的文档与侧车能力。
- **多文档**：桌面端与 Web 端都支持文档标签页。桌面标签按本地路径或 URL 重新打开文档；Web 标签按服务端 `documentId` 激活已登记文档。两者都只保存视图快照，不保留第二份 PDF.js 文档或分析缓存。

### 键盘快捷键

| 快捷键 | 作用 |
|--------|------|
| `T` | 切换文本选择模式 |
| `R` | 切换区域框选模式（与文本选择互斥） |
| `F` | 切换 Focus 模式（隐藏左右面板） |
| `Ctrl/Cmd+F` | 打开搜索 |
| `Ctrl/Cmd+滚轮` | 缩放文档；向上滚放大，向下滚缩小（触控板捏合同样生效） |
| `Esc` | 清除选中、筛选与框选结果 |

## 快速开始

### 环境要求

- **Node.js ≥ 22.12**（见 `.nvmrc`；jsdom 需要 `require(esm)` 支持）
- **Python 3.10+**
- Python 包：`pdfplumber`、`Pillow`（见 `sidecar/requirements.txt`）；运行测试还需 `pytest`、`reportlab`

### 安装

```bash
npm ci

python3 -m venv .venv
.venv/bin/pip install -r sidecar/requirements.txt

# 运行 Python 测试时
.venv/bin/pip install pytest reportlab
```

Windows 下将 `.venv/bin/pip` 换成 `.venv\Scripts\pip`，Python 解释器对应 `.venv\Scripts\python`。

### 桌面端

```bash
npm run dev      # Vite 开发服务器 + Electron（HMR）
npm start        # 构建 main 进程并启动 Electron
```

桌面模式需要 Electron 二进制，`npm install` / `npm ci` 默认会下载。若设置了 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`（例如 CI 中只为跑测试），则无法启动桌面应用。

### Web 端

```bash
npm run web        # 构建 Web 前端与 HTTP 后端，然后启动服务
npm run web:start  # 直接启动已构建的 dist-web-server/server.mjs
```

默认监听 <http://localhost:8080>。可用环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HOST` | `0.0.0.0` | 监听地址；仅本机访问可设为 `127.0.0.1` |
| `PORT` | `8080` | 监听端口 |
| `PDF_INSPECTOR_PYTHON` | 优先使用 `.venv` 中的解释器，否则 `python3` | 启动 Python 侧车使用的解释器 |

生成演示 PDF：

```bash
python scripts/generate-web-samples.py
```

随后在 Web 界面打开 `/samples/basic.pdf`（小型示例，含表格与图片）、`/samples/large.pdf`（多页文档，便于观察字体分批分析）、`/samples/huge.pdf`（1000 页纯文本示例，用于页面列表、Go to page 与搜索索引进度）、`/samples/annotations.pdf`（两页示例，含外部/内部链接、文本注释、高亮与表单字段，用于 `Annots` 标签页）或 `/samples/raw.pdf`（两页示例，含命名字体资源、图片 XObject 与 `BT`/`Tf`/`Tj`/`Do` 操作符，用于 `Raw` 工作区）。

Diff 的示例文件成对生成，可在对比对话框中分别选择 Old/New：

| 示例 | 用途 |
|------|------|
| `web-samples/diff-visual-old.pdf` → `web-samples/diff-visual-new.pdf` | 两页文档，第 1 页状态徽标颜色/文字、色块颜色与位置、正文数字小幅变化；第 2 页完全相同，用于 `Visual` 的 Blend/Heatmap 与像素统计。 |
| `web-samples/diff-reordered-old.pdf` → `web-samples/diff-reordered.pdf` | 五页文档，修订 B 删除首页草稿、追加发布说明并移动页眉分隔线，产生 4 个重排配对、1 个删除页与 1 个新增页，用于页面对齐与 `--fail-on reordered`。 |

> **安全提示**：Web 服务没有身份认证，任何能访问该端口的人都可以上传/下载文档、调用解析接口。默认绑定 `0.0.0.0`，请仅在可信网络使用；本机使用时建议 `HOST=127.0.0.1 npm run web`。

## 使用说明

1. **打开文档**：点击 Open 选择本地 PDF，或点击 Open URL 输入 `http(s)` 地址。
2. **浏览结构**：在左侧 `Objects` 标签页展开/折叠页面节点，或切换到 `Outline` 按书签跳转；也可用工具栏的 Prev/Next 翻页。
3. **检查对象**：在画布上悬停查看轮廓，点击后在右侧 Inspector 的 `Inspect` 标签页查看坐标、字体、颜色与原始数据。选中表格时会显示单元格网格，可悬停预览、点击选中单元格并查看其 Span 与 BBox。
4. **筛选对象**：在 Inspector → `Filter` 中按字体/字号/颜色/类型筛选，或切到 `R` 模式拖拽框选区域，再在 `Results` 中选择相交/包含匹配。
5. **字体分析**：切换到左侧 `Fonts` 标签页开始分析，查看进度与嵌入状态徽标；展开条目可看 Encoding、ToUnicode 等细节，点击字体条目跳转到使用页并高亮。
6. **查看页面几何**：在 Inspector → `Page` 标签页查看页面尺寸、旋转角与五个页面框，切换 pt/mm，并按需开关各框叠加与画布标尺。
7. **控制叠加层**：在左侧 `Layers` 标签页开关七类对象、查看当前页计数、使用 Solo 或调整透明度；`F` 可进入专注模式，隐藏左右面板。
8. **搜索与导出**：`Ctrl/Cmd+F` 搜索；通过 Export 选择当前页/整档、JSON/CSV 与要包含的元素类型。
9. **比较版本**：点击工具栏 `Diff` 选择 Old/New 两份 PDF，按需设置位置容差与忽略项后 Compare；在左侧变更列表选择条目查看详情，或在 Side by side / Overlay / Visual 间切换（Visual 可切 Blend/Heatmap/Boxes 并查看像素统计），`Ignore region` 可拖框屏蔽区域后再 `Apply & re-run`；`Export JSON` 保存结果。
10. **文档体检**：点击工具栏 `Audit` 对当前文档执行整档审计，查看严重级别汇总，按严重级别/类别筛选，选中发现查看证据与建议；需要时点击 `Open page` 跳转到对应页面，或用 `Export JSON` 保存完整报告。
11. **检查注释与表单**：切换到左侧 `Annots` 标签页查看当前页的注释、链接与表单字段，按 Kind/Subtype 过滤；点击列表行或画布上的注释框，在 Inspector 的 `Inspect` 中查看只读详情。外部链接需点击 `Open link` 才会打开，内部链接使用 `Go to page N` 跳转；表单字段不能编辑或提交。
12. **查看原始对象与内容流**：点击工具栏 `Raw` 打开只读工作区，在左侧对象树展开 `Catalog` → `Pages` → 页面 → `Resources`，点击引用在右侧查看对象值；切换到 `Content stream` 按页查看解码后的操作符与操作数。`Back to Inspect` 返回原文档，页码与缩放保持不变。
13. **处理大文档与多文档**：打开 `/samples/huge.pdf` 后，用左侧 Go to page 输入页码（越界会夹取），页面列表只展开当前页；`Ctrl/Cmd+F` 搜索时 SearchBox 显示 `Indexing N/1000…`，可关闭搜索取消。桌面端与 Web 端都可再打开其他文件或用 Open URL 打开远程文档，通过顶部标签切换；Web 标签按服务端 `documentId` 激活并恢复视图快照，关闭标签只删除该文档的临时副本。

## CLI 与 CI

Diff 也可以脱离界面运行。CLI 只接受本地 PDF 路径（拒绝 `http(s)` URL），输出摘要、JSON 或自包含 HTML，并按 `--fail-on` 映射退出码。

```bash
# 直接使用 Python CLI；需要 Python 3.10+ 与 sidecar/requirements.txt
python sidecar/cli.py diff old.pdf new.pdf

# 通过 bin/pdf-inspector.mjs 包装器（安装/链接后可直接调用 pdf-inspector）
pdf-inspector diff old.pdf new.pdf
npm run diff -- old.pdf new.pdf

# 页序变化单独作为门禁；存在重排配对时返回 1
python sidecar/cli.py diff old.pdf new.pdf --fail-on reordered

# 用 JSON 区域屏蔽相交的变更（与界面绘制的区域相同）
python sidecar/cli.py diff old.pdf new.pdf --ignore-regions regions.json --format json --output diff.json
```

常用选项：

| 选项 | 说明 |
|------|------|
| `--format` | 输出格式：`summary`（默认）/ `json` / `html` |
| `--output PATH` | 把格式化结果同时写入文件；stdout 仍打印摘要 |
| `--fail-on` | 决定哪些差异返回 1；默认 `any`，可选 `added` / `removed` / `modified` / `page-count` / `reordered` / `none` |
| `--position-tolerance PT` | 位置容差（PDF pt），默认 `1.0` |
| `--text-tolerance` | 文本比较模式：`exact` / `normalized`（默认）/ `case-insensitive` |
| `--ignore-types TYPES` | 跳过指定对象类型，逗号分隔、可重复 |
| `--ignore-fonts` / `--ignore-colors` / `--ignore-images` | 忽略字体/颜色/图片差异 |
| `--ignore-regions PATH` | JSON 数组，按页与 MediaBox 坐标屏蔽相交的变更（与 UI 的 `DiffIgnoreRegion` 相同） |
| `--quiet` | 不打印人类摘要，只保留 JSON/HTML 输出 |

退出码：`0` 表示无差异，或差异均被 `--fail-on`/忽略选项排除；`1` 表示 `--fail-on` 条件命中；`2` 表示参数、输入、解析或输出错误。`--fail-on none` 永不返回 1，但输入错误仍返回 2。`added` / `removed` 同时覆盖对象与页面，`modified` 覆盖 modified、moved 以及页面尺寸/旋转变化，`page-count` 覆盖页面增删、页数与页面几何变化，`reordered` 覆盖配对页换了页码（`pagesReordered > 0`）。

`--format json` 输出独立的 `DiffResult`（`schemaVersion: 1`），与检查器的对象导出 JSON 不是同一 schema；它包含 `tool` / `options` / `old` / `new` / `summary` / `pages`，每个变更带 kind、type、旧/新页码与 BBox、文本与 `details`。输出不含时间戳与绝对路径、顺序稳定，相同输入与选项产生逐字节一致的 JSON，便于提交、diff 或缓存。

### 审计 CLI

文档体检同样可以脱离界面运行，复用与界面相同的检查引擎。CLI 只接受本地 PDF 路径（拒绝 `http(s)` URL），输出摘要、`AuditReport` JSON 或单文件 HTML，并按 `--fail-on` 映射退出码。

```bash
# 直接使用 Python CLI；需要 Python 3.10+ 与 sidecar/requirements.txt
python sidecar/cli.py audit report.pdf
python sidecar/cli.py audit report.pdf --format json --output report.audit.json
python sidecar/cli.py audit report.pdf --format html --output report.audit.html

# 发现 warning/error 时返回 1，适合作为质量门禁
python sidecar/cli.py audit report.pdf --fail-on warning

# 通过 bin/pdf-inspector.mjs 包装器（安装/链接后可直接调用 pdf-inspector）
pdf-inspector audit report.pdf
node bin/pdf-inspector.mjs audit report.pdf --format json --output report.audit.json
```

常用选项：

| 选项 | 说明 |
|------|------|
| `--format` | 输出格式：`summary`（默认）/ `json` / `html` |
| `--output PATH` | 把格式化结果同时写入文件；stdout 仍打印摘要 |
| `--fail-on` | 决定哪些发现返回 1；默认 `none`，可选 `error` / `warning` / `none`。`warning` 同时覆盖 errors，`error` 只覆盖 errors |
| `--quiet` | 不打印人类摘要，只保留 JSON/HTML 输出 |

退出码：`0` 表示没有严重级别命中 `--fail-on`；`1` 表示 `--fail-on` 命中；`2` 表示参数、输入、读取或审计错误。`--fail-on none` 永不返回 1，但输入错误仍返回 2。页面提取失败是当前唯一的 `error` 来源，因此 `--fail-on error` 只会拦截真正不可读的页面。

`--format json` 输出 `AuditReport`（`schemaVersion: 1`），包含 `tool` / `document` / `summary` / `findings`；每条发现带类别、严重级别、页码（文档级为 `null`）、标题、说明、证据与建议。输出不含时间戳与绝对路径，顺序稳定，相同 PDF 产生逐字节一致的 JSON。HTML 报告为单文件、内联 CSS、无脚本、无外部资源，所有 PDF 文本均转义。完整 schema、检查项与阈值见 [docs/audit.md](docs/audit.md)。

### Diff GitHub Action

仓库提供 composite action（[`action.yml`](action.yml)），会在 runner 上安装 Python 与 sidecar 依赖后运行 diff：

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: git show origin/${{ github.base_ref }}:docs/report.pdf > baseline.pdf
- uses: <owner>/pdf-inspector@v1
  with:
    old: baseline.pdf
    new: docs/report.pdf
    fail-on: any
    format: json
    json-path: artifacts/pdf-diff.json
```

只关心页序、并屏蔽已知区域时可以组合使用：

```yaml
- uses: <owner>/pdf-inspector@v1
  with:
    old: baseline.pdf
    new: docs/report.pdf
    fail-on: reordered          # 仅当配对页换了页码时失败
    ignore-regions: ignore-regions.json
```

action 默认 `fail-on: any`，支持 `summary` / `json` / `html`；`json-path` / `report-path` 指定 JSON/HTML payload 的文件路径（`format` 选中对应格式且未指定路径时写入 runner 临时目录），payload 不写入步骤日志。`fail-on` 可选 `any` / `added` / `removed` / `modified` / `page-count` / `reordered` / `none`；`ignore-regions` 接收与 CLI 相同的区域 JSON 路径并透传。完整输入、输出、artifact 约定见 [docs/ci.md](docs/ci.md)，Diff 2.0 的页面对齐、视觉视图与区域语义见 [docs/diff.md](docs/diff.md)。

HTML 报告是单文件、内联 CSS、无脚本、无外部资源：

<img src="docs/images/diff-report.png" alt="PDF diff HTML 报告：文档 SHA-256、变更汇总、diff 选项与逐页变更表" width="560">

> Diff 的 CLI 与 action 都需要 Python 3.10+ 及 `sidecar/requirements.txt` 中的依赖，并且只读取本地路径；打包后的桌面应用不包含 CLI。

### 审计 GitHub Action

仓库还提供审计 composite action（[`audit/action.yml`](audit/action.yml)），会在 runner 上安装 Python 与 sidecar 依赖后运行 `audit`：

```yaml
- uses: actions/checkout@v4
- uses: <owner>/pdf-inspector/audit@v1
  with:
    path: docs/report.pdf
    fail-on: error
    format: html
    report-path: artifacts/pdf-audit.html
    # 需要 JSON 时可同时指定；会额外执行一次 CLI 生成该 artifact
    # json-path: artifacts/pdf-audit.json
```

action 默认 `fail-on: error`、`format: summary`，支持 `summary` / `json` / `html`；`json-path` / `report-path` 指定 JSON/HTML payload 的文件路径（`format` 选中对应格式且未指定路径时写入 runner 临时目录），payload 不写入步骤日志。输出 `exit-code` / `json-path` / `report-path`，并把退出码、`fail-on` 与 artifact 路径写入步骤摘要。非零退出码会先写入输出再让步骤失败，因此后续步骤仍可读取结果。仓库内使用 `uses: ./audit`，完整输入、输出与示例见 [docs/audit.md](docs/audit.md)。

## 架构

同一套 React 渲染层，桌面端通过 Electron IPC 访问侧车，Web 端通过 HTTP 访问 Node 后端；两侧最终都使用 stdio 上的 JSON-RPC 驱动 Python 侧车。

```
桌面模式
┌──────────────────────────────────────────────┐
│ Electron Main                                │
│ 窗口 / 原生对话框 / Python 侧车生命周期       │
└───────────┬──────────────────────────┬───────┘
            │ IPC (contextBridge)      │ spawn
            ▼                          ▼
┌───────────────────────┐   ┌───────────────────────┐
│ Renderer (React)      │   │ Python Sidecar        │
│ PDF.js / 叠加层 / UI  │   │ pdfplumber / 页缓存   │
└───────────────────────┘   └───────────────────────┘

Web 模式
┌──────────────────────────────────────────────┐
│ Browser (React + PDF.js)                     │
│ `window.pdfInspector` 由 src/web 适配器实现   │
└───────────┬──────────────────────────────────┘
            │ HTTP：/api/*、/doc/*、/samples/*
            ▼
┌──────────────────────────────────────────────┐
│ Node HTTP Server（server/web-server.ts）      │
│ 上传/下载临时文件、文档注册表、静态资源       │
└───────────┬──────────────────────────────────┘
            │ spawn + JSON-RPC over stdio
            ▼
      Python Sidecar（同上）
```

Python 侧车通过 stdin/stdout 上的行分隔 JSON-RPC 通信，提供 `open`、`extract_page`、`extract_metadata`、`analyze_fonts`、`get_image_data`、`raw_document`、`raw_object`、`raw_page_content`、`audit_document`、`audit_pages`、`shutdown` 等方法，并用 LRU 缓存复用已解析页面。

桌面端与 Web 后端都用 `SidecarPool` 把请求路由到交互/后台两个通道：交互通道负责打开与当前页提取，后台通道懒启动并负责字体、审计、Raw 与 Diff。两个通道打开同一份文档，切换文档时重新打开，不保留 N 份解析结果。详见 [docs/large-docs.md](docs/large-docs.md)。

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面容器 | Electron 28 |
| Web 后端 | Node.js 内置 `http`（无额外运行时依赖） |
| 前端 | React 18 + TypeScript + Vite + Zustand + CSS Modules |
| PDF 渲染 | pdfjs-dist 4.x |
| 提取引擎 | Python 3 + pdfplumber（JSON-RPC over stdio 子进程） |
| 前端测试 | Vitest + Testing Library + jsdom |
| Python 测试 | pytest + reportlab（生成测试用 PDF） |

## 项目结构

```
pdf-inspector/
├── src/
│   ├── main/              # Electron 主进程：窗口、IPC、URL 下载、侧车管理
│   ├── preload/           # contextBridge → window.pdfInspector
│   ├── renderer/          # React UI、PDF.js 渲染、叠加层、hooks、store、services
│   ├── shared/            # 主进程/渲染进程共享常量与工具
│   └── web/               # 浏览器入口与 HTTP 版 IPC 适配器
├── server/
│   └── web-server.ts      # 无 Electron 依赖的 Node HTTP 后端
├── sidecar/               # Python 侧车（extractor / cache / models / main）
│   ├── cli.py             # `pdf-inspector diff` / `audit` CLI
│   ├── diff.py            # 对象级 diff 引擎
│   ├── report.py          # Diff 摘要与自包含 HTML 报告
│   ├── raw.py             # 原始对象图与内容流序列化（有界、只读）
│   ├── audit.py           # 文档审计引擎（检查项、排序、AuditReport）
│   ├── audit_report.py    # 审计摘要与单文件 HTML 报告
│   ├── __tests__/         # pytest 测试
│   └── requirements.txt
├── bin/
│   └── pdf-inspector.mjs  # CLI 包装器（解析 Python 并转发退出码）
├── scripts/
│   ├── generate-web-samples.py  # 生成 web-samples/*.pdf
│   ├── generate-icon.js
│   └── freeze-sidecar.sh
├── docs/
│   ├── audit.md           # 文档体检：检查项、AuditReport schema、CLI 与 action
│   ├── annotations.md     # 注释、链接与表单：数据来源、只读策略与限制
│   ├── raw.md             # 原始对象树与内容流：序列化语义、上限与安全边界
│   ├── large-docs.md      # 大文档：双通道、搜索分批、页面列表、桌面/Web 文档标签与边界
│   ├── diff.md            # Diff 2.0：页面对齐、视觉模式、忽略区域与阈值
│   ├── ci.md              # Diff CLI 与 GitHub Action
│   ├── packaging.md       # 打包说明
│   ├── images/            # README 截图
│   └── superpowers/       # 设计与实施文档（specs / plans）
├── web-samples/           # 生成的演示 PDF（已 gitignore）
├── .github/workflows/ci.yml
├── action.yml             # PDF diff composite action
├── audit/action.yml       # PDF audit composite action
├── index.html             # Electron 入口
├── index.web.html         # 浏览器入口
└── package.json
```

## 开发与测试

```bash
# TypeScript：Node/main 项目与 Web 项目
npx tsc -b
npx tsc -p tsconfig.web.json

# 前端单元测试
npx vitest run

# Python 侧车测试（请使用虚拟环境中的解释器，确保依赖可用）
.venv/bin/python -m pytest sidecar/__tests__ -q
```

`npx tsc -b` 使用项目引用，会同时检查 main、preload、renderer 与 shared。提交前建议执行上面的全部命令。

CI 由 `.github/workflows/ci.yml` 定义：在推送到 `main`、推送 `v*` 标签、Pull Request 及手动触发时，执行上述类型检查与测试，并构建桌面端、Web 前端、Web 后端及生成演示 PDF；此外还有 diff CLI、diff action、audit CLI 与 audit action 的端到端任务。

## 打包发布

```bash
npm run freeze:sidecar   # PyInstaller 冻结 Python 侧车
npm run dist             # 当前平台安装包（electron-builder）
npm run dist:win         # Windows
npm run dist:mac         # macOS
npm run dist:linux       # Linux
```

打包产物包含冻结后的侧车，最终用户无需安装 Python。PyInstaller 不支持交叉编译，每个平台需在对应宿主上构建。详细步骤、平台依赖与产物说明见 [docs/packaging.md](docs/packaging.md)。

## 配置与安全

- **Electron 桌面端**只通过 IPC 与本机侧车通信，不监听网络端口。
- **Web 端**默认监听 `0.0.0.0:8080`，没有认证与访问控制；请用 `HOST` 限制监听地址，或放在带认证的反向代理之后。
- Web 端的活动文档及上传/下载文件存放在系统临时目录，正常关闭时清理；崩溃或强杀进程可能残留。
- URL 打开仅接受 `http(s)`，下载受超时限制。
- 侧车请求有超时保护；桌面端会自动重启侧车，Web 后端会在请求时自动拉起进程，并提供 `/api/restart` 接口。
- 测试或 CI 中可用 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过 Electron 二进制下载（仅影响桌面端启动）。

## 已知限制

- 侧车一次处理一个请求；单批字体分析执行期间，其他解析请求需要等待，批次之间会插入处理。
- 字体分析按 10 页一批顺序执行，超大文档需要较长时间，但可分页浏览并查看进度。
- 旋转页面（`/Rotate` 为 90/180/270）仍显示页面框与标尺，但对象叠加层不可用：对象坐标按未旋转页面映射，无法可靠对齐；Diff 的并排/叠加对象框同样隐藏，旋转页也不能绘制忽略区域（`Visual` 视图仍会渲染页面，但对象框与区域遮罩可能偏移）。
- 当 CropBox 小于 MediaBox 时，页面框与标尺以 MediaBox 作为页面框架，而 PDF.js 按 CropBox 渲染，因此页面与内容边距的视觉表现可能不同；Diff 的叠加框也以 MediaBox 为基准，可能同样偏移。
- Diff 的对象配对是启发式的：重复出现的相同对象（重复文字、相同几何的线条/矩形）只能按距离或阅读顺序贪心匹配；对象同时移动且内容改变、超出位置容差时，可能被报告为 `removed` + `added` 而不是 `modified` / `moved`。可调整 `--position-tolerance`、文本容差或忽略相应类型来减少噪声。
- Diff 只比较提取出的对象及其元数据，不做渲染后的像素级 diff 或 OCR；扫描页面上的文字不会被识别为文本对象。`Visual` 视图的像素对比只在浏览器 UI 中运行，CLI、JSON、HTML 与 action 仍然是对象级、无渲染依赖。
- 视觉对比固定使用通道差 > 24 的阈值，并把位图按上限缩放后比较（数值是采样统计，不是逐设备像素的精确值）；阈值与位图上限不暴露为设置项，CLI 也不提供 headless 视觉 diff。
- 忽略区域是只读的页面坐标矩形：以 MediaBox 的 PDF pt 记录，按“变更 BBox 与区域相交”过滤，因此一个覆盖整块区域的矩形可能同时屏蔽该区域内多个对象（包括表格整体）；区域只对当前这次比较生效，切换文件或重置后清空，不能跨运行共享。
- `match` 与 `pagesReordered` 是 `DiffResult` 的新增字段，`schemaVersion` 仍为 `1`；旧消费者可以忽略这些字段，但读取方不应假定字段集合完全固定。
- 页面对齐基于内容指纹 + `SequenceMatcher`：移动页可能被报告为“删除 + 新增”，只有被配对的页才会标记 `reordered`；重复页按顺序配对，不能识别真正的“交换”语义。
- Diff CLI 需要 Python 3.10+ 与 sidecar 依赖，且只接受本地路径；`--fail-on` 只决定差异是否返回 1，参数/输入/解析错误始终返回 2，`none` 不会抑制错误。打包后的桌面应用不包含 CLI。
- 文档体检的检查是启发式的：基于提取出的对象、字体信息、页面框与 catalog 元数据，可能出现误报或漏报；`--fail-on` 与 action 阈值应结合项目实际情况设置。
- 文档体检不做 PDF/A 合规认证，也不验证数字签名；“未标记 PDF”只是诊断提示，不代表合规结论。
- 文档体检不做 OCR，也不识别扫描页中的文字；扫描页只能得到“有图片但无可提取文本”的提示。
- 旋转页或 CropBox 偏移页上的审计发现只到页面级，无法给出对象级高亮；带页码的发现仍可跳转到对应页面。
- 文档体检按 10 页一批串行执行（与字体分析相同），超大文档需要较长时间；页面提取失败是当前唯一的 `error` 来源。CLI 与 action 同样需要 Python 3.10+ 与 sidecar 依赖，且只接受本地路径，打包后的桌面应用不包含 CLI。
- 注释、链接与表单只覆盖当前页：翻页后重新加载，不提供整档注释索引、跨页搜索或批量浏览；大文档需逐页查看。
- 注释与表单是只读的：不能新建、编辑或删除注释，不能填写、重置或提交表单，也不导入 XFA 数据；签名字段只显示为字段，不做数字签名验证。
- 注释与表单不参与导出、Diff、Audit 或 CLI：导出、比较与审计仍只处理对象层，不包含注释、链接与表单字段。
- 外部链接只在用户点击 `Open link` 时打开，且仅支持 `http(s)`；`mailto:`、`file:`、`data:`、`javascript:` 等目标只显示、不打开。内部链接只跳转到解析出的页码，不恢复滚动位置，未解析的目标保持只读展示。
- 旋转页（`/Rotate` 为 90/180/270）只提供注释列表与详情，不绘制画布框与命中测试；CropBox 与 MediaBox 不一致的页面，注释框以 MediaBox 为基准，可能整体偏移（与对象叠加层一致）。
- 原始对象视图是只读的：不能编辑对象、重写流、解密或执行内容流，也不提供 raw diff、导出或 CLI；需要修改 PDF 时请使用其他工具。
- 原始对象视图只返回有界数据：嵌套、条目、字符串、操作符与内容流数量都有上限，超限标记 `truncated` 并在界面提示；二进制流只显示长度、过滤器与 Subtype 等元数据，不提供字节预览。
- 原始对象视图不是完整 PDF 解析器：不遍历整个对象图，不解析 XFA 或结构树，也没有对象搜索/查询语言；大文档需要按引用逐层展开。
- Raw 不使用左侧第六个标签页：它通过工具栏打开独立工作区，并与 Diff、Audit 互斥；与 Inspect 的切换不会改变文档状态，但 Raw 自身不保存展开状态，重新打开从 trailer 根开始。
- Web 多文档是会话级、单 sidecar 实现：sidecar 中始终只有活动文档，切换是串行重新打开，不能同时分析多份文档，也没有每文档 sidecar。注册表最多 8 份文档 / 总 512 MiB，超出时按最近最少激活淘汰非活动文档；被淘汰的标签需重新打开。Web 端仍没有认证、多用户隔离或按用户的文档边界，多文档不改变这一信任模型。
- Web 关闭活动标签时必须先激活邻居：服务端拒绝在仍有兄弟时删除活动文档；激活失败会保留原标签与文档。关闭最后一个标签时，只有服务端也只剩这一份登记文档才会删除活动文档并回到空状态；刷新遗留的登记文档会让 `DELETE` 返回 409，标签保留。
- 桌面与 Web 标签都只保存视图快照：页码、缩放、叠加层、左右面板标签与查询字符串会恢复；字体、审计、Raw 结果与搜索索引不跨标签保留，切回后需重新运行。桌面 URL 标签重新激活会重新下载，Web URL 文档由服务端保留并按 `sourceUrl` 去重；标签状态均不写入 localStorage，刷新或重启后不恢复。
- 后台 sidecar 通道懒启动但本阶段不做空闲自动退出；使用过字体/审计/Raw/Diff 后会保留第二个 Python 进程直到退出或重启。
- 搜索索引只保存每页文本，没有按字节的上限；1000 页可接受，极大文档仍需依靠取消、关闭搜索或切换文档释放。
- 页面列表使用 CSS `content-visibility` 窗口化，DOM 中仍保留每页一个行节点；若未来出现数千页的滚动卡顿，再评估真正的虚拟列表。
- 搜索框展开时，工具栏优先保证输入框、计数、上/下与关闭按钮完整可见；窗口宽度 ≤1280px 时隐藏文件名（不是控件，标题仍可在打开对话框与状态栏查看），>1280px 时文件名继续显示。1280/1440/1600 打开搜索均无横向溢出。
- 临时文件清理为尽力而为，异常退出后可能需要手动清理系统临时目录。
- Web 模式需先构建 `dist-web` 与 `dist-web-server`；未构建时服务会提示构建后刷新。
