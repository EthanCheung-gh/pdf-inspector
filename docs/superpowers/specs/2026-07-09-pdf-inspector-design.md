# PDF Inspector — Design Spec

**Date:** 2026-07-09
**Status:** Draft
**Author:** Superpowers spec process (brainstorming → spec)

---

## 1. Overview

A cross-platform desktop PDF inspector tool built with Electron. Combines **PDF.js** for rendering and **pdfplumber** (Python) for coordinate-level object extraction, enabling developers and data analysts to inspect PDF structure visually — similar to Chrome DevTools Elements panel but for PDF documents.

### Target Users

- **PDF developers/engineers** — debug PDF structure, inspect object coordinates, fonts, colors
- **Data analysts** — extract tables, text, images with spatial context

### Deployment Model

**Electron desktop application** — single self-contained app with PDF.js in the renderer and a Python pdfplumber sidecar subprocess.

---

## 2. Architecture

### 2.1 Three-Process Architecture

```
┌──────────────────────────────────────────────────┐
│                Electron Main Process             │
│  • Window manager, native menus/dialogs          │
│  • Python sidecar lifecycle (spawn/monitor/kill) │
│  • IPC bridge (ipcMain ↔ preload ↔ renderer)     │
│  • File system access (open PDF)                 │
└────────────┬──────────────────────────┬──────────┘
             │ IPC (contextBridge)       │ child_process
             ▼                          ▼
┌──────────────────────┐   ┌──────────────────────┐
│   Renderer Process   │   │   Python Sidecar      │
│   (Chromium)         │   │   (subprocess)        │
│                      │   │                      │
│  • PDF.js rendering  │   │  • pdfplumber parser │
│  • Canvas Overlay    │   │  • JSON-RPC over      │
│  • React UI          │   │    stdin/stdout       │
│  • HitTest & Highlight│   │  • LRU page cache    │
└──────────────────────┘   └──────────────────────┘
```

### 2.2 Communication Protocol: JSON-RPC over stdio

Main process spawns Python as `child_process.spawn('python3', ['sidecar/main.py'])`. Each exchange is a single JSON line:

```
→ {"id":1,"method":"open","params":{"path":"/doc.pdf"}}
← {"id":1,"result":{"pages":12,"version":"1.7","encrypted":false,"page_w":612,"page_h":792}}

→ {"id":2,"method":"extract_page","params":{"page":1}}
← {"id":2,"result":{"chars":[...],"words":[...],"rects":[...],"lines":[...],"curves":[...],"images":[...],"tables":[]}}
```

#### Methods

| Method | Params | Response | Caching |
|--------|--------|----------|---------|
| `open` | `{path, password?}` | `{pages, version, encrypted, page_w, page_h}` | Session |
| `extract_page` | `{page}` | `{chars[], words[], rects[], lines[], curves[], images[], tables[]}` | LRU 10 |
| `extract_metadata` | `{}` | `{title, author, producer, created, modified, fonts[]}` | Single |
| `extract_tables` | `{page}` | `{tables: [{bbox, cells[][], text}]}` | LRU |
| `extract_images` | `{page}` | `{images: [{bbox, w, h, stream_id, format}]}` | LRU |
| `get_image_data` | `{stream_id}` | `{base64, format, w, h}` | On demand |
| `shutdown` | `{}` | `{}` | — |

### 2.3 Sidecar Lifecycle

1. **App start** → check if `python3` + `pdfplumber` are available
2. **Spawn** Python process, keep stdio pipes open
3. **Open PDF** → main sends file path, sidecar validates and caches
4. **Extract pages** → LRU-cached extraction per page
5. **App close** → send `shutdown` or kill subprocess
6. **Crash recovery** → restart sidecar, show notification

---

## 3. UI Layout

Three-panel layout with resizable splitters:

```
┌────────────────────────────────────────────────────────────┐
│  Toolbar: [Open] | ◀ 2/12 ▶ | Zoom: − 100% + |            │
│  Overlay: [Chars] [Words] [Lines] [Rects] [Tables] [Images] │
├──────────┬─────────────────────────────┬───────────────────┤
│Structure │       PDF Viewport          │   Inspector       │
│Tree      │  ┌──────────────────────┐   │   Panel           │
│          │  │  PDF.js Canvas       │   │                   │
│ 📄Page 1 │  │  + TextLayer         │   │  Type: char       │
│  ├─Table │  │  + AnnotLayer        │   │  Content: "H"     │
│  ├─Image │  │  + Overlay Canvas    │   │  x0: 112.34       │
│  └─Text  │  │  + InspectorHighlight│   │  y0: 684.21       │
│ 📄Page 2 │  └──────────────────────┘   │  Font: Helvetica  │
│ 📄Page 3 │                              │  Size: 12.0pt     │
│  ...     │                              │  JSON: {...}      │
└──────────┴─────────────────────────────┴───────────────────┘
```

