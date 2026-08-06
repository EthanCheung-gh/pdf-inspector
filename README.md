# PDF Inspector

面向开发者的 PDF 结构检查工具（"PDF 版 DevTools"）——基于 Electron + PDF.js 渲染与 pdfplumber 坐标级对象提取，可视化检查 PDF 的对象结构、字体、表格、图片等属性。

## 功能特性

- **PDF 渲染**：多页导航、缩放、适合页面宽度
- **对象叠加层**：char / word / line / curve / rect / table / image 七类对象的边界框可视化与独立开关
- **悬停 / 选中检查**：Inspector 面板展示对象坐标、字体、颜色与原始 JSON；图片对象内嵌预览
- **结构树 + 书签**：左侧面板按页面浏览对象层级，书签一键跳转
- **全文搜索**：`Ctrl/Cmd+F` 跨页搜索，逐条导航并高亮
- **数据导出**：当前页 / 整档 × JSON / CSV，原生保存对话框
- **对象子集**：拖拽框选（相交/包含可切换）或按字体 / 字号 / 颜色 / 类型筛选，结果高亮、列表展示并可导出
- **字体分析**：全文档字体使用统计（页数 / 字符数 / 字号范围 / 颜色），点击字体自动跳页并高亮该字体对象
- **模式切换**：文本选择（`T`）与区域框选（`R`）互斥切换

## 架构

三进程架构：

```
┌──────────────────────────────────────────────────┐
│                Electron Main Process             │
│  • 窗口管理、原生菜单与对话框                       │
│  • Python 侧车生命周期（spawn/monitor/kill）       │
│  • IPC 桥（ipcMain ↔ preload ↔ renderer）         │
└───────────┬──────────────────────────┬───────────┘
            │ IPC（contextBridge）      │ child_process
            ▼                          ▼
┌──────────────────────┐   ┌──────────────────────┐
│   Renderer Process   │   │   Python Sidecar      │
│  • PDF.js 渲染        │   │  • pdfplumber 解析    │
│  • Canvas 叠加层      │   │  • JSON-RPC over stdio│
│  • React UI          │   │  • LRU 页面缓存        │
└──────────────────────┘   └──────────────────────┘
```

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 28 |
| 前端 | React 18 + TypeScript + Vite + Zustand + CSS Modules |
| PDF 渲染 | pdfjs-dist 4.x |
| 提取引擎 | Python 3 + pdfplumber（sidecar 子进程） |
| 前端测试 | Vitest |
| Python 测试 | pytest + reportlab（fixture 生成） |

## 环境要求

- **Node.js ≥ 22.12**（jsdom 依赖 require(esm)，参见 `.nvmrc`）
- **Python 3** + `pdfplumber`（sidecar 运行依赖）
- `reportlab`（仅 Python 测试生成 fixture 使用）

## 快速开始

```bash
npm install
npm run dev      # 开发模式（Vite HMR + Electron）
npm start        # 构建 main 并启动 Electron
```

## 测试

```bash
# 前端测试（需 Node ≥ 22.12，建议 nvm use）
npx vitest run

# Python 侧车测试
python3 -m pytest sidecar/__tests__/
```

## 打包发布

```bash
npm run dist          # 当前平台
npm run dist:win      # Windows
npm run dist:mac      # macOS
npm run dist:linux    # Linux
```

打包细节参见 `docs/packaging.md`。

## 项目结构

```
pdf-inspector/
├── src/
│   ├── main/               # Electron 主进程（窗口、IPC、sidecar 管理）
│   ├── preload/            # contextBridge API
│   ├── renderer/           # React 应用（组件、hooks、store、services）
│   └── shared/             # 主进程/渲染进程共享常量与工具
├── sidecar/                # Python 侧车（extractor / cache / models / main）
│   └── __tests__/          # pytest 测试
├── docs/
│   ├── packaging.md
│   └── superpowers/        # 设计与实施文档（specs / plans）
└── resources/              # 图标等资源
```
