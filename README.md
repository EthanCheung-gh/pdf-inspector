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
- JSON 导出新增可选字段：`metadata.fontInfo`（字体嵌入详情）、每页的 `page.boxes` / `page.rotation`，以及表格的 `table.cellBoxes` / `table.cellSpans`；CSV 各段的列定义保持不变。

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

Python 侧车通过 stdin/stdout 上的行分隔 JSON-RPC 通信，提供 `open`、`extract_page`、`extract_metadata`、`analyze_fonts`、`get_image_data`、`shutdown` 等方法，并用 LRU 缓存复用已解析页面。

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
│   ├── __tests__/         # pytest 测试
│   └── requirements.txt
├── scripts/
│   ├── generate-web-samples.py  # 生成 web-samples/*.pdf
│   ├── generate-icon.js
│   └── freeze-sidecar.sh
├── docs/
│   ├── packaging.md       # 打包说明
│   ├── images/            # README 截图
│   └── superpowers/       # 设计与实施文档（specs / plans）
├── web-samples/           # 生成的演示 PDF（已 gitignore）
├── .github/workflows/ci.yml
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

CI 由 `.github/workflows/ci.yml` 定义：在推送到 `main`、推送 `v*` 标签、Pull Request 及手动触发时，执行上述类型检查与测试，并构建桌面端、Web 前端、Web 后端及生成演示 PDF。

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
- 旋转页面（`/Rotate` 为 90/180/270）仍显示页面框与标尺，但对象叠加层不可用：对象坐标按未旋转页面映射，无法可靠对齐。
- 当 CropBox 小于 MediaBox 时，页面框与标尺以 MediaBox 作为页面框架，而 PDF.js 按 CropBox 渲染，因此页面与内容边距的视觉表现可能不同。
- Web 模式同一时间只维护一份“当前文档”，且没有多用户隔离或认证。
- 临时文件清理为尽力而为，异常退出后可能需要手动清理系统临时目录。
- Web 模式需先构建 `dist-web` 与 `dist-web-server`；未构建时服务会提示构建后刷新。