### Panels

- **Left: Structure Tree** — Pages list, expandable per page showing contained objects
- **Center: PDF Viewport** — PDF.js rendering with multi-layer overlays
- **Right: Inspector Panel** — hovered/selected object properties + raw JSON

---

## 4. Component Tree (React)

```
<App>
 ├── <Toolbar>
 │    ├── OpenButton
 │    ├── PageNavigator (page / total / prev / next)
 │    ├── ZoomControls (slider / − / +)
 │    └── <OverlayToggles> (per-type visibility toggle)
 │
 ├── <SplitLayout> (resizable 3-pane)
 │    ├── <StructureTree>
 │    │    └── <PageNode>[]
 │    │         └── <ObjectNode>[]
 │    │
 │    ├── <PdfViewport>
 │    │    └── <PdfPage>[]
 │    │         ├── <PdfJsCanvas>
 │    │         ├── <TextLayer> (PDF.js native)
 │    │         ├── <AnnotationLayer> (PDF.js native)
 │    │         ├── <OverlayCanvas> (custom: all bboxes)
 │    │         └── <InspectorHighlight> (hover/selected)
 │    │
 │    └── <InspectorPanel>
 │         ├── <ObjectHeader>
 │         ├── <PositionTable> (x0/y0/x1/y1/w/h)
 │         ├── <FontInfo> (name/size/color)
 │         ├── <PageInfo>
 │         └── <RawJson>
 │
 └── <StatusBar>
```

---

## 5. Overlay Layer Design

### Layer Order (bottom → top)

| Layer | Content | Implementation |
|-------|---------|----------------|
| 0 | PDF.js Canvas | Rendered page content |
| 1 | Text Layer | Selectable text DOM (PDF.js built-in) |
| 2 | Annotation Layer | Links, forms, comments (PDF.js built-in) |
| 3 | Overlay Canvas | All object bboxes drawn on a single `<canvas>` |
| 4 | Inspector Highlight | Yellow highlight for hovered/selected object |

### Overlay Rendering (Canvas strategy)

- Single `<canvas>` element positioned absolutely over the PDF page
- Each object type rendered in a distinct color:
  - `char` — green semi-transparent border
  - `word` — blue border with label
  - `line` — red stroke
  - `rect` — purple border
  - `curve` — orange path
  - `image` — cyan border
  - `table` — blue border with label
- Type visibility toggled from toolbar
- Hovered object: yellow highlight + tooltip label
- Selected object: persistent gold border + inspector panel update

### HitTest Strategy

- **Canvas-based hitTest**: maintain spatial index of all rendered objects
- On mousemove, iterate candidates within cursor radius
- Return nearest shallowest object (char > word > line > etc.)
- Offscreen rendering not required — O(n) scan is sufficient for typical PDF pages (< 2000 objects)

### Coordinate Transform

**Important:** PDF uses bottom-left origin (0,0), while the screen uses top-left origin. The y-axis must be flipped:

```
screenX = (pdfX / pdfPageWidth) * canvasWidth * zoom
screenY = ((pdfPageHeight - pdfY) / pdfPageHeight) * canvasHeight * zoom
```

Where `pdfPageHeight` is the media box height from pdfplumber, and `canvasWidth`/`canvasHeight` are the PDF.js canvas dimensions. The `zoom` factor is applied uniformly to both axes.

---

## 6. Data Flow

### Open PDF
1. Main: `dialog.showOpenDialog` → file path
2. Main: spawn sidecar → `{"method":"open","params":{"path":"..."}}`
3. Sidecar: parse with pdfplumber → return metadata
4. Renderer: PDF.js.loadFile → render first page
5. Renderer: request `extract_page(1)` → draw overlays

### Page Navigation
1. Renderer: PDF.js jump to page N
2. Renderer → Main → Sidecar: `extract_page(N)`
3. Sidecar: pdfplumber.pages[N].extract_*() → return all objects
4. Renderer: update OverlayCanvas + StructureTree
5. Previous page request cancelled if still pending

### Hover/Select
1. mousemove on OverlayCanvas → hitTest → object found
2. Zustand store: `hoveredObject = object`
3. InspectorHighlight re-renders (yellow border)
4. InspectorPanel updates with object properties
5. Click → `selectedObject = object` → lock + tree sync

---

## 7. Technology Stack

