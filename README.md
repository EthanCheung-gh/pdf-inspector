# PDF Inspector

面向开发者的 PDF 结构检查工具——在 PDF.js 渲染结果之上叠加 pdfplumber 的坐标级对象数据，直观检查字符、单词、线条、曲线、矩形、表格和图片。提供 Electron 桌面应用与浏览器（Node HTTP 后端）两种运行方式。

[![CI](https://github.com/EthanCheung-gh/pdf-inspector/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/EthanCheung-gh/pdf-inspector/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-v0.2.0-blue.svg)](https://github.com/EthanCheung-gh/pdf-inspector)
[GitHub](https://github.com/EthanCheung-gh/pdf-inspector) · [GitCode](https://gitcode.com/EthanCheung/pdf-inspector)

|  |  |
| :---: | :---: |
| ![工作区总览：Objects / Outline / Fonts / Layers 标签与可调整面板](docs/images/overview.png) | ![对象检查](docs/images/inspector.png) |
| ![字体分析：嵌入状态徽标与 Standard 14 汇总](docs/images/fonts.png) | ![URL 打开](docs/images/url-dialog.png) |
| ![图层面板](docs/images/layers.png) | **Layers**<br>七类对象开关、计数、All/None、Solo 与透明度。 |
| ![按元素类型导出](docs/images/export-dialog.png) | **按元素类型导出**<br>选择当前页/整档、JSON/CSV 与要包含的元素类型；未勾选的类型不会写入文件。 |
| ![表格单元格网格与选中单元格](docs/images/table-cells.png) | **表格单元格**<br>选中表格后显示单元格网格、合并/缺失标记与选中单元格的 BBox；悬停或点击单元格时画布同步高亮。 |
| ![页面几何：五个页面框与标尺](docs/images/page-geometry.png) | **页面几何**<br>`Page` 标签页列出 MediaBox / CropBox / TrimBox / BleedBox / ArtBox，可切换 pt/mm 并显示标尺。 |
| ![Diff 工作区：并排旧/新页面、变更摘要与列表、右侧选中变更详情](docs/images/diff-workspace.png) | **PDF Diff**<br>并排查看旧/新页面；左侧按页汇总变更，选中条目后右侧显示旧/新文本、BBox 与字段差异，顶部可重新选择旧/新文件或导出 JSON。 |
| ![叠加模式：同一页上叠加旧/新对象框](docs/images/diff-overlay.png) | **叠加模式**<br>在同一页叠加旧/新对象框（移除红、新增绿、移动橙、修改蓝），适合定位同一区域的改动。 |
| ![文档体检工作区：严重级别汇总、筛选器、发现列表与右侧选中发现详情](docs/images/audit-workspace.png) | **文档体检**<br>跨字体、页面、图片、元数据、结构与安全的整档审计；按严重级别汇总，可按严重级别/类别筛选，选中条目查看证据与修复建议，并可跳转到对应页面。 |
| ![PDF 审计 HTML 报告：文档信息、严重级别汇总与逐条发现](docs/images/audit-report.png) | **审计报告（HTML）**<br>CLI `audit --format html` 生成单文件报告：文档信息、严重级别汇总与逐条发现（证据、建议）；内联 CSS、无脚本、无外部资源。 |

*截图来自 Web 构建；桌面端使用同一套 React UI，界面与功能一致。*

## 功能特性

### 渲染与检查

- PDF.js 多页渲染，支持翻页、缩放与适合页面宽度。
- char / word / line / curve / rect / table / image 七类对象的边界框叠加层，可在 Layers 标签页统一控制可见类型与透明度。
- 悬停或点击选中对象，Inspector 的 `Inspect` 标签页展示页码、坐标、字体、字号、颜色及原始 JSON；图片对象提供内嵌预览。
- 文本选择层支持直接选中页面文字。

### 导航与结构

- 左侧面板包含四个标签页：`Objects`（按页展示全部对象）、`Outline`（PDF 书签）、`Fonts`（字体统计）与 `Layers`（叠加层控制）。
- `Objects` 标签页的对象树按页展示全部对象，页面节点可折叠/展开。
- `Outline` 标签页读取 PDF 书签（outline），点击条目直接跳转到对应页面。
- 当前页码显示与上一页/下一页导航，并实时显示缩放比例。

### 工作区与布局

- 左右面板可通过分隔条拖拽调整宽度，并可折叠；工具栏的 Left / Right 按钮与面板内的折叠按钮保持同步。
- 面板收起后，画布边缘会出现 `Objects` / `Inspector` 恢复条，点击即可重新打开；专注模式下左上角显示 `Show panels` 恢复按钮。
- `F` 或工具栏 Focus 进入专注模式，隐藏左右面板、只保留画布；再次按 `F` 或点击 Focus 退出。
- Inspector 面板分为 `Inspect / Filter / Results / Page` 四个标签页：查看对象属性、组合筛选条件、管理筛选或框选结果、查看页面几何。
- 面板宽度、折叠状态、Focus 模式、当前标签页与叠加层透明度会保存在 localStorage，下次启动自动恢复。

### 搜索与导出

- `Ctrl/Cmd+F` 跨页全文搜索，逐条导航并高亮匹配位置。
- 导出当前页或整份文档，格式为 JSON 或 CSV；导出时可勾选要包含的元素类型（char / word / line / curve / rect / table / image）。桌面端使用原生保存对话框，Web 端触发浏览器下载。
- CSV 按对象类型分段，便于在表格工具中继续分析。
- JSON 导出新增可选字段：`metadata.fontInfo`（字体嵌入详情）、每页的 `page.boxes` / `page.rotation`、表格的 `table.cellBoxes` / `table.cellSpans`，以及图片的 `content_hash`（可读取时的 SHA-256）；CSV 各段的列定义保持不变。

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

### PDF Diff

- **对象级变更**：对 word / char / rect / line / curve / image / table 七类对象逐页比较，报告 `added` / `removed` / `moved` / `modified`；每条变更包含旧/新页码、BBox、文本与细节（字体、字号、颜色、描边/填充、content hash、表格单元格等）。
- **页面级变更**：识别页面新增/删除、页面尺寸与 `/Rotate` 旋转角变化；这些变化以页面级说明展示，而不是对象框。
- **表格单元格**：表格按单元格文本比较，`details.cellChanges` 列出变化的行、列与旧/新文本，并报告行列数变化。
- **容差与忽略**：可调位置容差（pt，默认 1.0）与文本比较模式（`exact` / `normalized` / `case-insensitive`，默认 `normalized`），并可忽略字体、颜色、图片或指定对象类型。对比对话框提供位置容差与忽略字体/颜色/图片；文本容差与 `--ignore-types` 通过 CLI 使用。
- **对比工作区**：顶部摘要（页数、页面变更、各类对象计数）加左侧按页变更列表，支持按 Kind / Type 过滤；中间为并排（Side by side）或叠加（Overlay）视图，共享页码与缩放；右侧显示选中变更的新旧文本、Box 与字段差异。
- **叠加配色**：叠加模式以页面所属文档为底图（有旧页用旧页，新增页用新页），绘制旧/新对象框——移除红、新增绿、移动橙、修改蓝，便于在同一位置快速定位改动。
- **Export JSON**：把当前结果导出为 `DiffResult` JSON（`schemaVersion: 1`）。
- **不影响当前检查**：Diff 在独立的旧/新文档上运行，Inspect 中打开的文档、页码、缩放与选中状态保持不变；`Back to Inspect` 返回原文档。
- **对象级而非像素级**：比较的是提取出的对象及其元数据，不做渲染后的像素 diff，也不做 OCR；扫描件或纯图片页面只能看到 image 对象级变化，无法识别其中的文字或局部视觉差异。

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

随后在 Web 界面打开 `/samples/basic.pdf`（小型示例，含表格与图片）或 `/samples/large.pdf`（多页文档，便于观察字体分批分析）。

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
9. **比较版本**：点击工具栏 `Diff` 选择 Old/New 两份 PDF，按需设置位置容差与忽略项后 Compare；在左侧变更列表选择条目查看详情，或切换 Side by side / Overlay，`Export JSON` 保存结果。
10. **文档体检**：点击工具栏 `Audit` 对当前文档执行整档审计，查看严重级别汇总，按严重级别/类别筛选，选中发现查看证据与建议；需要时点击 `Open page` 跳转到对应页面，或用 `Export JSON` 保存完整报告。

## CLI 与 CI

Diff 也可以脱离界面运行。CLI 只接受本地 PDF 路径（拒绝 `http(s)` URL），输出摘要、JSON 或自包含 HTML，并按 `--fail-on` 映射退出码。

```bash
# 直接使用 Python CLI；需要 Python 3.10+ 与 sidecar/requirements.txt
python sidecar/cli.py diff old.pdf new.pdf

# 通过 bin/pdf-inspector.mjs 包装器（安装/链接后可直接调用 pdf-inspector）
pdf-inspector diff old.pdf new.pdf
npm run diff -- old.pdf new.pdf
```

常用选项：

| 选项 | 说明 |
|------|------|
| `--format` | 输出格式：`summary`（默认）/ `json` / `html` |
| `--output PATH` | 把格式化结果同时写入文件；stdout 仍打印摘要 |
| `--fail-on` | 决定哪些差异返回 1；默认 `any`，可选 `added` / `removed` / `modified` / `page-count` / `none` |
| `--position-tolerance PT` | 位置容差（PDF pt），默认 `1.0` |
| `--text-tolerance` | 文本比较模式：`exact` / `normalized`（默认）/ `case-insensitive` |
| `--ignore-types TYPES` | 跳过指定对象类型，逗号分隔、可重复 |
| `--ignore-fonts` / `--ignore-colors` / `--ignore-images` | 忽略字体/颜色/图片差异 |
| `--quiet` | 不打印人类摘要，只保留 JSON/HTML 输出 |

退出码：`0` 表示无差异，或差异均被 `--fail-on`/忽略选项排除；`1` 表示 `--fail-on` 条件命中；`2` 表示参数、输入、解析或输出错误。`--fail-on none` 永不返回 1，但输入错误仍返回 2。`added` / `removed` 同时覆盖对象与页面，`modified` 覆盖 modified、moved 以及页面尺寸/旋转变化，`page-count` 覆盖页面增删、页数与页面几何变化。

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

action 默认 `fail-on: any`，支持 `summary` / `json` / `html`；`json-path` / `report-path` 指定 JSON/HTML payload 的文件路径（`format` 选中对应格式且未指定路径时写入 runner 临时目录），payload 不写入步骤日志。完整输入、输出、artifact 约定见 [docs/ci.md](docs/ci.md)。

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

Python 侧车通过 stdin/stdout 上的行分隔 JSON-RPC 通信，提供 `open`、`extract_page`、`extract_metadata`、`analyze_fonts`、`get_image_data`、`audit_document`、`audit_pages`、`shutdown` 等方法，并用 LRU 缓存复用已解析页面。

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
- Web 端的当前文档、上传与下载文件存放在系统临时目录，正常关闭时清理；崩溃或强杀进程可能残留。
- URL 打开仅接受 `http(s)`，下载受超时限制。
- 侧车请求有超时保护；桌面端会自动重启侧车，Web 后端会在请求时自动拉起进程，并提供 `/api/restart` 接口。
- 测试或 CI 中可用 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过 Electron 二进制下载（仅影响桌面端启动）。

## 已知限制

- 侧车一次处理一个请求；单批字体分析执行期间，其他解析请求需要等待，批次之间会插入处理。
- 字体分析按 10 页一批顺序执行，超大文档需要较长时间，但可分页浏览并查看进度。
- 旋转页面（`/Rotate` 为 90/180/270）仍显示页面框与标尺，但对象叠加层不可用：对象坐标按未旋转页面映射，无法可靠对齐；Diff 的并排/叠加对象框同样隐藏。
- 当 CropBox 小于 MediaBox 时，页面框与标尺以 MediaBox 作为页面框架，而 PDF.js 按 CropBox 渲染，因此页面与内容边距的视觉表现可能不同；Diff 的叠加框也以 MediaBox 为基准，可能同样偏移。
- Diff 的对象配对是启发式的：重复出现的相同对象（重复文字、相同几何的线条/矩形）只能按距离或阅读顺序贪心匹配；对象同时移动且内容改变、超出位置容差时，可能被报告为 `removed` + `added` 而不是 `modified` / `moved`。可调整 `--position-tolerance`、文本容差或忽略相应类型来减少噪声。
- Diff 只比较提取出的对象及其元数据，不做渲染后的像素级 diff 或 OCR；扫描页面上的文字不会被识别为文本对象。
- Diff CLI 需要 Python 3.10+ 与 sidecar 依赖，且只接受本地路径；`--fail-on` 只决定差异是否返回 1，参数/输入/解析错误始终返回 2，`none` 不会抑制错误。打包后的桌面应用不包含 CLI。
- 文档体检的检查是启发式的：基于提取出的对象、字体信息、页面框与 catalog 元数据，可能出现误报或漏报；`--fail-on` 与 action 阈值应结合项目实际情况设置。
- 文档体检不做 PDF/A 合规认证，也不验证数字签名；“未标记 PDF”只是诊断提示，不代表合规结论。
- 文档体检不做 OCR，也不识别扫描页中的文字；扫描页只能得到“有图片但无可提取文本”的提示。
- 旋转页或 CropBox 偏移页上的审计发现只到页面级，无法给出对象级高亮；带页码的发现仍可跳转到对应页面。
- 文档体检按 10 页一批串行执行（与字体分析相同），超大文档需要较长时间；页面提取失败是当前唯一的 `error` 来源。CLI 与 action 同样需要 Python 3.10+ 与 sidecar 依赖，且只接受本地路径，打包后的桌面应用不包含 CLI。
- Web 模式同一时间只维护一份“当前文档”，且没有多用户隔离或认证。
- 临时文件清理为尽力而为，异常退出后可能需要手动清理系统临时目录。
- Web 模式需先构建 `dist-web` 与 `dist-web-server`；未构建时服务会提示构建后刷新。
