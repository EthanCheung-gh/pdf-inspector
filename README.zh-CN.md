<p align="center"><img src="build/icon.png" alt="PDF Inspector 应用图标：深色圆角底上的 PDF 页面、蓝/橙/绿对象框与青色检查镜，上方为金色弧线" width="96" height="96"></p>

# PDF Inspector

[English](README.md) | 简体中文

面向开发者的 PDF 结构检查工具——在 PDF.js 渲染结果之上叠加 pdfplumber 的坐标级对象数据，直观检查字符、单词、线条、曲线、矩形、表格和图片，并以只读方式检查注释、链接、表单字段、原始对象树与内容流。可把当前页或选中区域导出为 PNG/SVG、生成自包含 HTML 检查报告，并在 Dark / Islands / Light / System 四种主题与 English / 简体中文之间切换。提供 Electron 桌面应用与浏览器（Node HTTP 后端）两种运行方式。

[![CI](https://github.com/EthanCheung-gh/pdf-inspector/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/EthanCheung-gh/pdf-inspector/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-v0.3.3-blue.svg)](https://github.com/EthanCheung-gh/pdf-inspector)
[![Tag](https://img.shields.io/badge/tag-v0.3.3-blue.svg)](https://github.com/EthanCheung-gh/pdf-inspector/releases/tag/v0.3.3)
[GitHub](https://github.com/EthanCheung-gh/pdf-inspector) · [GitCode](https://gitcode.com/EthanCheung/pdf-inspector)

|  |  |
| :---: | :---: |
| ![工作区总览：Objects / Outline / Fonts / Layers 标签与可调整面板](docs/images/overview.png) | ![对象检查](docs/images/inspector.png) |
| ![浅色主题：白色面板、蓝色强调色与浅色画布上的 PDF 页面](docs/images/theme-light.png) | **四种主题**<br>工具栏右侧的原生 `Theme` 下拉框提供 `Dark`、`Islands`、`Light` 与 `System`。`System` 跟随 `prefers-color-scheme`，选择会持久化，`data-theme` 写入实际解析后的配色。 |
| ![字体分析：嵌入状态徽标与 Standard 14 汇总](docs/images/fonts.png) | ![URL 打开](docs/images/url-dialog.png) |
| ![图层面板](docs/images/layers.png) | **Layers**<br>七类对象开关、计数、All/None、Solo 与透明度。 |
| ![按元素类型导出](docs/images/export-dialog.png) | **按元素类型导出**<br>选择当前页/整档、JSON/CSV 与要包含的元素类型；未勾选的类型不会写入文件。 |
| ![导出视图对话框：选中区域、PNG、叠加层、缩放、对象类型与可编辑文件名](docs/images/export-view-dialog.png) | **导出视图（PNG/SVG）**<br>把当前页或选中区域按 1x/2x/3x 导出，可选 Objects / Annotations / Page boxes 叠加层与对象类型过滤。PNG 以二进制保存；SVG 以 PNG 为栅格底图并叠加矢量框。 |
| ![分享报告对话框：可编辑 HTML 文件名与无脚本、无外部资源说明](docs/images/share-report-dialog.png) | **分享报告（HTML）**<br>为当前页生成自包含 HTML 检查报告，包含截图、页面组成、字体、注释索引/问题与审计发现；内联 CSS、无脚本、无外部资源。 |
| ![中文界面：工具栏、文档标签、面板标签、画布、状态栏与主题选择器均为简体中文](docs/images/i18n-zh.png) | **English / 简体中文**<br>工具栏语言按钮在 `EN` 与 `中文` 之间切换；默认英文，选择会持久化。UI 文案会翻译，命令名、JSON/CSV 字段与 sidecar/CLI 错误保持英文。 |
| ![表格单元格网格与选中单元格](docs/images/table-cells.png) | **表格单元格**<br>选中表格后显示单元格网格、合并/缺失标记与选中单元格的 BBox；悬停或点击单元格时画布同步高亮。 |
| ![页面几何：五个页面框与标尺](docs/images/page-geometry.png) | **页面几何**<br>`Page` 标签页列出 MediaBox / CropBox / TrimBox / BleedBox / ArtBox，可切换 pt/mm 并显示标尺。 |
| ![Diff 工作区：并排旧/新页面、变更摘要与列表、右侧选中变更详情](docs/images/diff-workspace.png) | **PDF Diff**<br>并排查看旧/新页面；左侧按页汇总变更，选中条目后右侧显示旧/新文本、BBox 与字段差异，顶部可重新选择旧/新文件或导出 JSON。 |
| ![叠加模式：同一页上叠加旧/新对象框](docs/images/diff-overlay.png) | **叠加模式**<br>在同一页叠加旧/新对象框（移除红、新增绿、移动橙、修改蓝），适合定位同一区域的改动。 |
| ![Visual 模式：像素热力图叠加在页面上，顶部显示 changed / total 像素统计](docs/images/diff-visual.png) | **Visual 像素对比**<br>在 Diff 工作区切到 `Visual`，以新页为底叠加旧页（`Blend`）或逐像素热力图（`Heatmap`），并在页面栏显示 `changed / total px`；`Boxes` 不做像素叠加，只显示变更框。 |
| ![忽略区域：在并排页面上拖动矩形后显示虚线框、区域列表与重新运行按钮](docs/images/diff-regions.png) | **忽略区域**<br>打开 `Ignore region` 后在任一页拖动矩形，左侧列出页码/侧/bbox，虚线框同步绘制；`Apply & re-run` 重新比较并过滤相交的变更。 |
| ![页面重排：页面列表显示 Old 2 → New 1、Old 3 → New 2 等对齐结果与新页 5 为 added](docs/images/diff-reordered.png) | **页面对齐与重排**<br>页面按内容指纹配对，列表与页面栏显示 `Old 2 → New 1` 等旧/新页码；插入/删除页保持单侧，`--fail-on reordered` 可把这些配对作为 CI 门禁。 |
| ![Diff 页列表：按页折叠的变更组、Go to page 输入与 Expand all/Collapse all](docs/images/diff-page-groups.png) | **按页分组的 Diff 结果**<br>左侧每个页面是独立可折叠组，标题保留状态与变更数；`Go to page` 输入支持夹取跳转并自动展开目标页，`Expand all` / `Collapse all` 批量控制。 |
| ![Diff 资源变更：Document changes 组列出元数据与页面标签、页级注释/链接/表单行、资源虚线框与只读的旧/新详情](docs/images/diff-resources.png) | **Diff 资源变更**<br>Diff 除了对象也比较注释、链接、表单字段、文档元数据与页面标签：类型过滤与计数、`Document changes` 组、有 BBox 的资源虚线框与只读旧/新详情；不打开链接、不执行 Launch、不填写表单。 |
| ![文档体检工作区：严重级别汇总、筛选器、发现列表与右侧选中发现详情](docs/images/audit-workspace.png) | **文档体检**<br>跨字体、页面、图片、元数据、结构与安全的整档审计；按严重级别汇总，可按严重级别/类别筛选，选中条目查看证据与修复建议，并可跳转到对应页面。切换到 `Structure` 可查看标记结构树，切换到 `Resources` 可查看附件、JavaScript、动作、签名、加密与权限。 |
| ![PDF 审计 HTML 报告：文档信息、严重级别汇总与逐条发现](docs/images/audit-report.png) | **审计报告（HTML）**<br>CLI `audit --format html` 生成单文件报告：文档信息、严重级别汇总与逐条发现（证据、建议）；内联 CSS、无脚本、无外部资源。 |
| ![文档安全资源：Audit 的 Resources 视图，包含附件、JavaScript、动作、签名、加密与 XFA 汇总卡、notes.txt 附件、脚本预览、风险动作、签名字段与安全发现](docs/images/security-resources.png) | **文档安全资源**<br>Audit 顶部可在 `发现` 与 `资源` 之间切换。`资源` 显示附件、JavaScript、动作、签名、加密与 XFA 汇总卡，并列出 `notes.txt` 附件、只读脚本预览、风险动作、未验证签名字段与安全发现计数；附件仅展示元数据，不能打开或下载。 |
| ![Audit 结构视图：发现 / 结构 / 资源切换、带角色与 MCID 占位符的结构树、问题徽标与选中 Figure 的详情（缺少 Alt）](docs/images/accessibility-structure.png) | **Audit 结构视图**<br>Audit 顶部可在 `发现` / `结构` / `资源` 之间切换。`结构` 显示标记结构树与角色、Alt/ActualText、阅读顺序、页码与 MCID，并提供搜索与 `仅显示问题`；详情只读，可 `打开页面` 或 `在发现中查看`，不编辑 tag，也不在页面上高亮元素。 |
| ![注释、链接与表单：Annots 列表、画布框选与 Inspector 只读表单详情](docs/images/annotations.png) | **注释、链接与表单（当前页）**<br>`Annots` 的 `Current page` 模式列出当前页的链接、表单字段、标记与注释；画布同步绘制只读框，选中后在 Inspector 查看字段值、选项与链接目标。 |
| ![整档注释索引：Whole document 模式下列出全部注释、Issues 与 External links 清单](docs/images/annotations-index.png) | **整档注释索引**<br>切到 `Whole document` 后按 10 页一批读取整份文档：顶部汇总 `7 annotations · 1 page · 2 links · 3 form fields`；`Issues` 默认展开、`External links` 折叠，列表按页定位并支持搜索与全局过滤。 |
| ![导出注释对话框：Export annotations、JSON 选中与可编辑文件名](docs/images/annotations-export.png) | **注释导出**<br>索引完成后 `Export` 打开对话框，可选 JSON/CSV 并修改文件名；JSON 包含文档信息、summary、按页注释、链接/表单问题与合并字段，且不写入本地绝对路径。 |
| ![Raw 对象树：Catalog → Pages → Page → Resources 逐层展开，右侧显示图片 XObject 的流元数据](docs/images/raw-object-tree.png) | **原始对象树**<br>工具栏 `Raw` 打开只读工作区；左侧从 trailer 根开始按引用懒加载，展开 `Pages`、页面与 `Resources` 后选中对象，右侧显示字典、数组与流元数据。 |
| ![内容流：第 1 页解码后的操作符与操作数，包含 BT、Tf、Tj、Do](docs/images/raw-content-stream.png) | **内容流**<br>`Content stream` 标签页按页解码内容流，逐条列出 offset、操作符与操作数；`BT` / `Tf` / `Tj` / `Do` 等操作符只读取、不执行。 |
| ![1000 页页面列表与 Go to page：工具栏显示 1000 / 1000，左侧列表末尾为 Page 1000](docs/images/large-doc-pages.png) | **大文档页面列表与跳页**<br>打开 1000 页示例，左侧页面树使用 CSS 窗口化；Go to page 把输入夹到 `1..pageCount`，只展开当前页对象。 |
| ![大文档搜索：SearchBox 显示 Indexing 100/1000…，页面与页面列表仍可用](docs/images/large-doc-search.png) | **分批搜索索引**<br>搜索按 10 页一批建立文本索引，SearchBox 显示 `Indexing done/total…`；关闭搜索或切换文档会取消构建。 |
| ![搜索 2.0：查询 PDF 显示 1/7，结果面板列出 7 条命中与 p.N 上下文预览](docs/images/search-results.png) | **搜索 2.0 结果列表**<br>`Ctrl/Cmd+F` 打开当前文档搜索，`Aa` / `W` / `.*` 切换大小写、整词与正则；结果面板按页列出 `p.N` 与上下文，点击或键盘选择跳转；最多 5,000 条并显示截断提示。 |
| ![命令面板：Ctrl/Cmd+K 打开，过滤 page 后显示 Navigate 分组的 Go to page…](docs/images/command-palette.png) | **命令面板**<br>`Ctrl/Cmd+K` 打开，按 File / Navigate / View / Analyze / Export 分组过滤并执行已注册命令；无文档时依赖文档的命令禁用，Go to page 子视图把页码夹到 `1..pageCount`。 |
| ![桌面文档标签栏：两个通过 URL 打开的文档标签，切换到 basic.pdf 后工具栏显示 1 / 4](docs/images/large-doc-tabs.png) | **桌面文档标签**<br>桌面端可同时保留多个文档标签，切换时恢复页码、缩放、叠加层与面板标签；Web 端通过服务端 `documentId` 激活标签。 |
| ![Web 文档标签栏：basic.pdf 与 large.pdf 两个标签，当前 large.pdf 显示 1 / 120](docs/images/web-tabs.png) | **Web 文档标签**<br>Web 与桌面端都显示文档标签栏；切换按 `documentId` 激活并恢复视图快照，未激活文档的 `/doc/:id` 仍可读取，关闭标签只删除该文档的临时副本。 |
| ![最近文档对话框：按类型分组的 Web 文档行、Open/Remove 按钮、恢复上次会话开关、清空最近记录与关闭](docs/images/session-recent.png) | **会话恢复与最近文件**<br>空状态可重新打开最近文档或恢复上次会话，`File: Recent documents…` 按本地/URL/Web 分组列出最近文档。只把定位信息与视图快照存入 `pdf-inspector:session:v1` / `pdf-inspector:recent:v1`，不保存 PDF 内容与分析结果。 |

*截图来自 Web 构建与真实 Electron 桌面构建；页面列表/搜索 2.0/命令面板、注释整档索引/导出、主题、导出对话框、中文界面、Diff/Audit/Raw、Audit Resources、Audit Structure 与会话恢复/最近文档为 1440×900，桌面标签为 Electron + xvfb 实测（CDP 1440×900 视口）。详见 [docs/export.md](docs/export.md)、[docs/themes-i18n.md](docs/themes-i18n.md)、[docs/search.md](docs/search.md)、[docs/large-docs.md](docs/large-docs.md)、[docs/annotations.md](docs/annotations.md) 与 [docs/session.md](docs/session.md)。*

## 功能特性

### 渲染与检查

- PDF.js 多页渲染，支持翻页、缩放与适合页面宽度。
- char / word / line / curve / rect / table / image 七类对象的边界框叠加层，可在 Layers 标签页统一控制可见类型与透明度。
- 悬停或点击选中对象，Inspector 的 `Inspect` 标签页展示页码、坐标、字体、字号、颜色及原始 JSON；图片对象提供内嵌预览。
- 文本选择层支持直接选中页面文字。

### 导航与结构

- 左侧面板包含五个标签页：`Objects`（按页展示全部对象）、`Outline`（PDF 书签）、`Fonts`（字体统计）、`Layers`（叠加层控制）与 `Annots`（当前页或整档的注释、链接与表单字段）。
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

- 工具栏提供原生 `Theme` 下拉框，包含 `Dark`、`Islands`、`Light` 与 `System` 四个选项；下拉框显示的是用户偏好，实际配色单独写入 `data-theme`。
- `Dark` 是默认主题，保持原有的紧凑、无缝面板外观；`Islands` 使用近黑色渐变画布，把工具栏、文档标签栏、左右面板、画布、Inspector、Diff / Audit / Raw 工作区与状态栏都变成带 1px 边框、圆角与柔和阴影的浮动卡片；`Light` 使用白色面板、浅灰表面与蓝色强调色，适合明亮环境。
- `System` 是模式而不是配色：跟随 `prefers-color-scheme` 解析为 `Dark` 或 `Light`，系统外观变化时实时更新。`data-theme-mode="system"` 保留用户选择，`data-theme="dark|light|islands"` 驱动 CSS token。
- 主题只改变外观：面板宽度、分隔条拖拽、Focus 模式与 1280 / 1440 / 1600 下的布局尺寸保持不变，不会产生横向溢出。
- 主题持久化在 localStorage 的 `pdf-inspector:theme:v1`，首帧前应用；旧的 `dark` / `islands` 值仍然有效。存储不可用（隐私模式、jsdom 等）时回退到 `Dark`，不影响使用。
- 结构色集中在 `src/renderer/theme.css` 的 CSS 变量中；PDF 页面白底、PDF 对象类型色、注释类型色与页面框颜色不随主题变化。

### 语言与 i18n

- 工具栏语言按钮显示 `EN` 或 `中文`。默认英文，且不会根据浏览器语言自动切换，保证首次运行与截图稳定。
- 语言偏好持久化在 `pdf-inspector:locale:v1`，同步到 `<html lang="en|zh-CN">` 与 `data-locale`，首帧前恢复；刷新后保持所选语言。
- `Ctrl/Cmd+K` 命令面板还提供 `Language: English` 与 `Language: 简体中文`，以及四个主题命令。工具栏、文档标签、面板标签、状态栏、对话框、各工作区、空状态与命令面板文案都会翻译。
- 有意保持英文：命令标识与 API 名称、JSON/CSV schema 字段与 PDF 对象标识、原始 PDF 语法、sidecar/CLI 错误文本，以及生成 HTML 报告的正文。这些属于数据或协议边界，不是 UI 文案。架构与新增 key/主题的方法见 [docs/themes-i18n.md](docs/themes-i18n.md)。

### 搜索与导出

- `Ctrl/Cmd+F` 打开当前文档的全文搜索；`Aa`（大小写）、`W`（整词）、`.*`（正则）三个选项即时重算，结果面板按页列出命中与上下文预览，点击或键盘选择后跳转并高亮。
- 搜索输入有 300ms 防抖，文本索引按 10 页一批建立并缓存；切换选项复用缓存，不重建索引。匹配不跨页拼接，非法正则显示内联错误，零长度匹配被跳过。
- 结果最多保留 5,000 条命中并显示 `Showing first 5,000 matches`；模式长度上限为 500 字符。`Enter` / `Shift+Enter` 在搜索框内跳到下一处/上一处，`Escape` 先关闭结果面板再关闭搜索。
- 导出当前页或整份文档，格式为 JSON 或 CSV；导出时可勾选要包含的元素类型（char / word / line / curve / rect / table / image）。桌面端使用原生保存对话框，Web 端触发浏览器下载。
- CSV 按对象类型分段，便于在表格工具中继续分析。
- JSON 导出新增可选字段：`metadata.fontInfo`（字体嵌入详情）、每页的 `page.boxes` / `page.rotation`、表格的 `table.cellBoxes` / `table.cellSpans`，以及图片的 `content_hash`（可读取时的 SHA-256）；CSV 各段的列定义保持不变。
- 注释、链接与表单有独立的整档导出：在 `Annots → Whole document` 中点 `Export` 选择 JSON/CSV，不改变上面的对象导出 schema。

### 导出视图（PNG/SVG）

- 工具栏的 `视图…` 按钮打开对话框，可导出当前页或当前选中区域。按钮只显示短标签以避免工具栏换行；可访问名称、tooltip 与命令面板条目仍是完整的 `Export view…` / `导出视图…`。只有拖出区域后 `Selected region` 才可用。
- 可选 PNG 或 SVG、`1x` / `2x` / `3x`，以及 `Objects` / `Annotations` / `Page boxes` 任意组合的叠加层。对象类型选择器复用 Layers 的七种类型，并提供 Select all / Clear。
- 默认文件名为 `<文档>-p<N>.png|.svg`（区域导出带 `-region`），可编辑。桌面端使用原生保存对话框，Web 端触发浏览器下载。
- PNG 以二进制保存：渲染层在离屏 canvas 截图，以 base64 通过保存通道传递，桌面/浏览器适配器再解码为字节。SVG 是自包含文档，以 PNG 作为 `<image>` 栅格底图并叠加矢量框，不是把 PDF 内容重新矢量化的 SVG。
- 截图独立于当前缩放；缩放会夹取到最长边 8192 px、总像素 32 MP。空区域回退整页并给出警告；旋转页不绘制对象/注释框，而是返回限制提示，避免错位。

### 分享报告（HTML）

- 工具栏的 `报告…` 按钮（命令面板：`Share report…` / `分享报告…`）为当前页生成单个自包含 HTML 文件。与 `视图…` 一样，只有可见的工具栏标签缩短，可访问名称与 tooltip 仍是完整名称。文件名默认 `<文档>-report.html`，可编辑。
- 报告包含：文档摘要、页面截图、页面组成（对象计数与页面框）、字体分析（可用时）、当前页注释以及属于当前文档的整档注释索引/链接与表单问题、属于当前文件的审计发现；缺失的分析会降级为说明文字。
- 适合作为邮件或工单附件：内联 CSS、一张 `data:image/png;base64` 截图、无 `<script>`、无外部字体/图片/链接、限制性 CSP，并对文档与注释文本做 HTML 转义。
- 限制：仅当前页；截图最长边目标 2400 px（截图缩放 1–2）；报告上限 20 MB。对话框会随 UI 语言切换，但报告小节标题与正文为英文。

### 命令面板

- `Ctrl/Cmd+K` 打开命令面板，按 `File` / `Navigate` / `View` / `Analyze` / `Export` 分组显示已注册命令；打开时自动聚焦过滤框，输入标题或关键词（例如 `page`）即可过滤，`↑/↓` 移动、`Enter` 执行、`Escape` 关闭。
- 命令覆盖 Open PDF、Open URL、Search document、Go to page、四个主题与 Cycle theme、Language: English / 简体中文、Focus mode、左右面板、Layers、Diff、Audit、Raw、Export objects、Export view、Share report、Clear selection 与 Close palette；`Go to page…` 会进入页码子视图，输入值夹取到 `1..pageCount`。
- 命令由实际持有 handler 的组件按 owner 注册，面板只调用现有 handler/store，不复制 IPC 或文件打开/导出逻辑；无文档或当前工作区不允许时，依赖文档的命令显示为禁用。
- 命令注册是显式的，不提供用户自定义命令、插件系统或快捷键编辑器；`Ctrl/Cmd+F` 仍直接打开搜索，`Ctrl/Cmd+K` 只负责命令面板。

### 大文档与多文档

- **双通道 sidecar**：交互通道负责 `open` / `extract_page` / `extract_metadata` / `get_image_data`，后台通道负责 `analyze_fonts` / `audit_*` / `raw_*` / `diff_documents`；路由表由 `laneForMethod()` 统一，桌面端与 Web 端共用。翻页不会被正在运行的字体、审计、Raw 或 Diff 请求挡住。
- **后台通道懒启动**：只有第一次请求字体/审计/Raw/Diff 时才创建第二个 Python 进程；两个通道打开同一份文档，切换文档时后台通道异步重新打开，失败只影响后台功能。因此正常查看始终只有一个进程，最多两个。
- **搜索分批与进度**：搜索按 10 页一批建立当前文档的文本索引，SearchBox 显示 `Indexing 40/1000…`；清空查询、关闭搜索、切换文档或离开 Inspect 会取消构建，过期构建不会写回结果。索引只保存文本，不保留 PDF.js 页面对象。
- **页面列表窗口化与跳页**：1000 页的 `Objects` 列表使用 CSS `content-visibility` 窗口化，只绘制视口附近的行；只有当前页展开对象组。顶部 Go to page 输入 `1..pageCount`，越界会夹取，非法输入被忽略，并复用与 Prev/Next 相同的受保护导航。
- **对象上限**：当前页 Words 最多显示 50 条，其他对象组最多 200 条，超出显示 `Showing first N of M …`；选中对象仍映射回完整对象。
- **桌面文档标签**：打开多个本地文件或 URL 文档后，工作区顶部出现标签栏；相同路径/URL 再次打开会聚焦已有标签。切换标签会保存旧标签的页码、缩放、叠加层、左右面板标签与查询字符串，重新打开目标文档后恢复；字体、审计、Raw 结果不进入快照，切回后重新运行。关闭活动标签激活邻居，关闭最后一个回到空状态。
- **桌面 URL 标签**：桌面端 URL 文档下载到临时副本，临时文件归“当前文档”所有；切换到其他文档会删除上一个副本，因此重新激活桌面 URL 标签会重新下载，但保留同一个 `sourceUrl` 和标签身份。Web 端的 URL 副本由注册表保留，见下条。
- **Web 文档标签**：Web 与桌面端都显示文档标签栏。Web 文档由服务端按 `documentId` 登记，只有活动文档在 sidecar 中打开（交互/后台两个通道打开同一份）；切换标签调用激活接口，在同一 sidecar 中重新打开目标文件，并恢复该标签的页码、缩放、叠加层、面板标签与查询字符串。注册表最多 8 份文档 / 总 512 MiB，超出时淘汰最久未激活的非活动文档。关闭标签只删除该文档的临时副本，关闭最后一个标签才清空活动文档；同一 `sourceUrl` 再次打开会去重并复用已保留的下载副本。标签集合与每个标签的视图快照会保存在本机，并在下次启动时恢复（见“会话恢复与最近文档”），不改变 Web 端原有的认证边界（Web 端本来就没有认证）。
- **清理与限制**：桌面与 Web 标签都只保存视图快照，不保留 N 份 PDF.js 文档或分析缓存；Web 端不做每文档 sidecar，切换是串行的 sidecar 重新打开；后台通道在本阶段不做空闲自动退出；异常退出后临时文件清理是尽力而为。完整路由表、快照语义、Web 多文档 API 与验证记录见 [docs/large-docs.md](docs/large-docs.md)。

### 会话恢复与最近文档

- **空状态**：未打开文档时，画布提供 `Open PDF…`、`Open URL…`、`Recent documents…`、`Restore last session`（有可恢复会话时可用）、最近 5 条文档快捷按钮与一行隐私说明；有文档打开时不渲染。
- **保存内容**：`localStorage` 中两个记录——`pdf-inspector:session:v1`（标签、活动索引、保存时间、恢复开关）与 `pdf-inspector:recent:v1`（最近列表）。每个标签只保存定位信息（本地路径 / 源 URL / Web `documentId`）与视图快照；最近列表保存显示名、类型、定位信息与最近打开时间。PDF 字节、页面对象、字体/审计/Raw/Diff 结果、搜索索引与当前选中对象都不会写入。上限为 20 个标签与 20 条最近项；相同文档按路径/URL/登记 id 去重，超长字符串截断，损坏或不可用的存储在内存中降级运行，不影响启动。
- **恢复规则**：桌面端用 `openPdfPath` 重新打开本地路径，用 `openPdfUrl` 重新下载 URL 文档；Web 端用 `activatePdfDocument` 激活服务端登记的 `documentId`，服务端已忘记该 id 时，URL 文档按 `sourceUrl` 重新下载，上传文档则跳过。标签按顺序串行打开，最后重新激活上次的活动标签，单个失败不影响其余标签；状态栏先显示 `Restoring n/m documents…`，结束后显示可关闭的 `N documents could not be restored` 提示（只有数量，不含路径）。
- **自动与手动恢复**：启动时默认自动恢复，可在最近文档对话框中关闭 `Restore last session`；关闭只跳过自动打开，最近列表仍保留。空状态按钮与命令面板的 `File: Restore last session` 属于显式请求，即使开关关闭也会立即恢复（仍要求当前没有打开文档）。关闭最后一个标签会写入空会话，下次不会恢复已关闭的文档。
- **最近文档对话框**：按 `Local files` / `URL documents` / `Web documents` 分组（上传归入 Web 组），每行显示名称、路径/URL、类型、最近打开时间、`Open` 与 `Remove`。打开使用与恢复相同的 opener，并落到默认视图（第 1 页、100%）；失败只在对应行提示。上次 Web 会话的上传已不在服务端时，会明确提示该上传已不可用、需要重新上传。底部提供恢复开关、两步确认的 `Clear recent` 与 `Close`。
- **命令**：`Ctrl/Cmd+K` 的 `File: Recent documents…`、`File: Restore last session`、`File: Clear recent documents` 提供相同入口。
- **隐私**：本地路径只留在本机浏览器/Electron 的 `localStorage`；Web 服务端不会收到本地路径、文件内容或上传文件的最近记录（上传的最近项只保留显示名与登记 id）。恢复失败提示不含路径。详见 [docs/session.md](docs/session.md)。

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

- **两种范围**：`Annots` 顶部在 `Current page` 与 `Whole document` 之间切换。默认 `Current page`，保留原有的页级列表、画布框与 Inspector 行为；`Whole document` 列出整份文档的全部注释、链接与表单字段。
- **整档索引**：首次切到 `Whole document` 时由渲染层用 PDF.js 读取注释，按 10 页一批、批间让出事件循环，面板显示 `Indexing annotations 40/120…` 与进度条；索引期间翻页、缩放与当前页 Inspect 仍可用。切回 `Current page` 不会取消或丢弃已完成的索引，再切回直接复用。
- **汇总、搜索与过滤**：文档模式汇总为 `7 annotations · 1 page · 2 links · 3 form fields`；搜索覆盖页码、subtype/kind、标题与内容、链接目标、字段名/类型/值/选项，Kind 与 Subtype 过滤是全局的，可与搜索叠加。
- **定位与选中**：点击文档模式的行会跳到该注释所在页，并请求选中该注释；目标页加载完成后按注释 id 选中并切到 Inspector。id 不存在（或与当前页数据不一致）时只跳页，不强行选中。
- **链接健康**：`unresolved`（既无安全外部 URL、也无解析出的内部页码）与 `unsafe`（`mailto:` / `file:` / `data:` / `javascript:` 等非 `http(s)` 目标）计入 `Issues`；可打开的 `http(s)` 目标列在默认折叠的 `External links` 清单里，只作为信息，不算错误，也不会被自动打开或探测。
- **表单健康**：无名 Widget 与同名字段类型冲突计为 warning；同名字段出现在多个页面是 PDF 表单的常见用法，作为 info 展示，不默认判错。每条链接/表单问题都带页码，可 `Go to page` 跳转。
- **导出**：索引完成后 `Export` 打开对话框，可选 JSON/CSV 并修改文件名。JSON 含 `schemaVersion`、文档信息、summary、按页注释、链接/表单问题与合并后的表单字段；CSV 分 `# annotations` / `# links` / `# form_fields` 三段，带 BOM 与 RFC 4180 转义，不写入本地绝对路径。
- **画布框与选中**：注释按类型着色——链接蓝、表单紫、标记黄、注释橙、图章青、其他灰；悬停加亮，选中使用金色描边。点击注释框会选中该注释并切换到 Inspector，点击对象则清除注释选中，两者不会同时高亮。`Show boxes` 只作用于当前页。
- **Inspector 详情**：`Inspect` 显示 subtype / kind / 页码 / Rect、标题与内容、修改时间、颜色与不透明度；链接额外显示目标与 `Open link` / `Go to page N`，表单字段显示字段名、类型、值、默认值、Flags 与选项。
- **内部与外部链接**：外部链接只在用户显式点击 `Open link` 时打开，且仅允许 `http(s)`；PDF.js 的原始 `unsafeUrl` 只用于显示，不安全目标会禁用按钮并提示“仅支持 http(s)”。渲染层、桌面主进程与 Web 适配器都会再次校验 URL，打开失败不会影响文档状态。内部目标解析为页码后，使用与 Prev/Next 相同的翻页导航。
- **表单只读**：字段值、默认值、Flags 与选项全部以文本呈现，没有输入框、没有重置/提交按钮，也没有写回 PDF 的路径；签名字段只作为字段显示并标注未验证。
- **隐藏与弹出注释**：Popup 注释不单独列出（改为显示父注释的内容）；隐藏注释在列表中带 `Hidden` 标记，但默认不绘制画布框。
- **只读与数据来源**：当前页与整档索引都是纯读取功能，不修改 PDF，也不新增侧车注释 RPC；整档导出只序列化已建立的索引，不重新解析页面。索引批次、origin 缓存、JSON/CSV schema、健康检查语义与非目标详见 [docs/annotations.md](docs/annotations.md)。

### 原始 PDF 对象树与内容流

- **Raw 工作区**：工具栏 `Raw` 打开独立的只读工作区，与 Diff、Audit 互斥；Inspect 保持挂载但被隐藏，页码、缩放、选中与筛选状态不受影响，`Back to Inspect` 随时返回。Raw 不使用左侧第六个标签页，因此在 200px 最小面板宽度下左侧仍只有五个标签。
- **Trailer 根**：对象树从 trailer 的 `Root`（catalog）、`Info`、`Encrypt`、`ID` 以及 catalog 的 `Pages` 引用开始，只读取这些根，不做整图遍历。
- **懒加载引用**：`15 0 R` 这样的引用本身就是一个节点，展开或点击时才读取该对象；引用不会自动递归解析，循环引用不会展开成死循环，树上限 8 层并提示深度限制。
- **字典、数组与流**：右侧 `Object` 标签页显示对象摘要与值树，区分 null / 布尔 / 数字 / 字符串 / 名称 / 引用 / 数组 / 字典 / 流；字典与数组可展开，流只显示长度、过滤器、Subtype 与有界文本预览，二进制字节永不返回。
- **内容流操作符**：`Content stream` 标签页按页解码页面内容流，逐条列出序号、offset、操作符与操作数（`BT` / `Tf` / `Tj` / `Do` / `cm` 等）；操作数中的引用可点击跳转到对应对象，所有文本按普通文本渲染，操作符只读取、不执行。
- **上限与截断**：嵌套 4 层、每个容器 100 项、字符串与预览 4096 字符、每页 5000 个操作符、每页 20 条内容流；超限时标记 `truncated` 并在界面提示，而不是静默截断。
- **只读**：不能编辑对象、重写流、解密或执行内容流，也不提供 raw diff、导出或 CLI。序列化语义、上限与安全边界详见 [docs/raw.md](docs/raw.md)。

### PDF Diff

当前 Diff 把 2.0 的页面对齐与视觉审查流程、3.0 的长任务保护（页面签名、心跳/超时恢复、变更上限与可选的字符级比较）以及 3.0 的文档资源比较（注释、链接、表单、元数据、页面标签）合并在一起。对象级结果仍然是事实来源。

- **对象级变更**：对 word / char / rect / line / curve / image / table 七类对象逐页比较，报告 `added` / `removed` / `moved` / `modified`；每条变更包含旧/新页码、BBox、文本与细节（字体、字号、颜色、描边/填充、content hash、表格单元格等）。
- **文档资源变更**：侧车同时读取注释、链接、表单控件、Info 字典与 `/PageLabels`，把差异写进同一份结果。注释/链接/表单以 `annotation` / `link` / `form` 类型进入 `pages[].changes`（identity 依次取 `/NM`、链接目标、表单完整字段名 + widget rect）；元数据与页面标签只出现在 `documentChanges`，因此只有元数据变化时所有页仍是 `unchanged`。资源变更不计入对象计数，摘要新增 `resourcesAdded` / `resourcesRemoved` / `resourcesModified` / `resourcesMoved` 与 `documentChanges`。
- **页面级变更**：识别页面新增/删除、页面尺寸与 `/Rotate` 旋转角变化；这些变化以页面级说明展示，而不是对象框。
- **表格单元格**：表格按单元格文本比较，`details.cellChanges` 列出变化的行、列与旧/新文本，并报告行列数变化。
- **容差与忽略**：可调位置容差（pt，默认 1.0）与文本比较模式（`exact` / `normalized` / `case-insensitive`，默认 `normalized`），并可忽略字体、颜色、图片、指定对象类型或五类文档资源。对比对话框提供位置容差、忽略字体/颜色/图片，以及 `Content` 资源开关；文本容差与 `--ignore-types` 通过 CLI 使用。
- **对比工作区**：顶部摘要（页数、页面变更、各类对象计数、资源计数）加左侧按页变更列表，支持按 Kind / Type 过滤；中间为并排（Side by side）、叠加（Overlay）或视觉（Visual）视图，共享页码与缩放；右侧显示选中变更的新旧文本、Box 与字段差异。页组上方的 `Document changes` 折叠组列出元数据与页面标签变更，`Page label` 行可 `Go to page`。
- **按页折叠与跳页**：左侧每个页面是独立可折叠组，标题显示 `Old/New` 页码、状态与变更数；默认展开当前/首个变更页，`Go to page` 输入 `1..页数` 后跳转并自动展开，`Expand all` / `Collapse all` 批量控制。过滤不会合并不同页。
- **大文件快速路径**：未改动页需要页面签名与页面资源摘要都相同才直接判为 `unchanged`，不触发 pdfplumber 布局与对象抽取；只有资源不同时页面为 `changed`，但不抽取对象。长时间运行每 5 秒有心跳，修改页数很多时可显示 `Comparing documents… Ns`，并受 50k 变更上限保护。
- **叠加配色**：叠加模式以页面所属文档为底图（有旧页用旧页，新增页用新页），绘制旧/新对象框——移除红、新增绿、移动橙、修改蓝，便于在同一位置快速定位改动。
- **Export JSON**：把当前结果导出为 `DiffResult` JSON（`schemaVersion: 1`）。
- **不影响当前检查**：Diff 在独立的旧/新文档上运行，Inspect 中打开的文档、页码、缩放与选中状态保持不变；`Back to Inspect` 返回原文档。

#### PDF Diff 2.0

- **页面对齐与重排**：页面先按内容指纹（页面尺寸、旋转、文本哈希、对象计数、表格文本）配对，结果在每个 `DiffPage` 上新增 `match: { score, reordered }`，摘要新增 `pagesReordered`。`reordered` 表示配对页在修订版中换了页码（`oldIndex != newIndex`），不是对象顺序变化；插入/删除页保持单侧（`match: null`）。页面列表与页面栏显示 `Old 2 → New 1` 形式的新旧页码。
- **Visual 视觉差异**：`Visual` 视图以新页为底图、旧页半透明叠加（`Blend`），或逐像素比较并绘制热力图（`Heatmap`），也可不做像素叠加只看变更框（`Boxes`）；页面栏显示 `changed / total px (百分比)`。逐像素比较在浏览器 canvas 中完成，通道差阈值固定为 24，并按上限缩放位图；结果不写入 CLI/JSON。
- **忽略区域**：打开 `Ignore region` 后在并排/叠加页面拖动矩形，区域按页与 MediaBox 坐标记录（`DiffIgnoreRegion`：`oldPage` / `newPage` / `bbox`），虚线框与左侧区域列表同步显示；`Apply & re-run` 显式重新比较，与区域相交的变更从 JSON/UI/HTML 中消失，`Remove` 后重新运行即可恢复。区域只读，不修改 PDF。
- **忽略区域 CLI/Action**：`--ignore-regions PATH` 读取与 UI 相同的 camelCase JSON 数组；action 提供同名输入 `ignore-regions`。
- **重排阈值**：`--fail-on reordered` 在存在 `pagesReordered > 0` 时返回 1，适合把“页序变化”作为独立门禁；原有 `added` / `removed` / `modified` / `page-count` / `none` 语义不变。
- **生成示例**：`web-samples/diff-visual-old.pdf` / `diff-visual-new.pdf`（第 1 页文字、颜色与位置小幅变化）、`web-samples/diff-reordered-old.pdf` / `diff-reordered.pdf`（删除首页草稿、追加发布说明，4 个配对页换位）与 `web-samples/diff-resources-old.pdf` / `diff-resources-new.pdf`（页面完全相同、只有资源变化）。
- **详细说明**：页面对齐语义、视觉模式、区域 JSON、CLI/action 示例与阈值见 [docs/diff.md](docs/diff.md)。

#### 注释、链接、表单、元数据与页面标签

除了对象，Diff 还比较 Python 侧车收集的**文档资源**，因此 UI、CLI、JSON 与 HTML 结果一致，且不需要任何无头渲染：

- **比较什么**：注释（subtype、title、contents、color、opacity、flags、rect）、链接（URI 目标、内部页码、`unsafeUrl`、action、contents）、表单控件（字段类型、完整字段名、值、默认值、选项、flags）、Info 字典（title、author、subject、keywords、creator、producer、创建/修改时间、language）与 `/PageLabels`。
- **identity**：注释与链接优先用 `/NM`；没有时注释退回 subtype + rect + contents，链接退回 URI / 内部页码 / 目标文本 + rect，表单用 `/AcroForm` 补全的完整字段名（嵌套以点号连接）+ widget rect。identity 里含有 rect 的资源移动后会变成一条 removed + 一条 added，而不是 `moved`。
- **结果位置**：注释、链接与表单是页级变更，写在 `pages[].changes`，与对象变更结构相同；元数据与页面标签是文档级变更，只写在 `documentChanges`（页面标签的 `page` 为 1-based 页码）。资源不计入对象计数，`schemaVersion` 仍为 `1`：`documentChanges`、`resources*` 计数、`resourcesTruncated` 与五个 `ignore*` 选项都是加法可选字段。
- **过滤与徽标**：设置对话框的 `Content` 分组可开关注释 / 链接 / 表单 / 元数据 / 页面标签（默认全开）。Type 徽标与 Type 过滤新增 `Annotation` / `Link` / `Form` / `Metadata` / `Page label`；有 BBox 的资源画成虚线框，没有 BBox 的条目只在详情中出现。
- **忽略区域**：有 BBox 的注释、链接与表单和对象一样会被区域过滤；元数据与页面标签没有 BBox，不受区域影响。
- **只读**：不打开链接、不执行 Launch、不填写/重置/提交表单、不验证签名，也不写回 PDF。
- **样例文件**：`web-samples/diff-resources-old.pdf` / `diff-resources-new.pdf` 两页完全相同，只有资源不同（注释内容/颜色、链接目标 `…/v1` → `…/v2`、表单值 `Alice` → `Bob`、title/author、页面标签 `i` → `ii`），得到 0 个对象变更、3 个资源变更、3 条 `documentChanges`；可用 `python scripts/generate-diff-resource-samples.py` 重新生成。
- **详细说明**：identity 规则、资源上限、截断语义、忽略区域行为、JSON 结构与只读边界见 [docs/diff.md](docs/diff.md)。

```bash
# 只比较元数据与页面标签
python sidecar/cli.py diff old.pdf new.pdf \
  --ignore-annotations --ignore-links --ignore-forms

# 只比较注释、链接与表单
python sidecar/cli.py diff old.pdf new.pdf \
  --ignore-metadata --ignore-page-labels

# 资源修改也算内容变化：资源变化时返回 1
python sidecar/cli.py diff old.pdf new.pdf --fail-on modified \
  --format json --output diff.json
```

#### 对象级与视觉级的关系

- **对象仍是事实来源**：对象变更列表、对象过滤与 JSON/CLI/action 中的对象计数都基于提取出的对象及其元数据；文档资源变更并列报告，不会替换或放大这些数字。视觉视图只是额外的 UI 视图，不替代对象级结果，也不做 OCR。

### 文档体检

- **整档检查**：跨字体、页面、图片、元数据、结构与安全执行确定性检查，覆盖未嵌入字体、缺少 ToUnicode、混合页面尺寸、旋转页面、页面框越界、低分辨率图片、图片页无可提取文本、扫描页、空页面、缺失元数据、加密与未标记 PDF 等场景。
- **严重级别**：发现分为 `error` / `warning` / `info`，不提供“健康分”。页面提取失败是当前的 `error` 来源；未嵌入字体为 `warning`，Standard 14 字体不会被视为缺失。
- **分批进度**：文档级检查完成后按每 10 页一批顺序执行页面检查，并实时显示 `Auditing pages N/M…`；批次之间界面保持可用。
- **独立工作区**：工具栏 `Audit` 打开文档体检工作区（与 Diff 互斥），顶部显示文件与 `Run` / `Re-run`，左侧按严重级别汇总并可按严重级别/类别筛选，中间为发现列表，右侧显示选中发现的说明、证据与修复建议。
- **跳转到页面**：带页码的发现提供 `Open page`，点击后关闭 Audit 并在 Inspect 中导航到该页；Inspect 中打开的文档、页码、缩放与选中状态保持不变，`Back to Inspect` 可随时返回。
- **JSON 导出**：`Export JSON` 保存完整的 `AuditReport`（`schemaVersion: 1`），包含 tool、document、summary 与 findings；CLI `audit --format json` 输出同一 schema。
- **报告与集成**：CLI 支持 `summary` / `json` / `html` 三种格式，HTML 为单文件、内联 CSS、无脚本；`audit/action.yml` 可在 CI 中运行审计并按 `fail-on` 决定步骤成败。详见 [docs/audit.md](docs/audit.md)。
- **启发式检查**：审计基于提取出的对象、字体信息、页面框与 catalog 元数据，不做 PDF/A 认证或签名验证，也不做 OCR；旋转页或 CropBox 偏移页上的发现只到页面级。

### 文档安全与附件

- **Audit 的 `Resources` 视图**：Audit 工作区用分段控件在 `Findings` 与 `Resources` 之间切换。`Audit → Resources` 顶部显示附件、JavaScript、动作、签名、加密与 XFA 汇总卡，下方依次是附件表（名称、描述、大小、MIME、修改时间、SHA-256、风险）、只读 JavaScript 预览、动作与签名表，以及带 `Allowed` / `Denied` / `Unknown` 徽标的加密与权限。`Refresh` 重新读取文档，`Export security JSON` 保存完整 `SecurityReport`（建议文件名 `<pdf 文件名>.security.json`），`View in Findings` 切回 `Findings` 并把类别筛选设为 `security`。报告按文件缓存；切换文件或 Audit `Re-run` 会清空缓存。
- **只读资源清单**：内嵌附件（仅元数据）、JavaScript 有界预览、Launch/URI/SubmitForm/ImportData 动作、XFA、签名字段与加密/权限；不执行脚本、不跟随动作、不打开或下载附件、不解密流、不验证签名。附件不能打开或下载，也不会导出附件字节。
- **发现与严重级别**：同一份清单也以 `security` 类别并入文档体检。JavaScript（尤其是 OpenAction/`/AA`）、Launch/SubmitForm/ImportData、XFA、加密与风险附件名属于 warning；内嵌文件与签名字段属于 info。签名字段只报告“存在”（`verified: false`），且从不做密码学验证。
- **引擎与 CLI**：同一引擎支撑 `pdf-inspector security` 的摘要、确定性 JSON 与单文件 HTML。详见 [docs/security.md](docs/security.md) 和下方[安全 CLI](#安全-cli)。
- **有界且启发式**：名称树、动作、脚本预览与附件哈希都有上限；畸形对象降级为 `null` 或直接跳过，不会让整份报告失败。

### 无障碍与结构树

- **Audit 的 `Structure` 视图**：Audit 顶部用分段控件在 `Findings` / `Structure` / `Resources` 之间切换。`Structure` 读取标记结构树，顶部显示 Elements、Figures、Tables、Lists、Headings、Findings 汇总卡与文档事实（Tagged、StructTreeRoot、ParentTree、Language、Title）。树默认展开根与第一层，提供 `Expand all` / `Collapse all`、`Issues only`，以及按角色、原始角色、标题、Alt 与 ActualText 搜索；选中节点后显示角色、Alt/ActualText/Lang、页码、MCID 或对象号、有界属性与该节点的问题，`Open page` 在 Inspect 中打开该页，`View in Findings` 切回 `Findings` 并把类别筛选设为 `structure`。报告按文件缓存；`Refresh` 重新解析，`Export accessibility JSON` 保存完整 `AccessibilityReport`（建议文件名 `<pdf 文件名>.accessibility.json`）；切换文件或 Audit `Re-run` 会清空缓存。
- **读取范围**：catalog 的 `/StructTreeRoot`、`/MarkInfo`、`/Lang`、`/RoleMap`、`/ParentTree`，页面 `/StructParents`，以及 `/K` 中的嵌套 `StructElem`、`MCID`、`/MCR` 与 `/OBJR`。角色、阅读顺序（按 `/K` 顺序深度优先）、页码、MCID、对象号与有界属性全部来自结构树；不读取页面内容流、不提取文本、不计算 bbox。
- **启发式发现**：同一份结构并入 `structure` 类别，覆盖未标记 PDF、缺少 `/ParentTree`、页面缺少 `/StructParents`、角色缺失/未知/循环、`Figure`/`Formula` 缺少 Alt、`Link` 缺少描述、标题层级跳跃、`L` 无 `LI`、`LI` 无 `LBody`、`Table` 无 `TR`、`TH` 无 `Scope`，以及截断或跳过的解析。这些是启发式提示，不是 PDF/UA 或 WCAG 合规结论；视图只提供页级定位，不会在页面上高亮元素。
- **CLI**：`pdf-inspector accessibility` 输出人类可读摘要、确定性 `AccessibilityReport` JSON 或单文件 HTML：

  ```bash
  pdf-inspector accessibility report.pdf
  pdf-inspector accessibility report.pdf --format json --output report.accessibility.json
  pdf-inspector accessibility report.pdf --format html --output report.accessibility.html
  pdf-inspector accessibility report.pdf --fail-on warning
  ```

  `--format summary|json|html`（默认 `summary`）、`--output PATH`、`--fail-on error|warning|none`（默认 `none`）与 `--quiet`；退出码 `0`（没有命中阈值）、`1`（`--fail-on` 命中）、`2`（参数、输入、读取或报告错误）。详见 [docs/accessibility.md](docs/accessibility.md)。
- **样例**：仓库提交了 `web-samples/accessibility-valid.pdf`（Document → H1 → P → 带 Alt 的 Figure → 带 TR 与表头 Scope 的 Table）与 `web-samples/accessibility-broken.pdf`（Figure 无 Alt、H1 → H3、List 无 `LI`、Table 无 `TR`、缺少 ParentTree），可用 `python scripts/generate-accessibility-samples.py` 重新生成。CI 的 `accessibility-cli` 任务会重新生成两份样例、检查 JSON/HTML 输出，并断言 `--fail-on warning` 返回 1。
- **只读**：不编辑、创建或删除 tag，不执行内容流，不做 OCR，也不宣称 PDF/UA 或 PDF/A 合规。

### 打开方式

- 打开本地 PDF，或通过 `http(s)` URL 打开远程文档（先下载到临时目录再解析）。
- 桌面端与 Web 端能力一致，仅底层通道不同。

### 桌面与 Web

- **桌面端**：Electron 主进程负责窗口、原生菜单/对话框与 Python 侧车生命周期。
- **Web 端**：React UI 在浏览器中运行，由无 Electron 依赖的 Node HTTP 后端提供同样的文档与侧车能力。
- **多文档**：桌面端与 Web 端都支持文档标签页。桌面标签按本地路径或 URL 重新打开文档；Web 标签按服务端 `documentId` 激活已登记文档。两者都只保存视图快照，不保留第二份 PDF.js 文档或分析缓存。标签集合与每个标签的视图快照会保存在本机并在下次启动时恢复（见“会话恢复与最近文档”）。

### 键盘快捷键

| 快捷键 | 作用 |
|--------|------|
| `T` | 切换文本选择模式 |
| `R` | 切换区域框选模式（与文本选择互斥） |
| `F` | 切换 Focus 模式（隐藏左右面板） |
| `Ctrl/Cmd+F` | 打开并聚焦当前文档搜索 |
| `Enter` / `Shift+Enter` | 搜索框内跳到下一处 / 上一处命中 |
| `↑` / `↓` | 搜索结果面板或命令面板中移动当前项 |
| `Ctrl/Cmd+K` | 打开命令面板；已打开时聚焦过滤框或返回命令列表 |
| `Ctrl/Cmd+滚轮` | 缩放文档；向上滚放大，向下滚缩小（触控板捏合同样生效） |
| `Esc` | 关闭结果面板或命令面板；在搜索框内再按关闭搜索；没有浮层时清除选中、筛选与框选结果 |

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
| `web-samples/diff-resources-old.pdf` → `web-samples/diff-resources-new.pdf` | 两页完全相同，只有注释、链接目标、表单值、元数据与页面标签不同：0 个对象变更、3 个资源变更、3 条 `documentChanges`；可用 `python scripts/generate-diff-resource-samples.py` 重新生成。 |

> **安全提示**：Web 服务没有身份认证，任何能访问该端口的人都可以上传/下载文档、调用解析接口。默认绑定 `0.0.0.0`，请仅在可信网络使用；本机使用时建议 `HOST=127.0.0.1 npm run web`。

## 使用说明

1. **打开文档**：点击 Open 选择本地 PDF，或点击 Open URL 输入 `http(s)` 地址。
2. **浏览结构**：在左侧 `Objects` 标签页展开/折叠页面节点，或切换到 `Outline` 按书签跳转；也可用工具栏的 Prev/Next 翻页。
3. **检查对象**：在画布上悬停查看轮廓，点击后在右侧 Inspector 的 `Inspect` 标签页查看坐标、字体、颜色与原始数据。选中表格时会显示单元格网格，可悬停预览、点击选中单元格并查看其 Span 与 BBox。
4. **筛选对象**：在 Inspector → `Filter` 中按字体/字号/颜色/类型筛选，或切到 `R` 模式拖拽框选区域，再在 `Results` 中选择相交/包含匹配。
5. **字体分析**：切换到左侧 `Fonts` 标签页开始分析，查看进度与嵌入状态徽标；展开条目可看 Encoding、ToUnicode 等细节，点击字体条目跳转到使用页并高亮。
6. **查看页面几何**：在 Inspector → `Page` 标签页查看页面尺寸、旋转角与五个页面框，切换 pt/mm，并按需开关各框叠加与画布标尺。
7. **控制叠加层**：在左侧 `Layers` 标签页开关七类对象、查看当前页计数、使用 Solo 或调整透明度；`F` 可进入专注模式，隐藏左右面板。
8. **搜索与导出**：`Ctrl/Cmd+F` 打开搜索，输入查询后可用 `Aa` / `W` / `.*` 切换大小写、整词与正则，在结果面板中按页查看 `p.N` 与上下文并点击跳转；`Ctrl/Cmd+K` 打开命令面板执行打开、跳页、主题、语言、面板、Diff/Audit/Raw 等命令。`Export` 导出当前页/整档 JSON/CSV；工具栏的 `视图…`（命令面板中的 `Export view…`）把当前页或选中区域导出为 PNG/SVG；`报告…`（命令面板中的 `Share report…`）生成自包含 HTML 检查报告。
9. **比较版本**：点击工具栏 `Diff` 选择 Old/New 两份 PDF，按需设置位置容差、忽略项与 `Content` 资源开关后 Compare；在左侧变更列表（含 `Document changes` 行）选择条目查看详情，或在 Side by side / Overlay / Visual 间切换（Visual 可切 Blend/Heatmap/Boxes 并查看像素统计），`Ignore region` 可拖框屏蔽区域后再 `Apply & re-run`；`Export JSON` 保存结果。
10. **文档体检**：点击工具栏 `Audit` 对当前文档执行整档审计，查看严重级别汇总，按严重级别/类别筛选，选中发现查看证据与建议；需要时点击 `Open page` 跳转到对应页面，或用 `Export JSON` 保存完整报告。切换到 `Resources` 可查看附件、JavaScript、动作、签名、加密与权限；`Refresh` 重新读取，`Export security JSON` 保存完整 `SecurityReport`，`View in Findings` 切回并自动套用 `security` 类别筛选。
11. **查看无障碍与结构树**：在 Audit 中切换到 `Structure` 读取标记结构树与文档事实。使用 `Expand all` / `Collapse all`、`Issues only`，或按角色/Alt 文本搜索；选中节点查看角色、Alt/ActualText、页码与 MCID 详情，再用 `Open page` 跳转到该页，或 `View in Findings` 查看 `structure` 类别的问题。`Refresh` 重新解析，`Export accessibility JSON` 保存完整报告。
12. **检查注释、链接与表单**：切换到左侧 `Annots`，默认 `Current page` 查看当前页；切到 `Whole document` 建立整档索引（显示 `Indexing annotations N/M…`），用搜索与全局 Kind/Subtype 过滤定位条目，点击行跳页并尽力选中。`Issues` 区汇总断链与表单问题，`External links` 列出可打开的 `http(s)` 目标；`Export` 可把整档索引导出为 JSON/CSV。外部链接需点击 `Open link` 才会打开，内部链接使用 `Go to page N` 跳转；表单字段不能编辑或提交。
13. **查看原始对象与内容流**：点击工具栏 `Raw` 打开只读工作区，在左侧对象树展开 `Catalog` → `Pages` → 页面 → `Resources`，点击引用在右侧查看对象值；切换到 `Content stream` 按页查看解码后的操作符与操作数。`Back to Inspect` 返回原文档，页码与缩放保持不变。
14. **处理大文档与多文档**：打开 `/samples/huge.pdf` 后，用左侧 Go to page 输入页码（越界会夹取），页面列表只展开当前页；`Ctrl/Cmd+F` 搜索时 SearchBox 显示 `Indexing N/1000…`，可关闭搜索取消。桌面端与 Web 端都可再打开其他文件或用 Open URL 打开远程文档，通过顶部标签切换；Web 标签按服务端 `documentId` 激活并恢复视图快照，关闭标签只删除该文档的临时副本。
15. **回到之前打开的文档**：未打开文档时，空状态列出最近 5 条文档并提供 `Recent documents…`（打开分组对话框：`Open` / `Remove`、两步确认的 `Clear recent`、以及自动恢复开关 `Restore last session`）与 `Restore last session`（即使自动恢复已关闭也会立即恢复上次会话）。`Ctrl/Cmd+K` 的 `File: Recent documents…`、`File: Restore last session`、`File: Clear recent documents` 提供相同入口。最近文件与视图快照只保存在本机 `localStorage`，不会保存 PDF 内容或分析结果。详见 [docs/session.md](docs/session.md)。

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

# 只比较元数据与页面标签，或只比较注释/链接/表单
python sidecar/cli.py diff old.pdf new.pdf --ignore-annotations --ignore-links --ignore-forms
python sidecar/cli.py diff old.pdf new.pdf --ignore-metadata --ignore-page-labels

# 资源样例：0 个对象变更、3 个资源变更、3 条 documentChanges
python sidecar/cli.py diff web-samples/diff-resources-old.pdf web-samples/diff-resources-new.pdf
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
| `--ignore-annotations` / `--ignore-links` / `--ignore-forms` | 跳过注释、链接或表单控件差异 |
| `--ignore-metadata` / `--ignore-page-labels` | 跳过元数据或 `/PageLabels` 差异 |
| `--ignore-regions PATH` | JSON 数组，按页与 MediaBox 坐标屏蔽相交的变更（与 UI 的 `DiffIgnoreRegion` 相同） |
| `--quiet` | 不打印人类摘要，只保留 JSON/HTML 输出 |

退出码：`0` 表示无差异，或差异均被 `--fail-on`/忽略选项排除；`1` 表示 `--fail-on` 条件命中；`2` 表示参数、输入、解析或输出错误。`--fail-on none` 永不返回 1，但输入错误仍返回 2。`added` / `removed` 同时覆盖对象、资源与页面，`modified` 覆盖 modified、moved 的对象与资源、任意元数据/页面标签变化以及页面尺寸/旋转变化，`page-count` 覆盖页面增删、页数与页面几何变化，`reordered` 覆盖配对页换了页码（`pagesReordered > 0`）。`page-count` 与 `reordered` 不考虑资源变化。

`--format json` 输出独立的 `DiffResult`（`schemaVersion: 1`），与检查器的对象导出 JSON 不是同一 schema；它包含 `tool` / `options` / `old` / `new` / `summary` / `pages`，元数据或页面标签变化时还包含 `documentChanges`；每个页级变更带 kind、type（对象或资源）、旧/新页码与 BBox、文本与 `details`。输出不含时间戳与绝对路径、顺序稳定，相同输入与选项产生逐字节一致的 JSON，便于提交、diff 或缓存。

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

### 安全 CLI

`security` 对一份本地 PDF 做文档级安全资源检查，复用产生审计 `security` 发现的同一引擎。它不执行 JavaScript、不跟随动作、不打开附件，也不验证签名。

```bash
# 直接使用 Python CLI；需要 Python 3.10+ 与 sidecar/requirements.txt
python sidecar/cli.py security report.pdf
python sidecar/cli.py security report.pdf --format json --output report.security.json
python sidecar/cli.py security report.pdf --format html --output report.security.html

# 发现 warning/error 时返回 1，适合作为分发前门禁
python sidecar/cli.py security report.pdf --fail-on warning

# 通过 bin/pdf-inspector.mjs 包装器（安装/链接后可直接调用 pdf-inspector）
pdf-inspector security report.pdf
node bin/pdf-inspector.mjs security report.pdf --format json --output report.security.json
```

选项与 `audit` 相同：`--format summary|json|html`（默认 `summary`）、`--output PATH`、`--fail-on error|warning|none`（默认 `none`，`warning` 同时覆盖 errors）、`--quiet`。退出码：`0` 表示没有严重级别命中阈值，`1` 表示命中，`2` 表示参数、输入、读取或报告错误。`http(s)` URL、目录与非 PDF 输入会在引擎运行前以退出码 2 拒绝；`--output` 不允许覆盖输入 PDF。

`--format json` 输出 `SecurityReport`（`schemaVersion: 1`），包含 `tool` / `document` / `attachments` / `javascript` / `actions` / `signatures` / `encryption` / `findings` / `summary`。JSON 不含时间戳与绝对路径，相同 PDF 产生逐字节一致的输出。HTML 为单文件、内联 CSS、无脚本、无外部资源，所有 PDF 文本均转义。摘要包含文档事实、资源计数、严重级别计数，以及最多 20 条按严重级别优先排序的发现。

仓库提交了一份确定性样例 `web-samples/security-sample.pdf`，可用 `python scripts/generate-security-sample.py` 重新生成。检查项、资源上限、权限位与完整 schema 见 [docs/security.md](docs/security.md)。

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

action 默认 `fail-on: any`，支持 `summary` / `json` / `html`；`json-path` / `report-path` 指定 JSON/HTML payload 的文件路径（`format` 选中对应格式且未指定路径时写入 runner 临时目录），payload 不写入步骤日志。`fail-on` 可选 `any` / `added` / `removed` / `modified` / `page-count` / `reordered` / `none`；`ignore-regions` 接收与 CLI 相同的区域 JSON 路径并透传。五类资源开关同样是输入：`ignore-annotations`、`ignore-links`、`ignore-forms`、`ignore-metadata`、`ignore-page-labels`。完整输入、输出、artifact 约定见 [docs/ci.md](docs/ci.md)，Diff 的页面对齐、视觉视图、区域语义与文档资源比较见 [docs/diff.md](docs/diff.md)。

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
│   ├── cli.py             # `pdf-inspector diff` / `audit` / `security` / `accessibility` CLI
│   ├── diff.py            # 对象级 diff 引擎
│   ├── report.py          # Diff 摘要与自包含 HTML 报告
│   ├── raw.py             # 原始对象图与内容流序列化（有界、只读）
│   ├── audit.py           # 文档审计引擎（检查项、排序、AuditReport）
│   ├── audit_report.py    # 审计摘要与单文件 HTML 报告
│   ├── security.py        # 只读的文档安全资源采集
│   ├── security_report.py # 安全摘要与单文件 HTML 报告
│   ├── accessibility.py   # 只读的 tagged PDF 结构采集
│   ├── accessibility_report.py # 无障碍摘要与单文件 HTML 报告
│   ├── __tests__/         # pytest 测试
│   └── requirements.txt
├── bin/
│   └── pdf-inspector.mjs  # CLI 包装器（解析 Python 并转发退出码）
├── scripts/
│   ├── generate-web-samples.py  # 生成 web-samples/*.pdf
│   ├── generate-security-sample.py  # 生成已提交的安全样例
│   ├── generate-accessibility-samples.py  # 生成已提交的无障碍样例
│   ├── generate-icon.js
│   └── freeze-sidecar.sh
├── docs/
│   ├── audit.md           # 文档体检：检查项、AuditReport schema、CLI 与 action
│   ├── security.md        # 文档安全：资源、上限、SecurityReport schema、CLI
│   ├── accessibility.md   # 无障碍：结构树、检查项、上限、AccessibilityReport schema、CLI
│   ├── annotations.md     # 注释、链接与表单：整档索引、健康检查、JSON/CSV 导出与只读限制
│   ├── raw.md             # 原始对象树与内容流：序列化语义、上限与安全边界
│   ├── large-docs.md      # 大文档：双通道、搜索分批、页面列表、桌面/Web 文档标签与边界
│   ├── session.md         # 会话恢复与最近文件：存储键、恢复规则、隐私边界
│   ├── search.md          # 搜索 2.0：选项、结果面板、命令面板、快捷键与验证
│   ├── export.md          # 对象 JSON/CSV、PNG/SVG 视图导出与自包含 HTML 报告
│   ├── themes-i18n.md     # 主题注册表、Light/System、i18n 目录与持久化
│   ├── diff.md            # Diff：页面对齐、视觉模式、忽略区域与文档资源
│   ├── ci.md              # Diff CLI 与 GitHub Action
│   ├── packaging.md       # 打包说明
│   ├── images/            # README 截图
│   └── superpowers/       # 设计与实施文档（specs / plans）
├── web-samples/           # 生成的演示 PDF（已 gitignore；安全与无障碍样例已提交）
├── .github/workflows/ci.yml  # 包含 accessibility-cli 任务
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

CI 由 `.github/workflows/ci.yml` 定义：在推送到 `main`、推送 `v*` 标签、Pull Request 及手动触发时，执行上述类型检查与测试，并构建桌面端、Web 前端、Web 后端及生成演示 PDF；此外还有 diff CLI、diff action、audit CLI、audit action、security CLI 与 accessibility CLI（摘要、JSON、HTML 及 `--fail-on warning` 阈值）的端到端任务。

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
- Diff 比较提取出的对象、它们的元数据以及文档资源（注释、链接、表单、元数据、页面标签），不做渲染后的像素级 diff 或 OCR，扫描页面上的文字不会被识别为文本对象。`Visual` 视图的像素对比只在浏览器 UI 中运行；CLI、JSON、HTML 与 action 仍是无渲染依赖的，并同时报告对象与资源。
- 视觉对比固定使用通道差 > 24 的阈值，并把位图按上限缩放后比较（数值是采样统计，不是逐设备像素的精确值）；阈值与位图上限不暴露为设置项，CLI 也不提供 headless 视觉 diff。
- 忽略区域是只读的页面坐标矩形：以 MediaBox 的 PDF pt 记录，按“变更 BBox 与区域相交”过滤，因此一个覆盖整块区域的矩形可能同时屏蔽该区域内多个对象（包括表格整体）；区域只对当前这次比较生效，切换文件或重置后清空，不能跨运行共享。
- `match`、`pagesReordered`、`documentChanges` 与 `resources*` 摘要计数是 `DiffResult` 的新增字段，`schemaVersion` 仍为 `1`；旧消费者可以忽略这些字段，但读取方不应假定字段集合完全固定。
- 页面对齐基于内容指纹 + `SequenceMatcher`：移动页可能被报告为“删除 + 新增”，只有被配对的页才会标记 `reordered`；重复页按顺序配对，不能识别真正的“交换”语义。
- Diff CLI 需要 Python 3.10+ 与 sidecar 依赖，且只接受本地路径；`--fail-on` 只决定差异是否返回 1，参数/输入/解析错误始终返回 2，`none` 不会抑制错误。打包后的桌面应用不包含 CLI。
- 文档体检的检查是启发式的：基于提取出的对象、字体信息、页面框与 catalog 元数据，可能出现误报或漏报；`--fail-on` 与 action 阈值应结合项目实际情况设置。
- 文档体检不做 PDF/A 合规认证，也不验证数字签名；“未标记 PDF”只是诊断提示，不代表合规结论。
- 文档体检不做 OCR，也不识别扫描页中的文字；扫描页只能得到“有图片但无可提取文本”的提示。
- 旋转页或 CropBox 偏移页上的审计发现只到页面级，无法给出对象级高亮；带页码的发现仍可跳转到对应页面。
- 文档体检按 10 页一批串行执行（与字体分析相同），超大文档需要较长时间；页面提取失败是当前唯一的 `error` 来源。CLI 与 action 同样需要 Python 3.10+ 与 sidecar 依赖，且只接受本地路径，打包后的桌面应用不包含 CLI。
- 文档安全与附件检查是只读且启发式的：不执行 JavaScript、不跟随动作、不打开或解压附件、不解密流，也不验证签名。附件大小、MIME 与日期来自 PDF 元数据，可能缺失或不可信；签名只报告“存在”（`verified: false`）。资源枚举有上限，畸形对象会降级为 `null` 或被跳过。
- 注释、链接与表单的整档索引按 10 页一批顺序读取，超大文档需要较长时间；单页读取失败会中止整次索引并显示该页错误，`Retry` 从头重建，没有断点续建或部分结果。索引期间翻页与当前页检查仍可用。
- 文档模式不承诺为未激活页绘制注释框：`Show boxes` 只在 `Current page` 生效，点击列表行跳页后由当前页正常加载并尽力选中（无 id 或 id 不一致时只跳页）。
- 注释、链接与表单只读：不能新建、编辑或删除注释，不能填写、重置或提交表单，也不导入 XFA 数据；签名字段只显示为字段，不做数字签名验证。
- 注释、链接与表单只在 `Annots → Whole document` 中单独导出，不写入对象导出的 JSON/CSV；Diff 会把它们连同元数据与页面标签作为资源变更报告，Audit 另有自己的 `security` 资源清单，但完整的按页注释索引仍只能从注释导出获得。
- 视图导出是单页/单区域的只读快照：不支持整档图片导出、PDF 编辑或矢量重排。SVG 以 PNG 栅格底图加矢量叠加框组成，底图中的 PDF 文字与图形仍是位图。旋转页会省略对象/注释框（页面框仍可用）并返回警告；空区域回退整页。
- HTML 分享报告只覆盖当前页；审计发现与注释索引只有在属于当前打开文档时才写入。UI 切到中文时，报告正文仍为英文。报告上限 20 MB，截图最长边目标 2400 px。
- UI 语言只覆盖渲染层文案。默认主题与语言是用户偏好，刷新后保留；它们不改变 JSON/CSV schema 字段、PDF 对象标识、sidecar/CLI 错误或生成报告的正文。
- 外部链接只在用户点击 `Open link` 时打开，且仅支持 `http(s)`；`mailto:`、`file:`、`data:`、`javascript:` 等目标只显示、不打开。整档索引只对目标分类，不会自动打开、探测或批量请求外部 URL。内部链接只跳转到解析出的页码，不恢复滚动位置，未解析的目标保持只读展示。
- 注释健康检查是启发式的：`Issues` 依据 PDF.js 解析出的链接与表单数据给出提示，不做 PDF 合规认证；未命名 Widget 与同名字段类型冲突是 warning，跨页同名只是 info。单个链接目标解析失败只影响该条记录。
- 旋转页（`/Rotate` 为 90/180/270）只提供注释列表与详情，不绘制画布框与命中测试；CropBox 与 MediaBox 不一致的页面，注释框以 MediaBox 为基准，可能整体偏移（与对象叠加层一致）。
- 原始对象视图是只读的：不能编辑对象、重写流、解密或执行内容流，也不提供 raw diff、导出或 CLI；需要修改 PDF 时请使用其他工具。
- 原始对象视图只返回有界数据：嵌套、条目、字符串、操作符与内容流数量都有上限，超限标记 `truncated` 并在界面提示；二进制流只显示长度、过滤器与 Subtype 等元数据，不提供字节预览。
- 原始对象视图不是完整 PDF 解析器：不遍历整个对象图，不解析 XFA 或结构树，也没有对象搜索/查询语言；大文档需要按引用逐层展开。
- Raw 不使用左侧第六个标签页：它通过工具栏打开独立工作区，并与 Diff、Audit 互斥；与 Inspect 的切换不会改变文档状态，但 Raw 自身不保存展开状态，重新打开从 trailer 根开始。
- Web 多文档是会话级、单 sidecar 实现：sidecar 中始终只有活动文档，切换是串行重新打开，不能同时分析多份文档，也没有每文档 sidecar。注册表最多 8 份文档 / 总 512 MiB，超出时按最近最少激活淘汰非活动文档；被淘汰的标签需重新打开。Web 端仍没有认证、多用户隔离或按用户的文档边界，多文档不改变这一信任模型。
- Web 关闭活动标签时必须先激活邻居：服务端拒绝在仍有兄弟时删除活动文档；激活失败会保留原标签与文档。关闭最后一个标签时，只有服务端也只剩这一份登记文档才会删除活动文档并回到空状态；刷新遗留的登记文档会让 `DELETE` 返回 409，标签保留。
- 桌面与 Web 标签都只保存视图快照：页码、缩放、叠加层、左右面板标签与查询字符串会恢复；字体、审计、Raw 结果与搜索索引不跨标签保留，切回后需重新运行。桌面 URL 标签重新激活会重新下载，Web URL 文档由服务端保留并按 `sourceUrl` 去重。标签集合与每个标签的视图快照会保存在本机（`pdf-inspector:session:v1`，最多 20 个标签）并在下次启动时恢复；最近列表（`pdf-inspector:recent:v1`，最多 20 条）只保存定位信息与显示名。PDF 内容、字体/审计/Raw/Diff 结果、搜索索引与选中对象都不会持久化；Web 上传在服务端忘记登记 id 后无法恢复，需要重新上传；本地路径不会离开本机。
- 后台 sidecar 通道懒启动但本阶段不做空闲自动退出；使用过字体/审计/Raw/Diff 后会保留第二个 Python 进程直到退出或重启。
- 搜索索引只保存每页文本，没有按字节的上限；1000 页可接受。关闭搜索会取消正在进行的构建，但已完成索引会在当前 SearchBox 生命周期内复用；切换文档或离开 Inspect 才会重建并释放。极大文档仍应通过切换文档/离开 Inspect 释放索引。
- 搜索 2.0 仍是当前文档的本地文本搜索：不跨文档、不保存搜索历史、不做 OCR，也不搜索注释/表单/链接；结果最多 5,000 条且不支持结果导出。命令面板只列出已注册命令，不支持用户自定义命令或快捷键编辑器。
- 页面列表使用 CSS `content-visibility` 窗口化，DOM 中仍保留每页一个行节点；若未来出现数千页的滚动卡顿，再评估真正的虚拟列表。
- 完整工具栏（含 Export / View / Report、搜索、语言与主题）使用 3px 紧凑间距与 84px 主题选择器，固定控件在 1280px 下也能完整显示；1440px 及以上同时显示文件名，窄于 1440px 时隐藏文件名（不是控件，标题仍可在打开对话框、文档标签与状态栏查看），因此 1280/1440/1600 的英文与中文界面均无横向溢出。搜索框展开时，输入框、计数、上/下与关闭按钮始终完整可见。
- 临时文件清理为尽力而为，异常退出后可能需要手动清理系统临时目录。
- Web 模式需先构建 `dist-web` 与 `dist-web-server`；未构建时服务会提示构建后刷新。