| Layer | Choice |
|-------|--------|
| Desktop framework | Electron 28+ |
| Frontend | React 18 + TypeScript + Vite |
| PDF rendering | pdfjs-dist |
| State management | Zustand |
| Styling | CSS Modules |
| IPC | contextBridge + ipcRenderer/ipcMain |
| Python sidecar | Python 3.10+ / pdfplumber |
| Build & package | electron-builder + Vite |
| Testing (frontend) | Vitest |
| Testing (Python) | pytest |

---

## 8. Project Structure

```
pdf-inspector/
├── package.json
├── electron-builder.yml
├── tsconfig.json
├── vite.config.ts
│
├── src/
│   ├── main/                    # Electron Main Process
│   │   ├── index.ts             # Window creation, menu
│   │   ├── ipc-handlers.ts      # IPC handler registration
│   │   └── sidecar.ts           # Python subprocess management
│   │
│   ├── preload/
│   │   └── index.ts             # contextBridge API
│   │
│   ├── renderer/                # React application
│   │   ├── App.tsx
│   │   ├── main.tsx             # Entry point
│   │   ├── components/
│   │   │   ├── Toolbar/
│   │   │   ├── StructureTree/
│   │   │   ├── PdfViewport/
│   │   │   │   ├── PdfPage.tsx
│   │   │   │   ├── OverlayCanvas.tsx
│   │   │   │   └── InspectorHighlight.tsx
│   │   │   ├── InspectorPanel/
│   │   │   └── StatusBar/
│   │   ├── hooks/
│   │   │   ├── usePdf.ts
│   │   │   ├── useOverlay.ts
│   │   │   └── useHitTest.ts
│   │   ├── store/
│   │   │   └── pdf-store.ts
│   │   ├── services/
│   │   │   └── ipc-client.ts
│   │   └── types/
│   │       ├── pdf-objects.ts
│   │       └── ipc-protocol.ts
│   │
│   └── shared/
│       └── constants.ts
│
├── sidecar/                     # Python sidecar
│   ├── main.py                  # JSON-RPC loop (stdin/stdout)
│   ├── extractor.py             # pdfplumber extraction logic
│   ├── cache.py                 # LRU page cache
│   ├── models.py                # Data models / serialization
│   └── requirements.txt
│
└── resources/
    └── icon.png
```

---

## 9. Object Data Models

### All objects share:
```typescript
interface PdfObject {
  type: 'char' | 'word' | 'rect' | 'line' | 'curve' | 'image' | 'table';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  page: number;
}
```

### Type-specific fields:
- **char**: `text`, `fontname`, `size`, `color`
- **word**: `text`, `fontname`, `size`, `charIndices[]`
- **rect**: `fill`, `stroke`, `color`, `width`
- **line**: `stroke`, `color`, `width`
- **curve**: `points[]`, `stroke`
- **image**: `width`, `height`, `stream_id`, `format`
- **table**: `rows`, `cols`, `cells[][]` (with text content per cell)

---

## 10. Error Handling

| Scenario | Mitigation |
|----------|------------|
| Python not installed | Detection on startup → guided install dialog |
| pdfplumber missing | Auto `pip install -r requirements.txt` |
| Encrypted PDF | Password prompt → re-open with password |
| Corrupted PDF | Sidecar returns error → PyMuPDF fallback |
| Sidecar crash/ hang | stderr monitoring + auto-restart; 30s timeout |
| Large PDF (>500 pages) | Lazy loading per page, on-demand extraction |
| Empty page | No overlay shown, status bar indication |

---

## 11. Testing Strategy

- **Frontend (Vitest):** Component rendering, hitTest algorithm, coordinate transforms, store state changes, IPC serialization
- **Python (pytest):** PDF extraction fidelity, JSON-RPC protocol handling, LRU cache, encrypted PDF handling, edge cases (empty/corrupt)
- **Integration:** Full open → navigate → hover → select flow with real PDF fixture files; sidecar lifecycle (start/crash/restart)

---

## 12. Scope (Phase 1)

### In Scope
- PDF rendering with multi-page navigation and zoom
- Canvas Overlay with char/word/line/rect/curve/image/table bboxes
- Hover highlight + click select + inspector panel
- Structure tree (left panel: Page → Object hierarchy)
- Text selection and copy (PDF.js text layer)
- Table detection + highlight
- Image extraction + preview
- PDF metadata display (version, pages, fonts, etc.)

### Out of Scope (Phase 1)
- PDF editing or generation
- OCR for scanned documents
- Digital signature verification
- Form filling or annotation creation
- Batch processing / CLI mode
