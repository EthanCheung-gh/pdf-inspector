# PDF Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-subagent-driven-development (recommended) or superpowers-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Electron desktop PDF Inspector with PDF.js rendering + pdfplumber extraction + Canvas overlay visualization.

**Architecture:** Three-process architecture: Electron Main (window/IPC/sidecar mgmt) ⇄ Renderer (React/PDF.js/Canvas overlay) ⇄ Python sidecar (pdfplumber extraction over stdin/stdout JSON-RPC).

**Tech Stack:** Electron 28+, React 18 + TypeScript + Vite, pdfjs-dist, Zustand, CSS Modules, Python 3.10+ / pdfplumber, electron-builder.

## Execution Status

| Task | Status | Implementation commit |
| --- | --- | --- |
| 1. Project scaffolding | Complete | `668ad24` |
| 2. Electron main process | Complete | `2d5106f` |
| 3. Python JSON-RPC sidecar | Complete | `2273ce6` |
| 4. pdfplumber extractor + cache | Complete | `6a8fc3d` |
| 5. Sidecar manager + IPC | Complete | `ec5ecb1` |
| 6. Preload bridge + renderer IPC | Complete | included in `ec5ecb1` |
| 7. Zustand store + React entry | Complete | `ab08e89` |
| 8. PDF.js viewer + worker runtime fixes | Complete | `263e5d5`, `d8f3036` |
| 9. Canvas overlay + hit test | Complete | `e7e926a`, `ee14dcb` |
| 10. Toolbar | Complete | `f774b42`, `de05563` |
| 11. Structure tree | Complete | `5aba65d`, `70c6251`, `9b7b85d` |
| 12. Inspector panel | Complete | `3f6db33` |
| 13. App shell + status bar | Complete | `28801a3` |
| 14. Sidecar resilience | Complete | `e0930c8`, `c387968` |
| 15. Text layer + image preview | Complete | `de38a56`, `d11bc29`, `979c979` |

---

## File Structure

```
pdf-inspector/
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── electron-builder.yml
├── index.html
│
├── src/
│   ├── main/
│   │   ├── index.ts              # Window creation, app lifecycle
│   │   ├── ipc-handlers.ts       # IPC handler registration
│   │   └── sidecar.ts            # Python subprocess management
│   │
│   ├── preload/
│   │   └── index.ts              # contextBridge API
│   │
│   ├── renderer/
│   │   ├── App.tsx               # Root layout + SplitLayout
│   │   ├── App.module.css
│   │   ├── main.tsx              # React entry point
│   │   ├── components/
│   │   │   ├── Toolbar/
│   │   │   │   ├── Toolbar.tsx
│   │   │   │   └── Toolbar.module.css
│   │   │   ├── StructureTree/
│   │   │   │   ├── StructureTree.tsx
│   │   │   │   └── StructureTree.module.css
│   │   │   ├── PdfViewport/
│   │   │   │   ├── PdfViewport.tsx
│   │   │   │   ├── PdfViewport.module.css
│   │   │   │   ├── PdfPage.tsx
│   │   │   │   ├── PdfPage.module.css
│   │   │   │   ├── OverlayCanvas.tsx
│   │   │   │   └── InspectorHighlight.tsx
│   │   │   ├── InspectorPanel/
│   │   │   │   ├── InspectorPanel.tsx
│   │   │   │   └── InspectorPanel.module.css
│   │   │   └── StatusBar/
│   │   │       ├── StatusBar.tsx
│   │   │       └── StatusBar.module.css
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
├── sidecar/                       # Python sidecar
│   ├── main.py
│   ├── extractor.py
│   ├── cache.py
│   ├── models.py
│   └── requirements.txt
│
└── resources/
    └── icon.png
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `electron-builder.yml`
- Create: `index.html`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pdf-inspector",
  "version": "0.1.0",
  "private": true,
  "main": "dist/main/index.js",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "build:main": "tsc -p tsconfig.node.json",
    "start": "npm run build:main && electron .",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "pdfjs-dist": "^4.8.69",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "^28.3.0",
    "electron-builder": "^24.13.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vite-plugin-electron": "^0.28.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "baseUrl": ".",
    "paths": {
      "@main/*": ["src/main/*"],
      "@preload/*": ["src/preload/*"],
      "@renderer/*": ["src/renderer/*"],
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": ["src/renderer", "src/shared"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 3: Create `tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist/main",
    "rootDir": "src/main",
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": ["src/main/**/*.ts", "src/preload/**/*.ts", "src/shared/**/*.ts"]
}
```

- [ ] **Step 4: Create `vite.config.ts`**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(args) { args.startup(); },
        vite: {
          build: {
            outDir: 'dist/main',
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      },
      {
        entry: 'src/preload/index.ts',
        onstart(args) { args.reload(); },
        vite: {
          build: {
            outDir: 'dist/preload',
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      }
    ])
  ],
  resolve: {
    alias: {
      '@main': path.resolve(__dirname, 'src/main'),
      '@preload': path.resolve(__dirname, 'src/preload'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    }
  },
  root: '.',
  base: './'
});
```

- [ ] **Step 5: Create `electron-builder.yml`**

```yaml
appId: com.pdfinspector.app
productName: PDF Inspector
directories:
  output: release
files:
  - dist/**/*
  - package.json
extraResources:
  - from: sidecar/
    to: sidecar/
    filter:
      - "**/*.py"
      - requirements.txt
mac:
  target: dmg
win:
  target: nsis
linux:
  target: AppImage
```

- [ ] **Step 6: Create `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PDF Inspector</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/renderer/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 7: Install dependencies**

Run: `npm install`
Expected: All deps installed, no errors.

- [ ] **Step 8: Create directory structure**

Run: `mkdir -p src/main src/preload src/renderer/components/Toolbar src/renderer/components/StructureTree src/renderer/components/PdfViewport src/renderer/components/InspectorPanel src/renderer/components/StatusBar src/renderer/hooks src/renderer/store src/renderer/services src/renderer/types src/shared sidecar resources`
Expected: Directories created.

- [ ] **Step 9: Commit**

```bash
git init && git add -A && git commit -m "chore: scaffold electron + react + vite project"
```

---

### Task 2: Electron Main Process (Window + Sidecar Stub)

**Files:**
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`

- [ ] **Step 1: Create `src/main/index.ts`**

```typescript
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'PDF Inspector',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../index.html')); // compiled main is dist/main/index.js, Vite output is dist/index.html
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 2: Create `src/preload/index.ts`**

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pdfInspector', {
  // Stub — will be populated in Task 6
  openPdf: () => ipcRenderer.invoke('pdf:open'),
});
```

- [ ] **Step 3: Verify Electron launches**

Run: `npm run dev`
Expected: Electron window opens with a blank page (no React content yet).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add electron main process with window creation"
```

---

### Task 3: Python Sidecar — JSON-RPC Loop + Models

**Files:**
- Create: `sidecar/requirements.txt`
- Create: `sidecar/models.py`
- Create: `sidecar/main.py`

- [ ] **Step 1: Create `sidecar/requirements.txt`**

```
pdfplumber>=0.11.0
Pillow>=10.0.0
```

- [ ] **Step 2: Create `sidecar/models.py`**

```python
from dataclasses import dataclass, field, asdict
from typing import Any, Optional


@dataclass
class PdfObject:
    type: str
    x0: float
    y0: float
    x1: float
    y1: float
    page: int
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {'type': self.type, 'x0': self.x0, 'y0': self.y0,
                'x1': self.x1, 'y1': self.y1, 'page': self.page, **self.extra}


@dataclass
class RpcRequest:
    id: int
    method: str
    params: dict[str, Any]


@dataclass
class RpcResponse:
    id: int
    result: Any = None
    error: Optional[str] = None


def parse_request(line: str) -> RpcRequest:
    import json
    data = json.loads(line)
    return RpcRequest(id=data['id'], method=data['method'], params=data.get('params', {}))


def format_response(resp: RpcResponse) -> str:
    import json
    if resp.error:
        return json.dumps({'id': resp.id, 'error': resp.error}) + '\n'
    return json.dumps({'id': resp.id, 'result': resp.result}) + '\n'
```

- [ ] **Step 3: Create `sidecar/main.py`**

```python
#!/usr/bin/env python3
import sys
import json
import traceback

from models import parse_request, format_response, RpcResponse
from extractor import PdfExtractor
from cache import PageCache


def main():
    extractor: PdfExtractor | None = None
    cache = PageCache(max_pages=10)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = parse_request(line)
        except (json.JSONDecodeError, KeyError) as e:
            sys.stderr.write(f'Parse error: {e}\n')
            sys.stderr.flush()
            continue

        try:
            if req.method == 'open':
                path = req.params['path']
                password = req.params.get('password')
                extractor = PdfExtractor(path, password)
                meta = extractor.get_metadata()
                resp = format_response(RpcResponse(id=req.id, result=meta))

            elif req.method == 'extract_page':
                if extractor is None:
                    resp = format_response(RpcResponse(id=req.id, error='No PDF open'))
                else:
                    page_num = req.params['page']
                    cached = cache.get(page_num)
                    if cached:
                        resp = format_response(RpcResponse(id=req.id, result=cached))
                    else:
                        data = extractor.extract_page(page_num)
                        cache.put(page_num, data)
                        resp = format_response(RpcResponse(id=req.id, result=data))

            elif req.method == 'extract_metadata':
                if extractor is None:
                    resp = format_response(RpcResponse(id=req.id, error='No PDF open'))
                else:
                    meta = extractor.get_metadata()
                    resp = format_response(RpcResponse(id=req.id, result=meta))

            elif req.method == 'get_image_data':
                if extractor is None:
                    resp = format_response(RpcResponse(id=req.id, error='No PDF open'))
                else:
                    image_data = extractor.get_image_data(req.params['stream_id'])
                    resp = format_response(RpcResponse(id=req.id, result=image_data))

            elif req.method == 'shutdown':
                resp = format_response(RpcResponse(id=req.id, result={}))
                sys.stdout.write(resp)
                sys.stdout.flush()
                break

            else:
                resp = format_response(RpcResponse(id=req.id, error=f'Unknown method: {req.method}'))

        except Exception as e:
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            resp = format_response(RpcResponse(id=req.id, error=str(e)))

        sys.stdout.write(resp)
        sys.stdout.flush()


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: Verify Python syntax is valid**

Run: `python3 -c "import ast; ast.parse(open('sidecar/main.py').read()); print('OK')"` and `python3 -c "import ast; ast.parse(open('sidecar/models.py').read()); print('OK')"`
Expected: Both print "OK".

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add python sidecar JSON-RPC loop and models"
```

---

### Task 4: Python Sidecar — Extractor + Cache

**Files:**
- Create: `sidecar/extractor.py`
- Create: `sidecar/cache.py`

- [ ] **Step 1: Create `sidecar/cache.py`**

```python
from collections import OrderedDict
from typing import Any, Optional


class PageCache:
    """LRU cache for extracted page data."""

    def __init__(self, max_pages: int = 10):
        self._cache: OrderedDict[int, dict[str, Any]] = OrderedDict()
        self._max_pages = max_pages

    def get(self, page_num: int) -> Optional[dict[str, Any]]:
        if page_num not in self._cache:
            return None
        self._cache.move_to_end(page_num)
        return self._cache[page_num]

    def put(self, page_num: int, data: dict[str, Any]) -> None:
        self._cache[page_num] = data
        self._cache.move_to_end(page_num)
        while len(self._cache) > self._max_pages:
            self._cache.popitem(last=False)

    def clear(self) -> None:
        self._cache.clear()
```

- [ ] **Step 2: Create `sidecar/extractor.py`**

```python
from typing import Optional
import base64
import io

import pdfplumber
from pdfplumber.page import Page
from pdfplumber.table import Table


class PdfExtractor:
    """Wraps pdfplumber to extract page-level structured data."""

    def __init__(self, path: str, password: Optional[str] = None):
        self._path = path
        self._password = password
        self._pdf = pdfplumber.open(path, password=password)

    def get_metadata(self) -> dict:
        doc = self._pdf.metadata
        fonts = set()
        for page in self._pdf.pages:
            for char in page.chars:
                fonts.add(char.get('fontname', ''))
        return {
            'pages': len(self._pdf.pages),
            'version': self._pdf.pdf_version if hasattr(self._pdf, 'pdf_version') else 'unknown',
            'encrypted': self._pdf.is_encrypted if hasattr(self._pdf, 'is_encrypted') else False,
            'page_w': float(self._pdf.pages[0].width) if self._pdf.pages else 0,
            'page_h': float(self._pdf.pages[0].height) if self._pdf.pages else 0,
            'title': doc.get('Title', ''),
            'author': doc.get('Author', ''),
            'producer': doc.get('Producer', ''),
            'fonts': sorted(fonts),
        }

    def extract_page(self, page_num: int) -> dict:
        page: Page = self._pdf.pages[page_num - 1]  # pdfplumber is 0-indexed

        chars = []
        for c in page.chars:
            chars.append({
                'type': 'char',
                'x0': float(c['x0']), 'y0': float(c['y0']),
                'x1': float(c['x1']), 'y1': float(c['y1']),
                'text': c.get('text', ''),
                'fontname': c.get('fontname', ''),
                'size': float(c.get('size', 0)),
                'color': c.get('stroking_color', '#000000') or '#000000',
                'page': page_num,
            })

        words = []
        for w in page.extract_words():
            words.append({
                'type': 'word',
                'x0': float(w['x0']), 'y0': float(w['y0']),
                'x1': float(w['x1']), 'y1': float(w['y1']),
                'text': w.get('text', ''),
                'fontname': w.get('fontname', ''),
                'size': float(w.get('size', 0)),
                'page': page_num,
            })

        rects = []
        for r in page.rects:
            rects.append({
                'type': 'rect',
                'x0': float(r['x0']), 'y0': float(r['y0']),
                'x1': float(r['x1']), 'y1': float(r['y1']),
                'fill': r.get('non_stroking_color') is not None,
                'stroke': r.get('stroking_color') is not None,
                'color': str(r.get('stroking_color', '#000000')),
                'width': float(r.get('stroke_width', 1)),
                'page': page_num,
            })

        lines = []
        for ln in page.lines:
            lines.append({
                'type': 'line',
                'x0': float(ln['x0']), 'y0': float(ln['y0']),
                'x1': float(ln['x1']), 'y1': float(ln['y1']),
                'stroke': ln.get('stroking_color') is not None,
                'color': str(ln.get('stroking_color', '#000000')),
                'width': float(ln.get('stroke_width', 1)),
                'page': page_num,
            })

        curves = []
        for cv in page.curves:
            curves.append({
                'type': 'curve',
                'x0': float(cv['x0']), 'y0': float(cv['y0']),
                'x1': float(cv['x1']), 'y1': float(cv['y1']),
                'points': [[float(p[0]), float(p[1])] for p in cv.get('points', [])],
                'stroke': cv.get('stroking_color') is not None,
                'page': page_num,
            })

        images = []
        for idx, img in enumerate(page.images):
            images.append({
                'type': 'image',
                'x0': float(img['x0']), 'y0': float(img['y0']),
                'x1': float(img['x1']), 'y1': float(img['y1']),
                'width': float(img.get('width', 0)),
                'height': float(img.get('height', 0)),
                'stream_id': f'p{page_num}_img_{idx}',
                'format': img.get('stream', '').get('any', img.get('srcsize', ''))
                           if isinstance(img.get('stream'), dict) else 'unknown',
                'page': page_num,
                '_stream_data': img.get('stream'),  # internal ref for get_image_data
            })

        tables = []
        for tbl in page.find_tables():
            bbox = tbl.bbox
            cells = []
            for row in tbl.cells:
                cells.append([cell.get('text', '') if isinstance(cell, dict) else str(cell) for cell in row])
            tables.append({
                'type': 'table',
                'x0': float(bbox[0]), 'y0': float(bbox[1]),
                'x1': float(bbox[2]), 'y1': float(bbox[3]),
                'rows': len(tbl.cells),
                'cols': len(tbl.cells[0]) if tbl.cells else 0,
                'cells': cells,
                'page': page_num,
            })

        # Remove _stream_data from images in the returned data
        clean_images = []
        for img in images:
            clean = {k: v for k, v in img.items() if k != '_stream_data'}
            clean_images.append(clean)

        return {
            'width': float(page.width),
            'height': float(page.height),
            'chars': chars,
            'words': words,
            'rects': rects,
            'lines': lines,
            'curves': curves,
            'images': clean_images,
            'tables': tables,
        }

    def get_image_data(self, stream_id: str) -> dict:
        """Extract image bytes by stream_id."""
        import re
        match = re.match(r'p(\d+)_img_(\d+)', stream_id)
        if not match:
            return {'error': f'Invalid stream_id: {stream_id}'}
        page_num = int(match.group(1))
        img_idx = int(match.group(2))

        page: Page = self._pdf.pages[page_num - 1]
        images = page.images
        if img_idx >= len(images):
            return {'error': f'Image index {img_idx} out of range'}

        img = images[img_idx]
        stream = img.get('stream')
        if stream is None:
            return {'error': 'No stream data available'}

        try:
            data = stream.get('data', b'')
            if isinstance(data, memoryview):
                data = bytes(data)
            elif not isinstance(data, bytes):
                data = b''
            b64 = base64.b64encode(data).decode('ascii')
            return {'base64': b64, 'format': img.get('srcsize', 'unknown')}
        except Exception as e:
            return {'error': str(e)}

    def close(self):
        self._pdf.close()
```

- [ ] **Step 3: Verify Python imports work (if pdfplumber installed)**

Run: `python3 -c "from sidecar.extractor import PdfExtractor; print('OK')"`
Expected: OK (or ModuleNotFoundError for pdfplumber — acceptable for now).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add pdfplumber extractor and LRU cache"
```

---

### Task 5: Main Process — Sidecar Manager + IPC Handlers

**Files:**
- Modify: `src/main/sidecar.ts` (Create)
- Modify: `src/main/ipc-handlers.ts` (Create)
- Modify: `src/main/index.ts` (Integrate handlers)

- [ ] **Step 1: Create `src/shared/constants.ts`**

```typescript
export const SIDECAR_SCRIPT = 'sidecar/main.py';
export const IPC_CHANNELS = {
  OPEN_PDF: 'pdf:open',
  EXTRACT_PAGE: 'pdf:extract-page',
  EXTRACT_METADATA: 'pdf:extract-metadata',
  GET_IMAGE_DATA: 'pdf:get-image-data',
  SIDECAR_STATUS: 'pdf:sidecar-status',
} as const;
```

- [ ] **Step 2: Create `src/main/sidecar.ts`**

```typescript
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { SIDECAR_SCRIPT } from '../shared/constants';

export interface SidecarRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface SidecarResponse {
  id: number;
  result?: unknown;
  error?: string;
}

export class SidecarManager {
  private process: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buffer = '';

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;

    // Resolve sidecar script path
    let scriptPath: string;
    if (fs.existsSync(path.join(__dirname, '../../sidecar/main.py'))) {
      scriptPath = path.join(__dirname, '../../sidecar/main.py');
    } else if (fs.existsSync(path.join(process.resourcesPath || '', 'sidecar/main.py'))) {
      scriptPath = path.join(process.resourcesPath || '', 'sidecar/main.py');
    } else {
      throw new Error('Cannot find sidecar/main.py');
    }

    return new Promise((resolve, reject) => {
      const proc = spawn('python3', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start sidecar: ${err.message}`));
      });

      proc.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        // Keep last incomplete line in buffer
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response: SidecarResponse = JSON.parse(line);
            const pending = this.pending.get(response.id);
            if (pending) {
              this.pending.delete(response.id);
              if (response.error) {
                pending.reject(new Error(response.error));
              } else {
                pending.resolve(response.result);
              }
            }
          } catch {
            // Malformed JSON line — ignore
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        console.error(`[sidecar] ${data.toString().trim()}`);
      });

      proc.on('exit', (code) => {
        console.log(`[sidecar] exited with code ${code}`);
        // Reject all pending requests
        for (const [id, { reject: rej }] of this.pending) {
          rej(new Error(`Sidecar exited with code ${code}`));
          this.pending.delete(id);
        }
        this.process = null;
      });

      this.process = proc;
      resolve();
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isRunning()) {
      throw new Error('Sidecar is not running');
    }

    const id = this.nextId++;
    const request: SidecarRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request "${method}" timed out after 30s`));
      }, 30000);

      // Wrap resolve/reject to clear timeout
      const originalReject = reject;
      const entry = this.pending.get(id)!;
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); entry.resolve(v); },
        reject: (e) => { clearTimeout(timeout); entry.reject(e); },
      });

      this.process?.stdin?.write(JSON.stringify(request) + '\n');
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning()) return;
    try {
      await this.send('shutdown');
    } catch {
      // Ignore errors during shutdown
    }
    this.process?.kill();
    this.process = null;
  }
}
```

- [ ] **Step 3: Create `src/main/ipc-handlers.ts`**

```typescript
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { SidecarManager } from './sidecar';
import { IPC_CHANNELS } from '../shared/constants';

export function registerIpcHandlers(sidecar: SidecarManager): void {
  ipcMain.handle(IPC_CHANNELS.OPEN_PDF, async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('No active window');

    const result = await dialog.showOpenDialog(win, {
      title: 'Open PDF',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    const meta = await sidecar.send('open', { path: filePath });
    return { canceled: false, path: filePath, metadata: meta };
  });

  ipcMain.handle(IPC_CHANNELS.EXTRACT_PAGE, async (_event, page: number) => {
    return sidecar.send('extract_page', { page });
  });

  ipcMain.handle(IPC_CHANNELS.EXTRACT_METADATA, async () => {
    return sidecar.send('extract_metadata');
  });

  ipcMain.handle(IPC_CHANNELS.GET_IMAGE_DATA, async (_event, streamId: string) => {
    return sidecar.send('get_image_data', { stream_id: streamId });
  });

  ipcMain.handle(IPC_CHANNELS.SIDECAR_STATUS, async () => {
    return { running: sidecar.isRunning() };
  });
}
```

- [ ] **Step 4: Update `src/main/index.ts` to integrate sidecar**

```typescript
import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { SidecarManager } from './sidecar';
import { registerIpcHandlers } from './ipc-handlers';

let mainWindow: BrowserWindow | null = null;
const sidecar = new SidecarManager();

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'PDF Inspector',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../index.html')); // compiled main is dist/main/index.js, Vite output is dist/index.html
  }
}

app.whenReady().then(async () => {
  registerIpcHandlers(sidecar);

  try {
    await sidecar.start();
    console.log('[main] Sidecar started');
  } catch (err) {
    console.error('[main] Failed to start sidecar:', err);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await sidecar.stop();
});
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add sidecar manager and IPC handlers"
```

---

### Task 6: Preload Bridge + Renderer IPC Client + Types

**Files:**
- Modify: `src/preload/index.ts`
- Create: `src/renderer/types/pdf-objects.ts`
- Create: `src/renderer/types/ipc-protocol.ts`
- Create: `src/renderer/services/ipc-client.ts`

- [ ] **Step 1: Create `src/renderer/types/pdf-objects.ts`**

```typescript
export type PdfObjectType = 'char' | 'word' | 'rect' | 'line' | 'curve' | 'image' | 'table';

export interface PdfBaseObject {
  type: PdfObjectType;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  page: number;
}

export interface PdfChar extends PdfBaseObject {
  type: 'char';
  text: string;
  fontname: string;
  size: number;
  color: string;
}

export interface PdfWord extends PdfBaseObject {
  type: 'word';
  text: string;
  fontname: string;
  size: number;
}

export interface PdfRect extends PdfBaseObject {
  type: 'rect';
  fill: boolean;
  stroke: boolean;
  color: string;
  width: number;
}

export interface PdfLine extends PdfBaseObject {
  type: 'line';
  stroke: boolean;
  color: string;
  width: number;
}

export interface PdfCurve extends PdfBaseObject {
  type: 'curve';
  points: number[][];
  stroke: boolean;
}

export interface PdfImage extends PdfBaseObject {
  type: 'image';
  width: number;
  height: number;
  stream_id: string;
  format: string;
}

export interface PdfTable extends PdfBaseObject {
  type: 'table';
  rows: number;
  cols: number;
  cells: string[][];
}

export type PdfObject = PdfChar | PdfWord | PdfRect | PdfLine | PdfCurve | PdfImage | PdfTable;

export interface PageData {
  width: number;
  height: number;
  chars: PdfChar[];
  words: PdfWord[];
  rects: PdfRect[];
  lines: PdfLine[];
  curves: PdfCurve[];
  images: PdfImage[];
  tables: PdfTable[];
}

export interface PdfMetadata {
  pages: number;
  version: string;
  encrypted: boolean;
  page_w: number;
  page_h: number;
  title: string;
  author: string;
  producer: string;
  fonts: string[];
}
```

- [ ] **Step 2: Create `src/renderer/types/ipc-protocol.ts`**

```typescript
import { PdfMetadata, PageData } from './pdf-objects';

export interface OpenPdfResult {
  canceled: true;
} | {
  canceled: false;
  path: string;
  metadata: PdfMetadata;
}

export interface IpcApi {
  openPdf(): Promise<OpenPdfResult>;
  extractPage(page: number): Promise<PageData>;
  extractMetadata(): Promise<PdfMetadata>;
  getImageData(streamId: string): Promise<{ base64?: string; format?: string; error?: string }>;
  getSidecarStatus(): Promise<{ running: boolean }>;
}
```

- [ ] **Step 3: Update `src/preload/index.ts`**

```typescript
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';

contextBridge.exposeInMainWorld('pdfInspector', {
  openPdf: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PDF),
  extractPage: (page: number) => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_PAGE, page),
  extractMetadata: () => ipcRenderer.invoke(IPC_CHANNELS.EXTRACT_METADATA),
  getImageData: (streamId: string) => ipcRenderer.invoke(IPC_CHANNELS.GET_IMAGE_DATA, streamId),
  getSidecarStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SIDECAR_STATUS),
});
```

- [ ] **Step 4: Create `src/renderer/services/ipc-client.ts`**

```typescript
import { IpcApi } from '../types/ipc-protocol';

declare global {
  interface Window {
    pdfInspector: IpcApi;
  }
}

export const ipc = {
  openPdf: () => window.pdfInspector.openPdf(),
  extractPage: (page: number) => window.pdfInspector.extractPage(page),
  extractMetadata: () => window.pdfInspector.extractMetadata(),
  getImageData: (streamId: string) => window.pdfInspector.getImageData(streamId),
  getSidecarStatus: () => window.pdfInspector.getSidecarStatus(),
};
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add preload bridge, IPC types, and renderer IPC client"
```

---

### Task 7: Zustand Store + React Entry

**Files:**
- Create: `src/renderer/store/pdf-store.ts`
- Create: `src/renderer/main.tsx`

- [ ] **Step 1: Create `src/renderer/store/pdf-store.ts`**

```typescript
import { create } from 'zustand';
import { PdfObject, PdfMetadata, PageData } from '../types/pdf-objects';

export interface PdfState {
  // File state
  filePath: string | null;
  metadata: PdfMetadata | null;
  pageCount: number;
  currentPage: number;
  zoom: number;

  // Data
  pageData: PageData | null;

  // Selection
  allObjects: PdfObject[];
  hoveredObject: PdfObject | null;
  selectedObject: PdfObject | null;

  // UI state
  overlayVisibility: Record<string, boolean>;
  isLoading: boolean;
  sidecarRunning: boolean;

  // Actions
  setFile: (path: string, meta: PdfMetadata) => void;
  setPage: (page: number) => void;
  setZoom: (zoom: number) => void;
  setPageData: (data: PageData) => void;
  setHoveredObject: (obj: PdfObject | null) => void;
  setSelectedObject: (obj: PdfObject | null) => void;
  toggleOverlay: (type: string) => void;
  setLoading: (loading: boolean) => void;
  setSidecarRunning: (running: boolean) => void;
  clearSelection: () => void;
}

export const usePdfStore = create<PdfState>((set, get) => ({
  filePath: null,
  metadata: null,
  pageCount: 0,
  currentPage: 1,
  zoom: 1.0,

  pageData: null,

  allObjects: [],
  hoveredObject: null,
  selectedObject: null,

  overlayVisibility: {
    char: true,
    word: true,
    rect: true,
    line: true,
    curve: true,
    image: true,
    table: true,
  },
  isLoading: false,
  sidecarRunning: false,

  setFile: (path, meta) =>
    set({
      filePath: path,
      metadata: meta,
      pageCount: meta.pages,
      currentPage: 1,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
    }),

  setPage: (page) => set({ currentPage: page, pageData: null, hoveredObject: null, selectedObject: null }),

  setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(5, zoom)) }),

  setPageData: (data) =>
    set({
      pageData: data,
      allObjects: [
        ...data.chars,
        ...data.words,
        ...data.rects,
        ...data.lines,
        ...data.curves,
        ...data.images,
        ...data.tables,
      ],
    }),

  setHoveredObject: (obj) => set({ hoveredObject: obj }),
  setSelectedObject: (obj) => set({ selectedObject: obj }),
  toggleOverlay: (type) =>
    set((state) => ({
      overlayVisibility: {
        ...state.overlayVisibility,
        [type]: !state.overlayVisibility[type],
      },
    })),

  setLoading: (loading) => set({ isLoading: loading }),
  setSidecarRunning: (running) => set({ sidecarRunning: running }),
  clearSelection: () => set({ hoveredObject: null, selectedObject: null }),
}));
```

- [ ] **Step 2: Create `src/renderer/main.tsx`**

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add zustand store and react entry point"
```

---

### Task 8: PDF Viewer (PDF.js Integration)

**Files:**
- Modify: `package.json` — ensure no `vite-plugin-static-copy` dependency exists
- Modify: `vite.config.ts` — remove `fs` import, remove `copyPdfWorker()` function, remove `copyPdfWorker()` from plugins array; keep `path` import for aliases
- Modify: `src/renderer/hooks/usePdf.ts` — replace static worker URL string with `new URL(... import.meta.url)` pattern; preserve stale-doc destroy guard
- Verify: `src/renderer/components/PdfViewport/PdfPage.tsx` — has no `pageData` selector (no changes needed)
- Already created: `src/renderer/components/PdfViewport/PdfViewport.tsx`, `PdfViewport.module.css`, `PdfPage.module.css` (no changes needed)

> **Context:** The manual `copyPdfWorker()` Vite plugin used `fs.copyFileSync` to copy the PDF.js worker to `dist/assets/` at build time. The `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` pattern in `usePdf.ts` is superior — Vite natively emits the worker as a separate chunk during bundling, no plugin needed. This task removes the manual-copy approach and switches to the `new URL()` pattern. No CDN, `?url` suffix, or `vite-plugin-static-copy` is used.

- [ ] **Step 1: Ensure `vite-plugin-static-copy` is absent from `package.json`**

Open `package.json`. Confirm the `devDependencies` section has **no** `vite-plugin-static-copy` entry. If it is present, remove that line.

**Expected content:**
```json
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "^28.3.0",
    "electron-builder": "^24.13.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vite-plugin-electron": "^0.28.0",
    "vitest": "^2.0.0"
  }
```

- [ ] **Step 2: Clean `vite.config.ts` — remove `fs` import, `copyPdfWorker()` function, and plugin reference**

Open `vite.config.ts`. Make three changes:

**2a. Remove the `fs` import (keep `path` for aliases):**

If your file currently has both `import fs from 'node:fs'` and `import path from 'node:path'`, delete the `fs` line.

**Before:**
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import fs from 'node:fs';
import path from 'node:path';
```

**After (only the `fs` line is removed):**
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import path from 'node:path';
```

**2b. Remove the entire `copyPdfWorker()` function definition:**

**Before (the function to delete):**
```typescript

function copyPdfWorker() {
  return {
    name: 'copy-pdfjs-worker',
    closeBundle() {
      const source = path.resolve(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
      const destinationDir = path.resolve(__dirname, 'dist/assets');
      fs.mkdirSync(destinationDir, { recursive: true });
      fs.copyFileSync(source, path.join(destinationDir, 'pdf.worker.min.mjs'));
    },
  };
}
```

**After:** (the entire function block is removed; the blank line before it is also removed)

**2c. Remove `copyPdfWorker()` from the `plugins` array:**

**Before (last line of the plugins array):**
```typescript
    ]),
    copyPdfWorker(),
  ],
```

**After:**
```typescript
    ]),
  ],
```

The final `vite.config.ts` after all three sub-steps must match this (the `import path` may use `'node:path'` or `'path'` — both work):

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(args) { args.startup(); },
        vite: {
          build: {
            outDir: 'dist/main',
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      },
      {
        entry: 'src/preload/index.ts',
        onstart(args) { args.reload(); },
        vite: {
          build: {
            outDir: 'dist/preload',
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      }
    ]),
  ],
  resolve: {
    alias: {
      '@main': path.resolve(__dirname, 'src/main'),
      '@preload': path.resolve(__dirname, 'src/preload'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    }
  },
  root: '.',
  base: './'
});
```

- [ ] **Step 3: Update `src/renderer/hooks/usePdf.ts` — replace static worker URL with `new URL(... import.meta.url)`**

Open `src/renderer/hooks/usePdf.ts`. Locate the worker source assignment at the top of the file.

**Before (lines 4–5):**
```typescript
// Set worker path
pdfjsLib.GlobalWorkerOptions.workerSrc = './assets/pdf.worker.min.mjs';
```

**After:**
```typescript
// Set worker path using Vite's native worker chunk emission
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();
```

> **Important:** This must be the **only** worker source strategy. No CDN fallback, no `?url` suffix, no manual copy plugin. The `new URL(... import.meta.url)` pattern tells Vite to emit the worker as a separate chunk automatically during bundling. It works correctly in both dev (Vite dev server serves the resolved chunk) and production (`electron .` loads the emitted chunk from `dist/assets/`).

- [ ] **Step 4: Verify stale-doc destroy guard is in `usePdf.ts`**

Open `src/renderer/hooks/usePdf.ts`. Confirm the stale-load bail-out guard already reads:

```typescript
      if (loadId !== loadIdRef.current) {
        doc.destroy(); // destroy stale document proxy to prevent memory leak
        return;
      }
```

If the code shows `if (loadId !== loadIdRef.current) return;` without `doc.destroy()`, update it to the block above. Otherwise, no edit needed.

- [ ] **Step 5: Verify `PdfPage.tsx` has no unused `pageData` selector**

Open `src/renderer/components/PdfViewport/PdfPage.tsx`. Confirm there is **no** line containing `usePdfStore((s) => s.pageData)`. The file should have only `const metadata = usePdfStore((s) => s.metadata);` for store subscriptions.

If a `pageData` line is found, delete it. Otherwise, no edit needed.

- [ ] **Step 6: Install dependencies + verify TypeScript + verify production build + verify source-level worker URL**

Run these commands in order:

```bash
npm install
```
Expected: No errors; `node_modules` has no `vite-plugin-static-copy`.

```bash
npx tsc --noEmit
```
Expected: No type errors. Exit code 0.

```bash
npm run build
```
Expected: Build succeeds, exit code 0.

```bash
test -f dist/index.html && echo "INDEX HTML FOUND" || echo "INDEX HTML MISSING"
```
Expected: Output `INDEX HTML FOUND`. (Confirms Vite output lands at `dist/index.html`, which matches the `loadFile` path in `src/main/index.ts`.)

```bash
node -e "const fs=require('fs'); const s=fs.readFileSync('src/renderer/hooks/usePdf.ts','utf8'); if (!s.includes(\"pdfjs-dist/build/pdf.worker.min.mjs\") || !s.includes('new URL(')) process.exit(1);" && echo "NEW URL STRATEGY CONFIRMED" || echo "NEW URL STRATEGY MISSING"
```
Expected: Output `NEW URL STRATEGY CONFIRMED`. (Confirms the file uses Vite-native worker chunk emission with the `new URL(... import.meta.url)` pattern — no CDN, no `?url` suffix, no manual copy plugin. Exit code 0.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "fix: support PDF worker in dev and production"
```

---

### Task 9: Overlay Canvas + HitTest

**Files:**
- Modify: `src/renderer/components/PdfViewport/OverlayCanvas.tsx`
- Modify: `src/renderer/hooks/useOverlay.ts`
- Modify: `src/renderer/components/PdfViewport/PdfPage.tsx`

- [ ] **Step 1: `src/renderer/hooks/useHitTest.ts`** — already exists, no changes needed

> This file already exists with the correct implementation. No changes required. Skip to Step 2.

```typescript
import { useCallback } from 'react';
import { PdfObject } from '../types/pdf-objects';

/**
 * Find the topmost object under a given screen coordinate.
 * Searches in reverse type priority: char > word > rect > line > curve > image > table.
 */
export function useHitTest() {
  const hitTest = useCallback((
    objects: PdfObject[],
    screenX: number,
    screenY: number,
    pdfWidth: number,
    pdfHeight: number,
    canvasWidth: number,
    canvasHeight: number,
  ): PdfObject | null => {
    // Convert screen coords to PDF coords (with y-flip)
    const pdfX = (screenX / canvasWidth) * pdfWidth;
    const pdfY = pdfHeight - (screenY / canvasHeight) * pdfHeight;

    // Priority order for hit testing
    const typePriority: Record<string, number> = {
      char: 0, word: 1, rect: 2, line: 3, curve: 4, image: 5, table: 6,
    };

    // Filter objects whose bbox contains the point
    const candidates = objects
      .filter((obj) => pdfX >= obj.x0 && pdfX <= obj.x1 && pdfY >= obj.y0 && pdfY <= obj.y1)
      .sort((a, b) => (typePriority[a.type] ?? 99) - (typePriority[b.type] ?? 99));

    return candidates[0] ?? null;
  }, []);

  return { hitTest };
}
```

- [ ] **Step 2: Modify `src/renderer/hooks/useOverlay.ts`**

> This file already exists. This step updates the label-rendering section: use a readable `11px sans-serif` font, set `textBaseline = 'top'`, and render the label at a safe top-left offset (`rectX + 2, rectY + 2`).

```typescript
import { useCallback } from 'react';
import { PdfObject } from '../types/pdf-objects';

const OVERLAY_COLORS: Record<string, string> = {
  char: 'rgba(80, 200, 80, 0.5)',
  word: 'rgba(80, 120, 255, 0.5)',
  rect: 'rgba(200, 100, 200, 0.5)',
  line: 'rgba(255, 80, 80, 0.6)',
  curve: 'rgba(255, 160, 50, 0.6)',
  image: 'rgba(80, 220, 220, 0.5)',
  table: 'rgba(80, 160, 255, 0.5)',
};

const LABEL_COLORS: Record<string, string> = {
  char: '#4ac84a',
  word: '#4a78ff',
  rect: '#c864c8',
  line: '#ff5050',
  curve: '#ffa032',
  image: '#4adcdc',
  table: '#4aa0ff',
};

export function useOverlay() {
  const drawOverlays = useCallback((
    ctx: CanvasRenderingContext2D,
    objects: PdfObject[],
    visibleTypes: Record<string, boolean>,
    pageWidth: number,
    pageHeight: number,
    pdfWidth: number,
    pdfHeight: number,
  ) => {
    ctx.clearRect(0, 0, pageWidth, pageHeight);

    const scaleX = pageWidth / pdfWidth;
    const scaleY = pageHeight / pdfHeight;

    // Flip Y: pdfplumber uses bottom-left, canvas uses top-left
    const toScreen = (x: number, y: number): [number, number] => [
      x * scaleX,
      (pdfHeight - y) * scaleY,
    ];

    for (const obj of objects) {
      if (!visibleTypes[obj.type]) continue;

      const [sx0, sy0] = toScreen(obj.x0, obj.y0);
      const [sx1, sy1] = toScreen(obj.x1, obj.y1);
      const color = OVERLAY_COLORS[obj.type] || 'rgba(255,255,0,0.3)';
      const labelColor = LABEL_COLORS[obj.type] || 'yellow';

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;

      if (obj.type === 'line') {
        ctx.beginPath();
        ctx.moveTo(sx0, sy0);
        ctx.lineTo(sx1, sy1);
        ctx.stroke();
      } else if (obj.type === 'curve' && 'points' in obj && obj.points.length > 0) {
        ctx.beginPath();
        const [startX, startY] = toScreen(obj.points[0][0], obj.points[0][1]);
        ctx.moveTo(startX, startY);
        for (let i = 1; i < obj.points.length; i++) {
          const [px, py] = toScreen(obj.points[i][0], obj.points[i][1]);
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      } else {
        // Rect, char, word, image, table — draw bbox
        const rectX = Math.min(sx0, sx1);
        const rectY = Math.min(sy0, sy1);
        const rectW = Math.abs(sx1 - sx0);
        const rectH = Math.abs(sy1 - sy0);
        ctx.strokeRect(rectX, rectY, rectW, rectH);

        // Label
        ctx.fillStyle = labelColor;
        ctx.font = '11px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(obj.type, rectX + 2, rectY + 2);
      }
    }
  }, []);

  return { drawOverlays };
}
```

- [ ] **Step 3: Modify `src/renderer/components/PdfViewport/OverlayCanvas.tsx`** — remove `zoom` from props interface and destructuring

> This file already exists. This step removes the unused `zoom` prop from `OverlayCanvasProps` and its destructuring, since the page dimensions already incorporate the zoom factor.

```typescript
import React, { useRef, useEffect, useCallback } from 'react';
import { usePdfStore } from '../../store/pdf-store';
import { useOverlay } from '../../hooks/useOverlay';
import { useHitTest } from '../../hooks/useHitTest';

interface OverlayCanvasProps {
  pageNum: number;
  pageWidth: number;
  pageHeight: number;
  pdfWidth: number;
  pdfHeight: number;
}

export const OverlayCanvas: React.FC<OverlayCanvasProps> = ({
  pageNum,
  pageWidth,
  pageHeight,
  pdfWidth,
  pdfHeight,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { drawOverlays } = useOverlay();
  const { hitTest } = useHitTest();

  const allObjects = usePdfStore((s) => s.allObjects);
  const pageData = usePdfStore((s) => s.pageData);
  const overlayVisibility = usePdfStore((s) => s.overlayVisibility);
  const setHoveredObject = usePdfStore((s) => s.setHoveredObject);
  const setSelectedObject = usePdfStore((s) => s.setSelectedObject);

  // Redraw when data changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pageData) return;
    canvas.width = pageWidth;
    canvas.height = pageHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawOverlays(ctx, allObjects, overlayVisibility, pageWidth, pageHeight, pdfWidth, pdfHeight);
  }, [allObjects, overlayVisibility, pageWidth, pageHeight, pdfWidth, pdfHeight, pageData, drawOverlays]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !pageData) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const obj = hitTest(allObjects, x, y, pdfWidth, pdfHeight, pageWidth, pageHeight);
    setHoveredObject(obj);
  }, [allObjects, pageData, pdfWidth, pdfHeight, pageWidth, pageHeight, hitTest, setHoveredObject]);

  const handleClick = useCallback(() => {
    const store = usePdfStore.getState();
    if (store.hoveredObject) {
      setSelectedObject(store.hoveredObject);
    }
  }, [setSelectedObject]);

  const handleMouseLeave = useCallback(() => {
    setHoveredObject(null);
  }, [setHoveredObject]);

  return (
    <canvas
      ref={canvasRef}
      className="overlay-canvas"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'auto',
        cursor: 'crosshair',
      }}
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      onMouseLeave={handleMouseLeave}
    />
  );
};
```

- [ ] **Step 4: Modify `src/renderer/components/PdfViewport/PdfPage.tsx` — remove `zoom={zoom}` from `<OverlayCanvas>` call site**

Open `src/renderer/components/PdfViewport/PdfPage.tsx`. Locate the `<OverlayCanvas>` JSX element and remove the `zoom={zoom}` prop. The page already passes `pageWidth` and `pageHeight` scaled by `zoom`, so the overlay canvas does not need a separate `zoom` prop.

**Before:**
```tsx
      <OverlayCanvas
        pageNum={pageNum}
        pageWidth={pageWidth}
        pageHeight={pageHeight}
        pdfWidth={metadata?.page_w || 612}
        pdfHeight={metadata?.page_h || 792}
        zoom={zoom}
      />
```

**After:**
```tsx
      <OverlayCanvas
        pageNum={pageNum}
        pageWidth={pageWidth}
        pageHeight={pageHeight}
        pdfWidth={metadata?.page_w || 612}
        pdfHeight={metadata?.page_h || 792}
      />
```

- [ ] **Step 5: Modify `src/renderer/components/PdfViewport/InspectorHighlight.tsx`**

```typescript
import React, { useMemo } from 'react';
import { usePdfStore } from '../../store/pdf-store';

interface InspectorHighlightProps {
  pageNum: number;
}

export const InspectorHighlight: React.FC<InspectorHighlightProps> = ({ pageNum }) => {
  const hoveredObject = usePdfStore((s) => s.hoveredObject);
  const selectedObject = usePdfStore((s) => s.selectedObject);
  const metadata = usePdfStore((s) => s.metadata);
  const zoom = usePdfStore((s) => s.zoom);

  const activeObject = hoveredObject || selectedObject;

  const style = useMemo(() => {
    if (!activeObject || activeObject.page !== pageNum || !metadata) return null;

    const pdfW = metadata.page_w || 612;
    const pdfH = metadata.page_h || 792;
    const scaleX = (pdfW * zoom) / pdfW;
    const scaleY = (pdfH * zoom) / pdfH;

    // Y-flip
    const screenY0 = (pdfH - activeObject.y1) * scaleY;
    const screenY1 = (pdfH - activeObject.y0) * scaleY;

    return {
      left: activeObject.x0 * scaleX,
      top: screenY0,
      width: (activeObject.x1 - activeObject.x0) * scaleX,
      height: screenY1 - screenY0,
    };
  }, [activeObject, pageNum, metadata, zoom]);

  if (!style) return null;

  const isSelected = selectedObject === activeObject && hoveredObject === null;
  const borderColor = isSelected ? '#FFD700' : '#FFEB3B';
  const bgColor = isSelected ? 'rgba(255, 215, 0, 0.15)' : 'rgba(255, 235, 59, 0.10)';

  return (
    <div
      style={{
        position: 'absolute',
        border: `2px solid ${borderColor}`,
        backgroundColor: bgColor,
        boxShadow: isSelected ? '0 0 8px rgba(255, 215, 0, 0.5)' : 'none',
        pointerEvents: 'none',
        zIndex: 100,
        borderRadius: 2,
        transition: 'all 0.05s ease',
        ...style,
      }}
    />
  );
};
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "fix: improve overlay label rendering"
```

---

### Task 10: Toolbar — Overlay Controls & Error Handling

**Files:**
- Modify: `src/renderer/store/pdf-store.ts` (add `error: string | null` field, `setError` action; clear error in `setFile` and `setPageData`)
- Modify: `src/renderer/components/Toolbar/Toolbar.tsx` (add `Curves` overlay toggle, integrate `setError`, add user-readable catch blocks, add `role="group"` to group divs)

**Prerequisite awareness:** The toolbar source files already exist on disk from an earlier pass. The plan modifies them in place rather than recreating them.

- [ ] **Step 1: Add `error` field and `setError` action to pdf-store.ts**

Open `src/renderer/store/pdf-store.ts`. Make **six** exact edits in order.

**1a. Add `error` field declaration to the `PdfState` interface.**

After the `sidecarRunning: boolean;` line (currently line 23), insert the error state section:

Before:
```typescript
  // UI state
  overlayVisibility: Record<string, boolean>;
  isLoading: boolean;
  sidecarRunning: boolean;

  // Actions
```
After:
```typescript
  // UI state
  overlayVisibility: Record<string, boolean>;
  isLoading: boolean;
  sidecarRunning: boolean;

  // Error state
  error: string | null;

  // Actions
```

**1b. Add `setError` action signature.**

After the `setSidecarRunning: (running: boolean) => void;` line (currently line 34), insert:

Before:
```typescript
  setSidecarRunning: (running: boolean) => void;
  clearSelection: () => void;
```
After:
```typescript
  setSidecarRunning: (running: boolean) => void;
  setError: (error: string | null) => void;
  clearSelection: () => void;
```

**1c. Initialize `error` to `null` in default state.**

After `sidecarRunning: false,` (currently line 61), insert:

Before:
```typescript
  isLoading: false,
  sidecarRunning: false,
```
After:
```typescript
  isLoading: false,
  sidecarRunning: false,
  error: null,
```

**1d. Add `setError` action implementation.**

After the `setSidecarRunning` implementation line (currently line 104), insert:

Before:
```typescript
  setSidecarRunning: (running) => set({ sidecarRunning: running }),
  clearSelection: () => set({ hoveredObject: null, selectedObject: null }),
```
After:
```typescript
  setSidecarRunning: (running) => set({ sidecarRunning: running }),
  setError: (error) => set({ error }),
  clearSelection: () => set({ hoveredObject: null, selectedObject: null }),
```

**1e. Clear `error` in `setFile`.**

Before:
```typescript
  setFile: (path, meta) =>
    set({
      filePath: path,
      metadata: meta,
      pageCount: meta.pages,
      currentPage: 1,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
    }),
```
After:
```typescript
  setFile: (path, meta) =>
    set({
      filePath: path,
      metadata: meta,
      pageCount: meta.pages,
      currentPage: 1,
      pageData: null,
      allObjects: [],
      hoveredObject: null,
      selectedObject: null,
      error: null,
    }),
```

**1f. Clear `error` in `setPageData` on successful data load.**

Before:
```typescript
  setPageData: (data) =>
    set({
      pageData: data,
      allObjects: [
```
After:
```typescript
  setPageData: (data) =>
    set({
      pageData: data,
      error: null,
      allObjects: [
```

- [ ] **Step 2: Modify `src/renderer/components/Toolbar/Toolbar.tsx`**

Open `src/renderer/components/Toolbar/Toolbar.tsx`. Make **five** exact edits in order.

**2a. Add `['Curves', 'curve']` to the `OVERLAYS` constant.**

Before:
```typescript
const OVERLAYS = [
  ['Chars', 'char'],
  ['Words', 'word'],
  ['Lines', 'line'],
  ['Rects', 'rect'],
  ['Tables', 'table'],
  ['Images', 'image'],
] as const;
```
After:
```typescript
const OVERLAYS = [
  ['Chars', 'char'],
  ['Words', 'word'],
  ['Lines', 'line'],
  ['Rects', 'rect'],
  ['Curves', 'curve'],
  ['Tables', 'table'],
  ['Images', 'image'],
] as const;
```

**2b. Add `setError` selector after `setLoading`.**

Before:
```typescript
  const setLoading = usePdfStore((state) => state.setLoading);
  const toggleOverlay = usePdfStore((state) => state.toggleOverlay);
```
After:
```typescript
  const setLoading = usePdfStore((state) => state.setLoading);
  const setError = usePdfStore((state) => state.setError);
  const toggleOverlay = usePdfStore((state) => state.toggleOverlay);
```

**2c. Add `setError(null)` and catch block with user-readable message to `handleOpen`.**

Before:
```typescript
  const handleOpen = useCallback(async () => {
    setLoading(true);
    try {
      const result = await ipc.openPdf();
      if (result.canceled) return;

      setFile(result.path, result.metadata);
      const pageData = await ipc.extractPage(1);
      setPageData(pageData);
    } finally {
      setLoading(false);
    }
  }, [setFile, setLoading, setPageData]);
```
After:
```typescript
  const handleOpen = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.openPdf();
      if (result.canceled) return;

      setFile(result.path, result.metadata);
      const pageData = await ipc.extractPage(1);
      setPageData(pageData);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to open PDF';
      setError(msg);
      console.error('Open failed:', err);
    } finally {
      setLoading(false);
    }
  }, [setFile, setLoading, setPageData, setError]);
```

**2d. Add `setError(null)` and catch block with user-readable message to `navigateToPage`.**

Before:
```typescript
  const navigateToPage = useCallback(async (page: number) => {
    if (page < 1 || page > pageCount) return;

    setLoading(true);
    try {
      setPage(page);
      const pageData = await ipc.extractPage(page);
      setPageData(pageData);
    } finally {
      setLoading(false);
    }
  }, [pageCount, setLoading, setPage, setPageData]);
```
After:
```typescript
  const navigateToPage = useCallback(async (page: number) => {
    if (page < 1 || page > pageCount) return;

    setLoading(true);
    setError(null);
    try {
      setPage(page);
      const pageData = await ipc.extractPage(page);
      setPageData(pageData);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load page';
      setError(msg);
      console.error('Page load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [pageCount, setLoading, setPage, setPageData, setError]);
```

**2e. Add `role="group"` to the three `<div className={styles.group}>` elements.**

Find each group div and add `role="group"`. There are three occurrences.

First group (line 66) — Page navigation:
Before:
```tsx
      <div className={styles.group} aria-label="Page navigation">
```
After:
```tsx
      <div className={styles.group} role="group" aria-label="Page navigation">
```

Second group (line 88) — Zoom controls:
Before:
```tsx
      <div className={styles.group} aria-label="Zoom controls">
```
After:
```tsx
      <div className={styles.group} role="group" aria-label="Zoom controls">
```

Third group (line 110) — Overlay visibility:
Before:
```tsx
      <div className={styles.group} aria-label="Overlay visibility">
```
After:
```tsx
      <div className={styles.group} role="group" aria-label="Overlay visibility">
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors. The new `setError` action has matching interface declaration and implementation; the `catch` blocks use `err: unknown` with an `instanceof` guard which is valid TypeScript.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "fix: improve toolbar overlay controls and error handling"
```

---

### Task 11: Structure Tree (Left Panel)

**Files:**
- Modify: `src/renderer/components/StructureTree/StructureTree.tsx`
- (No changes to: `src/renderer/components/StructureTree/StructureTree.module.css`)

- [ ] **Step 1: Rewrite `src/renderer/components/StructureTree/StructureTree.tsx`**

Replace the entire file with the version below. The key changes from the current code:

1. **Page click performs full async page load** — `navigateToPage` validates the target page, calls `setError(null)`, `setLoading(true)`, `setPage(page)`, `ipc.extractPage(page)`, `setPageData(data)`, catches errors with `console.error` + `setError(userMessage)`, and calls `setLoading(false)` in `finally`. This exactly matches Toolbar's `navigateToPage` behavior.

2. **Object cross-page click uses full async navigation before selection** — `handleObjectClick` checks if the object's page differs from `currentPage`. If so, it runs the same full loading cycle, then finds the matching object instance in the freshly loaded page data (by identity comparison) before calling `setSelectedObject`.

3. **Stable keys** — React keys are computed from `objectId(obj)` which uses the stable fields `type/page/x0/y0/x1/y1`, not array indices.

4. **Identity comparison** — `isSelected` uses `objectsMatch(selectedObject, object)` instead of reference equality (`===`), so selection survives re-fetching page data.

5. **Uses existing store error actions and ipc client** — imports `ipc`, `setLoading`, `setError`, and `useCallback`.

6. **Race protection via monotonic request ID** — A `useRef<number>(0)` tracks the latest navigation request. `navigateToPage` and `handleObjectClick` capture `++navReqId.current` before the async call. After `ipc.extractPage` resolves or rejects, only the latest request ID may call `setPageData`/`setError`/`setLoading` or select a fresh object. Earlier (stale) responses are silently dropped, preventing stale page data from overwriting a newer navigation.

```typescript
import React, { useCallback, useRef } from 'react';
import { ipc } from '../../services/ipc-client';
import { usePdfStore } from '../../store/pdf-store';
import { PdfObject, PdfObjectType } from '../../types/pdf-objects';
import styles from './StructureTree.module.css';

type ObjectGroup = {
  label: string;
  icon: string;
  objects: PdfObject[];
};

const MAX_WORDS = 50;

const formatCoordinate = (value: number): string => Math.round(value).toString();

const truncate = (value: string, maxLength = 36): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

const formatObjectLabel = (object: PdfObject): string => {
  if (object.type === 'word') return truncate(object.text);
  if (object.type === 'table') return `Table ${object.rows} × ${object.cols}`;
  if (object.type === 'image') return `Image ${object.width} × ${object.height}`;
  return `${object.type} (${formatCoordinate(object.x0)}, ${formatCoordinate(object.y0)})`;
};

const getVisibleObjects = (type: PdfObjectType, objects: PdfObject[]): PdfObject[] =>
  type === 'word' ? objects.slice(0, MAX_WORDS) : objects;

/** Stable identity string for a PdfObject, used for React keys and comparisons. */
function objectId(obj: PdfObject): string {
  return `${obj.type}-${obj.page}-${obj.x0}-${obj.y0}-${obj.x1}-${obj.y1}`;
}

/** Whether two PdfObject references represent the same logical object (by value identity). */
function objectsMatch(a: PdfObject, b: PdfObject): boolean {
  return a.type === b.type
    && a.page === b.page
    && a.x0 === b.x0
    && a.y0 === b.y0
    && a.x1 === b.x1
    && a.y1 === b.y1;
}

export const StructureTree: React.FC = () => {
  const filePath = usePdfStore((state) => state.filePath);
  const metadata = usePdfStore((state) => state.metadata);
  const pageCount = usePdfStore((state) => state.pageCount);
  const currentPage = usePdfStore((state) => state.currentPage);
  const pageData = usePdfStore((state) => state.pageData);
  const isLoading = usePdfStore((state) => state.isLoading);
  const selectedObject = usePdfStore((state) => state.selectedObject);
  const setPage = usePdfStore((state) => state.setPage);
  const setPageData = usePdfStore((state) => state.setPageData);
  const setLoading = usePdfStore((state) => state.setLoading);
  const setError = usePdfStore((state) => state.setError);
  const setSelectedObject = usePdfStore((state) => state.setSelectedObject);

  /** Monotonically increasing navigation request ID to prevent stale response races. */
  const navReqId = useRef(0);

  /** Full page navigation matching Toolbar's navigateToPage behavior. */
  const navigateToPage = useCallback(async (page: number) => {
    if (page < 1 || page > pageCount) return;
    const reqId = ++navReqId.current;

    setError(null);
    setLoading(true);
    try {
      setPage(page);
      const data = await ipc.extractPage(page);
      if (reqId !== navReqId.current) return; // stale: superseded by a newer request
      setPageData(data);
    } catch (err) {
      if (reqId !== navReqId.current) return; // stale: suppress error for superseded request
      console.error('Failed to load page:', err);
      setError(err instanceof Error ? err.message : 'Failed to load page');
    } finally {
      if (reqId !== navReqId.current) return; // stale: don't toggle loading for superseded request
      setLoading(false);
    }
  }, [pageCount, setError, setLoading, setPage, setPageData, navReqId]);

  const handleObjectClick = useCallback(async (object: PdfObject) => {
    if (object.page !== currentPage) {
      // Cross-page navigation: load target page first, then select the object
      const reqId = ++navReqId.current;
      setError(null);
      setLoading(true);
      try {
        setPage(object.page);
        const data = await ipc.extractPage(object.page);
        if (reqId !== navReqId.current) return; // stale: superseded by a newer request
        setPageData(data);
        // After data load, find the matching object instance in fresh data
        const all: PdfObject[] = [
          ...data.chars, ...data.words, ...data.rects,
          ...data.lines, ...data.curves, ...data.images, ...data.tables,
        ];
        const match = all.find((o) => objectsMatch(o, object));
        setSelectedObject(match ?? null);
      } catch (err) {
        if (reqId !== navReqId.current) return; // stale: suppress error for superseded request
        console.error('Failed to load page for object selection:', err);
        setError(err instanceof Error ? err.message : 'Failed to load page');
      } finally {
        if (reqId !== navReqId.current) return; // stale: don't toggle loading for superseded request
        setLoading(false);
      }
    } else {
      setSelectedObject(object);
    }
  }, [currentPage, setError, setLoading, setPage, setPageData, setSelectedObject, navReqId]);

  if (!filePath || !metadata || pageCount === 0) {
    return (
      <aside className={styles.panel} aria-label="Document structure">
        <h2 className={styles.title}>Structure</h2>
        <div className={styles.emptyState}>Open a PDF to view its structure.</div>
      </aside>
    );
  }

  const groups: ObjectGroup[] = pageData
    ? [
        { label: 'Words', icon: 'W', objects: pageData.words },
        { label: 'Rects', icon: '▭', objects: pageData.rects },
        { label: 'Lines', icon: '╱', objects: pageData.lines },
        { label: 'Curves', icon: '⌒', objects: pageData.curves },
        { label: 'Images', icon: '▧', objects: pageData.images },
        { label: 'Tables', icon: '▦', objects: pageData.tables },
      ]
    : [];

  return (
    <aside className={styles.panel} aria-label="Document structure">
      <h2 className={styles.title}>Structure</h2>
      <nav className={styles.tree} aria-label="PDF page structure">
        {Array.from({ length: pageCount }, (_, index) => {
          const pageNumber = index + 1;
          const isActive = pageNumber === currentPage;

          return (
            <div className={styles.page} key={pageNumber}>
              <button
                className={`${styles.pageButton} ${isActive ? styles.activePage : ''}`}
                type="button"
                onClick={() => navigateToPage(pageNumber)}
                disabled={isLoading}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className={styles.pageIcon}>▸</span>
                Page {pageNumber}
              </button>

              {isActive && pageData && (
                <div className={styles.groups}>
                  {groups.map((group) => {
                    const type = group.objects[0]?.type;
                    const visibleObjects = type ? getVisibleObjects(type, group.objects) : [];

                    return (
                      <section className={styles.group} key={group.label}>
                        <div className={styles.groupHeader}>
                          <span className={styles.groupIcon} aria-hidden="true">{group.icon}</span>
                          <span>{group.label}</span>
                          <span className={styles.count}>{group.objects.length}</span>
                        </div>
                        {visibleObjects.map((object) => {
                          const isSelected = selectedObject !== null && objectsMatch(selectedObject, object);
                          const label = formatObjectLabel(object);

                          return (
                            <button
                              className={`${styles.objectButton} ${isSelected ? styles.selectedObject : ''}`}
                              type="button"
                              key={objectId(object)}
                              onClick={() => handleObjectClick(object)}
                              disabled={isLoading}
                              title={label}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
};
```

- [ ] **Step 2: `src/renderer/components/StructureTree/StructureTree.module.css`** — no changes needed; the existing CSS already has matching class names (`.panel`, `.title`, `.tree`, `.pageButton`, `.objectButton`, `.selectedObject`, etc.).

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors. The `useRef<number>(0)` initial value `0` is valid for `MutableRefObject<number>`. `navReqId.current` is read as `number` — valid for `===` comparisons. The stale-guard early returns are at end of `try`, `catch`, and `finally` blocks; the `finally` block returns before `setLoading(false)` only on stale requests, while the latest request always reaches `setLoading(false)`. Inside `handleObjectClick`, the `objectsMatch` call in the then-block is only reached when the request is the latest, so the captured `object` reference is still valid. All `useCallback` deps include `navReqId` (stable ref — never changes, always safe in deps). The `objectId` and `objectsMatch` functions use only fields common to all `PdfObject` variants (`type`, `page`, `x0`, `y0`, `x1`, `y1`). The `ipc.extractPage` call returns `Promise<PageData>` whose arrays are spread into a `PdfObject[]` — valid because each element satisfies `PdfBaseObject`. All types resolve.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "fix: prevent stale structure tree page loads"
```

---

### Task 12: Inspector Panel (Right Panel)

**Files:**
- Create: `src/renderer/components/InspectorPanel/InspectorPanel.tsx`
- Create: `src/renderer/components/InspectorPanel/InspectorPanel.module.css`

- [ ] **Step 1: Create `src/renderer/components/InspectorPanel/InspectorPanel.tsx`**

```typescript
import React, { useMemo } from 'react';
import { usePdfStore } from '../../store/pdf-store';
import { PdfObject } from '../../types/pdf-objects';
import styles from './InspectorPanel.module.css';

const Section: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className={styles.section}>
    <div className={styles.sectionLabel}>{label}</div>
    {children}
  </div>
);

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className={styles.row}>
    <span className={styles.rowLabel}>{label}</span>
    <span className={styles.rowValue}>{value}</span>
  </div>
);

export const InspectorPanel: React.FC = () => {
  const selectedObject = usePdfStore((s) => s.selectedObject);
  const hoveredObject = usePdfStore((s) => s.hoveredObject);
  const obj = hoveredObject || selectedObject;

  const jsonText = useMemo(() => {
    if (!obj) return '';
    return JSON.stringify(obj, null, 2);
  }, [obj]);

  if (!obj) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>INSPECTOR</div>
        <div className={styles.empty}>
          Hover or click on an object<br />in the PDF viewport
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>INSPECTOR</div>

      <Section label="Object Type">
        <div className={styles.typeBadge} data-type={obj.type}>
          {obj.type}
        </div>
      </Section>

      {'text' in obj && obj.text && (
        <Section label="Content">
          <div className={styles.contentText}>{(obj as any).text}</div>
        </Section>
      )}

      <Section label="Position">
        <Row label="x0" value={obj.x0.toFixed(2)} />
        <Row label="y0" value={obj.y0.toFixed(2)} />
        <Row label="x1" value={obj.x1.toFixed(2)} />
        <Row label="y1" value={obj.y1.toFixed(2)} />
        <Row label="w" value={(obj.x1 - obj.x0).toFixed(2)} />
        <Row label="h" value={(obj.y1 - obj.y0).toFixed(2)} />
      </Section>

      {'fontname' in obj && (
        <Section label="Font">
          <Row label="name" value={(obj as any).fontname} />
          {'size' in obj && <Row label="size" value={`${(obj as any).size.toFixed(1)}pt`} />}
          {'color' in obj && (
            <div className={styles.colorRow}>
              <span className={styles.rowLabel}>color</span>
              <span className={styles.colorSwatch} style={{ backgroundColor: (obj as any).color }} />
              <span className={styles.rowValue}>{(obj as any).color}</span>
            </div>
          )}
        </Section>
      )}

      {'rows' in obj && (
        <Section label="Table">
          <Row label="rows" value={String((obj as any).rows)} />
          <Row label="cols" value={String((obj as any).cols)} />
        </Section>
      )}

      {'width' in obj && obj.type === 'image' && (
        <Section label="Image">
          <Row label="dimensions" value={`${Math.round((obj as any).width)}×${Math.round((obj as any).height)}`} />
          <Row label="format" value={(obj as any).format || 'unknown'} />
        </Section>
      )}

      <Section label="Page">
        <Row label="page" value={String(obj.page)} />
      </Section>

      <Section label="Raw JSON">
        <pre className={styles.jsonBlock}>{jsonText}</pre>
      </Section>
    </div>
  );
};
```

- [ ] **Step 2: Create `src/renderer/components/InspectorPanel/InspectorPanel.module.css`**

```css
.panel {
  width: 280px;
  background: #1e1e2e;
  border-left: 1px solid #333;
  overflow-y: auto;
  font-size: 13px;
}

.header {
  padding: 8px 12px;
  font-size: 11px;
  color: #666;
  border-bottom: 1px solid #333;
  letter-spacing: 1px;
  font-weight: bold;
}

.empty {
  padding: 40px 16px;
  color: #555;
  font-size: 12px;
  text-align: center;
  line-height: 1.6;
}

.section {
  padding: 10px 12px;
  border-bottom: 1px solid #2a2a3a;
}

.sectionLabel {
  font-size: 10px;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.typeBadge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: bold;
  text-transform: uppercase;
}

.typeBadge[data-type='char'] { background: #2a4a2a; color: #4c4; }
.typeBadge[data-type='word'] { background: #2a3a6a; color: #6af; }
.typeBadge[data-type='rect'] { background: #4a2a4a; color: #c6c; }
.typeBadge[data-type='line'] { background: #4a2a2a; color: #f66; }
.typeBadge[data-type='curve'] { background: #4a3a1a; color: #fa6; }
.typeBadge[data-type='image'] { background: #1a4a4a; color: #4dd; }
.typeBadge[data-type='table'] { background: #1a3a5a; color: #6af; }

.contentText {
  font-size: 18px;
  color: #eee;
  font-weight: bold;
  font-family: serif;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.rowLabel {
  font-size: 11px;
  color: #666;
  width: 40px;
  font-family: monospace;
}

.rowValue {
  font-size: 13px;
  color: #ccc;
  font-family: monospace;
}

.colorRow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}

.colorSwatch {
  width: 12px;
  height: 12px;
  border: 1px solid #555;
  border-radius: 2px;
}

.jsonBlock {
  background: #111;
  padding: 8px;
  border-radius: 4px;
  font-size: 10px;
  color: #8c8;
  line-height: 1.4;
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
  margin: 0;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add inspector panel with object property display"
```

---

### Task 13: App Shell + StatusBar + Integration

**Files:**
- Create: `src/renderer/App.tsx`
- Create: `src/renderer/App.module.css`
- Create: `src/renderer/components/StatusBar/StatusBar.tsx`
- Create: `src/renderer/components/StatusBar/StatusBar.module.css`

- [ ] **Step 1: Create `src/renderer/components/StatusBar/StatusBar.tsx`**

```typescript
import React from 'react';
import { usePdfStore } from '../../store/pdf-store';
import styles from './StatusBar.module.css';

export const StatusBar: React.FC = () => {
  const isLoading = usePdfStore((s) => s.isLoading);
  const filePath = usePdfStore((s) => s.filePath);
  const sidecarRunning = usePdfStore((s) => s.sidecarRunning);
  const currentPage = usePdfStore((s) => s.currentPage);
  const pageCount = usePdfStore((s) => s.pageCount);
  const allObjects = usePdfStore((s) => s.allObjects);

  return (
    <div className={styles.statusBar}>
      <div className={styles.left}>
        {isLoading && <span className={styles.loading}>Loading...</span>}
        {!isLoading && filePath && (
          <span className={styles.info}>
            Page {currentPage} / {pageCount} | {allObjects.length} objects
          </span>
        )}
      </div>
      <div className={styles.right}>
        <span className={`${styles.indicator} ${sidecarRunning ? styles.on : styles.off}`}>
          {sidecarRunning ? '● Sidecar' : '○ Sidecar'}
        </span>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Create `src/renderer/components/StatusBar/StatusBar.module.css`**

```css
.statusBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 12px;
  background: #1a1a2a;
  border-top: 1px solid #333;
  font-size: 11px;
  color: #666;
}

.left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.loading {
  color: #4a9;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.info {
  color: #888;
}

.indicator {
  display: flex;
  align-items: center;
  gap: 4px;
}

.on { color: #4c4; }
.off { color: #644; }
```

- [ ] **Step 3: Create `src/renderer/App.tsx`**

```typescript
import React, { useEffect } from 'react';
import { Toolbar } from './components/Toolbar/Toolbar';
import { StructureTree } from './components/StructureTree/StructureTree';
import { PdfViewport } from './components/PdfViewport/PdfViewport';
import { InspectorPanel } from './components/InspectorPanel/InspectorPanel';
import { StatusBar } from './components/StatusBar/StatusBar';
import { usePdfStore } from './store/pdf-store';
import { ipc } from './services/ipc-client';
import styles from './App.module.css';

const App: React.FC = () => {
  const setSidecarRunning = usePdfStore((s) => s.setSidecarRunning);

  useEffect(() => {
    // Poll sidecar status
    const interval = setInterval(async () => {
      try {
        const status = await ipc.getSidecarStatus();
        setSidecarRunning(status.running);
      } catch {
        setSidecarRunning(false);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [setSidecarRunning]);

  // Press Escape to clear selection
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        usePdfStore.getState().clearSelection();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className={styles.app}>
      <Toolbar />
      <div className={styles.main}>
        <StructureTree />
        <PdfViewport />
        <InspectorPanel />
      </div>
      <StatusBar />
    </div>
  );
};

export default App;
```

- [ ] **Step 4: Create `src/renderer/App.module.css`**

```css
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #1a1a2e;
  color: #ccc;
  overflow: hidden;
}

.main {
  display: flex;
  flex: 1;
  overflow: hidden;
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 6: Verify production build emits the PDF worker chunk**

With the real `App.tsx` shell now importing `PdfViewport` → `usePdf`, the build should include the PDF.js worker. Run these commands in order:

```bash
npm run build
```
Expected: Build succeeds, exit code 0.

```bash
test -f dist/index.html && echo "INDEX HTML FOUND" || echo "INDEX HTML MISSING"
```
Expected: Output `INDEX HTML FOUND`.

```bash
node -e "const fs=require('fs'); const files=fs.readdirSync('dist/assets'); if (!files.some((file) => file.includes('pdf.worker'))) process.exit(1);" && echo "PDF WORKER CHUNK EMITTED" || echo "PDF WORKER CHUNK NOT FOUND"
```
Expected: Output `PDF WORKER CHUNK EMITTED`. (The exact filename will be content-hashed, e.g., `pdf.worker.min-abc123.mjs` — confirms Vite processed the `new URL()` import now that the component tree references `usePdf`.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: add app shell, status bar, and main layout"
```

---

### Task 14: Harden Sidecar Readiness and Restart

**Context from earlier tasks:** `src/main/index.ts` already has `checkPythonAvailable()` and Python-availability dialog. `src/main/sidecar.ts` already has `autoRestartEnabled` + `enableAutoRestart()` + `restartPromise` + `restartAfterCrash()`. This task replaces the timing-based `restartPromise` guard with a boolean `restarting` guard + bounded delay, adds a Python-side ready signal that the SidecarManager waits on before resolving `start()`, and preserves intentional-stop disable.

**Rationale for each change:**

| Change | Problem it solves |
|---|---|
| Python emits `{"ready":true}` before stdin loop | Main process currently resolves `start()` on `proc.once('spawn', ...)` which fires before Python is ready to accept requests. A race exists where the first `send()` write to stdin arrives before Python enters the `for line in sys.stdin` loop and the line is silently lost. |
| `start()` resolves only after parsing ready signal | Guarantees the sidecar is fully initialized and its stdin loop is active before any `send()` call. |
| Boolean `restarting` guard + bounded delayed retry | `restartPromise` is a timing-dependent pattern — if the restart promise resolves instantly (or the previous promise reference is overwritten by re-entry), a crash loop could spin without delay. A simple `restarting: boolean` with a 500ms `setTimeout` caps retry rate and prevents CPU spin. |
| Preserve intentional-stop disable | `stop()` already sets `autoRestartEnabled = false` before sending `shutdown` — no code change needed; the restart logic already checks `autoRestartEnabled`. |

**Files:**
- Modify: `sidecar/main.py` (emit ready signal before stdin loop)
- Modify: `src/main/sidecar.ts` (ready-signal-aware start, boolean restarting guard, bounded delay)
- No changes to: `src/main/index.ts`, `src/main/ipc-handlers.ts`

- [ ] **Step 1: Add ready signal to `sidecar/main.py`**

Open `sidecar/main.py`. Locate the `main()` function. After the `extractor` and `cache` initialization (the two lines after `def main():`) and **before** the `for line in sys.stdin:` loop, insert the ready signal emission.

**Before (the beginning of `main()`):**
```python
def main():
    extractor: PdfExtractor | None = None
    cache = PageCache(max_pages=10)

    for line in sys.stdin:
```

**After:**
```python
def main():
    extractor: PdfExtractor | None = None
    cache = PageCache(max_pages=10)

    # Signal readiness to parent process — stdout must be flushed before stdin loop starts
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
```

> `json` is already imported at the top of `sidecar/main.py`. The ready signal is a single-line JSON object `{"ready": true}` (no `id` field), which the TypeScript sidecar manager will distinguish from normal JSON-RPC responses by the absence of an `id` field. The signal is emitted **after** the extractor and cache are initialized but before blocking on stdin, so the main process knows the sidecar is fully ready to accept requests.

- [ ] **Step 2: Replace entire `src/main/sidecar.ts` with ready-signal-aware version**

Open `src/main/sidecar.ts`. Replace the entire file content with the version below.

**Changes from current code:**
1. **Ready signal wait** — `start()` no longer resolves on `proc.once('spawn', ...)`. Instead, the stdout `data` handler checks each parsed JSON line for `response.ready === true` and resolves the start promise only when the ready signal arrives. A 10-second timeout rejects the start promise if no ready signal arrives.
2. **Boolean `restarting` guard** — `restartPromise` field and its `restartAfterCrash()`-scoped promise-comparison guard are replaced with a simple `restarting: boolean` field. The restart method sets `this.restarting = true`, schedules a `setTimeout(500ms)` for the actual `this.start()` call, and clears `restarting` in `finally`.
3. **`stop()` preserves intentional-stop disable** — already sets `autoRestartEnabled = false` before shutdown (no changes needed). The `exit` handler checks `autoRestartEnabled && code !== 0` which correctly skips restart when `stop()` was called.
4. **Normal response parsing intact** — the same `stdout.data` handler still processes normal JSON-RPC responses through the `this.pending` map after start settles. The ready-signal check is an additional early-return guard that only fires before start settles.

```typescript
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface SidecarRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface SidecarResponse {
  id: number;
  result?: unknown;
  error?: string;
}

export class SidecarManager {
  private process: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buffer = '';
  private autoRestartEnabled = true;
  /** True while a delayed restart is scheduled; prevents concurrent restart attempts. */
  private restarting = false;
  /** Delay before auto-restart to avoid CPU spin on rapid crash cycles. */
  private static readonly RESTART_DELAY_MS = 500;

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  enableAutoRestart(enabled: boolean): void {
    this.autoRestartEnabled = enabled;
  }

  /** Reject all in-flight requests with the given error. */
  private rejectPendingRequests(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  /**
   * Schedule a delayed restart. Uses a boolean guard (not a promise-reference
   * comparison) to prevent re-entry, and a bounded 500ms timeout to avoid
   * CPU-spin crash loops.
   */
  private restartAfterCrash(): void {
    if (!this.autoRestartEnabled || this.restarting || this.isRunning()) return;

    this.restarting = true;
    console.log('[sidecar] Auto-restarting in 500ms...');
    setTimeout(() => {
      // Double-check: stop() may have been called while the timeout was pending
      if (!this.autoRestartEnabled) {
        this.restarting = false;
        return;
      }
      this.start()
        .catch((err) => console.error('[sidecar] Restart failed:', err))
        .finally(() => {
          this.restarting = false;
        });
    }, SidecarManager.RESTART_DELAY_MS);
  }

  /**
   * Start the Python sidecar subprocess.
   *
   * The returned promise resolves only after the sidecar emits its one-time
   * JSON ready signal (`{"ready":true}`) on stdout — NOT at process spawn.
   * A 10-second timeout rejects the promise if the ready signal never arrives.
   */
  async start(): Promise<void> {
    if (this.isRunning()) return;

    // Resolve sidecar script path
    let scriptPath: string;
    if (fs.existsSync(path.join(__dirname, '../../sidecar/main.py'))) {
      scriptPath = path.join(__dirname, '../../sidecar/main.py');
    } else if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'sidecar/main.py'))) {
      scriptPath = path.join(process.resourcesPath, 'sidecar/main.py');
    } else {
      throw new Error('Cannot find sidecar/main.py');
    }

    return new Promise((resolve, reject) => {
      const proc = spawn('python3', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let startSettled = false;

      // Timeout: if ready signal not received within 10s, reject the start promise
      const readyTimeout = setTimeout(() => {
        if (!startSettled) {
          startSettled = true;
          reject(new Error('Sidecar ready signal timeout after 10s'));
        }
      }, 10000);

      /**
       * Settle the start promise exactly once.
       * Called either by the ready-signal check (success) or by `error`/`exit`
       * events (failure). Clears the ready timeout and sets `this.process`.
       */
      const settleStart = (err?: Error) => {
        if (startSettled) return;
        startSettled = true;
        clearTimeout(readyTimeout);
        if (err) {
          if (this.process === proc) this.process = null;
          reject(err);
        } else {
          this.process = proc;
          resolve();
        }
      };

      proc.on('error', (err) => {
        settleStart(new Error(`Failed to start sidecar: ${err.message}`));
      });

      proc.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        // Keep last incomplete line in buffer
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);

            // Ready signal check — before start settles, this is the only expected line
            if (parsed.ready === true) {
              settleStart();
              continue;
            }

            // Normal JSON-RPC response parsing (only triggers after start settles)
            const pending = this.pending.get(parsed.id);
            if (pending) {
              this.pending.delete(parsed.id);
              if (parsed.error) {
                pending.reject(new Error(parsed.error));
              } else {
                pending.resolve(parsed.result);
              }
            }
          } catch {
            // Malformed JSON line — ignore
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        console.error(`[sidecar] ${data.toString().trim()}`);
      });

      proc.on('exit', (code) => {
        clearTimeout(readyTimeout);
        console.log(`[sidecar] exited with code ${code}`);

        // If start hasn't settled yet, the process died before the ready signal
        if (!startSettled) {
          settleStart(new Error(`Sidecar exited with code ${code} before ready signal`));
        }

        this.rejectPendingRequests(new Error(`Sidecar exited with code ${code}`));
        if (this.process === proc) {
          this.process = null;
        }

        // Auto-restart unless shutdown was intentional (stop() sets autoRestartEnabled = false)
        if (this.autoRestartEnabled && code !== 0) {
          this.restartAfterCrash();
        }
      });
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isRunning()) {
      throw new Error('Sidecar is not running');
    }

    const id = this.nextId++;
    const request: SidecarRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request "${method}" timed out after 30s`));
      }, 30000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.process?.stdin?.write(JSON.stringify(request) + '\n');
    });
  }

  async stop(): Promise<void> {
    this.autoRestartEnabled = false;
    if (!this.isRunning()) return;
    try {
      await this.send('shutdown');
    } catch {
      // Ignore errors during shutdown
    }
    this.process?.kill();
    this.process = null;
  }
}
```

- [ ] **Step 3: Verify Python syntax and ready signal presence**

Run:

```bash
python3 -c "import ast; ast.parse(open('sidecar/main.py').read()); print('PYTHON OK')"
```

Expected: Output `PYTHON OK`.

```bash
python3 -c "
import ast, sys
tree = ast.parse(open('sidecar/main.py').read())
for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'dumps':
        for arg in node.args:
            if isinstance(arg, ast.Dict):
                for k in arg.keys:
                    # Accept both ast.Str (pre-3.8) and ast.Constant (3.8+)
                    key_text = None
                    if isinstance(k, ast.Str):
                        key_text = k.s
                    elif isinstance(k, ast.Constant) and isinstance(k.value, str):
                        key_text = k.value
                    if key_text == 'ready':
                        print('READY SIGNAL FOUND')
                        sys.exit(0)
print('READY SIGNAL MISSING')
sys.exit(1)
"
```

Expected: Output `READY SIGNAL FOUND`. (Confirms the `json.dumps({"ready": True})` call exists in the AST.)

- [ ] **Step 4: Verify TypeScript compiles**

Run:

```bash
npx tsc --noEmit
```

Expected: No type errors. Exit code 0.

- [ ] **Step 5: Verify ready-signal and restarting guard patterns in sidecar.ts**

Run these assertions to confirm the critical patterns are present:

```bash
node -e "
const fs=require('fs');
const s=fs.readFileSync('src/main/sidecar.ts','utf8');

// Check 1: ready-signal wait in start() — no proc.once('spawn') as resolver
if (s.includes(\"proc.once('spawn'\")) { process.exit(1); }

// Check 2: parsed.ready === true check present
if (!s.includes('parsed.ready === true')) { process.exit(2); }

// Check 3: settleStart function present
if (!s.includes('const settleStart')) { process.exit(3); }

// Check 4: 10-second ready timeout
if (!s.includes('10000')) { process.exit(4); }

// Check 5: restarting field declaration
if (!s.includes('private restarting = false')) { process.exit(5); }

// Check 6: RESTART_DELAY_MS constant
if (!s.includes('500')) { process.exit(6); }

// Check 7: restarting guard in restartAfterCrash
if (!s.includes('this.restarting')) { process.exit(7); }

// Check 8: setTimeout in restartAfterCrash (bounded delay)
if (!s.includes('setTimeout')) { process.exit(8); }

// Check 9: autoRestartEnabled still present
if (!s.includes('private autoRestartEnabled = true')) { process.exit(9); }

// Check 10: stop() sets autoRestartEnabled = false
if (!s.includes(\"this.autoRestartEnabled = false\")) { process.exit(10); }

// Check 11: no restartPromise field or restartAfterCrash that references it
if (s.includes('restartPromise')) { process.exit(11); }

// Check 12: inner autoRestartEnabled guard inside the setTimeout callback (prevents restart after stop())
if (!s.includes('// Double-check:')) { process.exit(12); }

console.log('ALL PATTERNS VERIFIED');
"
```

Expected: Output `ALL PATTERNS VERIFIED`. Exit code 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "fix: harden sidecar readiness and restart"
```

---

### Task 15: PDF.js TextLayer + Image Preview

**Files:**
- Modify: `src/renderer/components/PdfViewport/PdfPage.tsx`
- Create: `src/renderer/components/PdfViewport/TextLayer.tsx`
- Modify: `src/renderer/components/InspectorPanel/InspectorPanel.tsx`
- Modify: `sidecar/extractor.py`

- [ ] **Step 1: Create `src/renderer/components/PdfViewport/TextLayer.tsx`**

```typescript
import React, { useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

interface TextLayerProps {
  pageNum: number;
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  scale: number;
  width: number;
  height: number;
}

export const TextLayer: React.FC<TextLayerProps> = ({ pageNum, pdfDoc, scale, width, height }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pdfDoc || !containerRef.current) return;

    let cancelled = false;

    const renderText = async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale });

        // Clear previous content
        const container = containerRef.current!;
        container.innerHTML = '';

        // Simple text layer: create spans for each text item
        for (const item of textContent.items) {
          if (cancelled) return;
          const span = document.createElement('span');
          span.textContent = (item as any).str || ' ';
          span.style.position = 'absolute';
          span.style.left = ((item as any).transform[4] * scale) + 'px';
          span.style.top = ((item as any).transform[5] * scale) + 'px';
          span.style.fontSize = '1px'; // Hide text visually but keep it selectable

          // Actually we want text at the right position but transparent so overlay is visible
          span.style.color = 'transparent';
          span.style.pointerEvents = 'none';
          span.style.whiteSpace = 'pre';

          container.appendChild(span);
        }
      } catch (err) {
        console.error('Text layer render error:', err);
      }
    };

    renderText();

    return () => {
      cancelled = true;
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
  }, [pdfDoc, pageNum, scale]);

  return (
    <div
      ref={containerRef}
      className="pdf-text-layer"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        overflow: 'hidden',
        userSelect: 'text',
        cursor: 'text',
      }}
    />
  );
};
```

- [ ] **Step 2: Modify `PdfPage.tsx` to integrate TextLayer and expose pdfDoc**

Update `src/renderer/components/PdfViewport/PdfPage.tsx`:

```typescript
import React, { useRef, useEffect, useState } from 'react';
import { usePdf } from '../../hooks/usePdf';
import { usePdfStore } from '../../store/pdf-store';
import { OverlayCanvas } from './OverlayCanvas';
import { InspectorHighlight } from './InspectorHighlight';
import { TextLayer } from './TextLayer';
import styles from './PdfPage.module.css';

interface PdfPageProps {
  pageNum: number;
  isVisible: boolean;
  filePath: string;
  zoom: number;
}

export const PdfPage: React.FC<PdfPageProps> = ({ pageNum, isVisible, filePath, zoom }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { renderPage, loadPdf, pdfDoc } = usePdf();
  const pageData = usePdfStore((s) => s.pageData);
  const metadata = usePdfStore((s) => s.metadata);

  useEffect(() => {
    if (filePath) {
      loadPdf(`file://${filePath}`);
    }
  }, [filePath]);

  useEffect(() => {
    if (isVisible && canvasRef.current) {
      renderPage(pageNum, canvasRef.current, zoom);
    }
  }, [isVisible, pageNum, zoom, renderPage]);

  if (!isVisible) return null;

  const pageWidth = metadata?.page_w ? metadata.page_w * zoom : 612 * zoom;
  const pageHeight = metadata?.page_h ? metadata.page_h * zoom : 792 * zoom;

  return (
    <div className={styles.pageContainer} style={{ width: pageWidth, height: pageHeight }}>
      <canvas ref={canvasRef} className={styles.canvas} />
      <TextLayer
        pageNum={pageNum}
        pdfDoc={pdfDoc}
        scale={zoom}
        width={pageWidth}
        height={pageHeight}
      />
      <OverlayCanvas
        pageNum={pageNum}
        pageWidth={pageWidth}
        pageHeight={pageHeight}
        pdfWidth={metadata?.page_w || 612}
        pdfHeight={metadata?.page_h || 792}
        zoom={zoom}
      />
      <InspectorHighlight pageNum={pageNum} />
    </div>
  );
};
```

- [ ] **Step 3: Add image format detection to `sidecar/extractor.py`**

Open `sidecar/extractor.py`. Add a helper function at the top (after imports) and modify `get_image_data` to use it.

**3a. Add `_detect_image_format` helper after the imports:**

After the `import io` line (currently line 582), insert:

```python

# Image format detection from bytes magic signatures
_IMAGE_MAGIC: list[tuple[bytes, str]] = [
    (b'\x89PNG\r\n\x1a\n', 'png'),
    (b'\xff\xd8\xff',      'jpeg'),
    (b'GIF87a',            'gif'),
    (b'GIF89a',            'gif'),
    (b'RIFF',              'webp'),  # WEBP starts with RIFF header; confirm WEBP at offset 8
]


def _detect_image_format(data: bytes) -> str:
    """Return a stable format string ('png', 'jpeg', 'gif', 'webp')
    by inspecting bytes magic signatures.
    Falls back to 'jpeg' for unrecognised formats (JPEG is the most
    common embedded image in PDFs).
    """
    for magic, fmt in _IMAGE_MAGIC:
        if fmt == 'webp':
            # WEBP: file starts with RIFF....WEBP
            if data[:4] == magic and data[8:12] == b'WEBP':
                return fmt
        elif data[:len(magic)] == magic:
            return fmt
    return 'jpeg'
```

**3b. Update `get_image_data` to use the detected format:**

Locate the `try` block inside `get_image_data` (currently lines 747-755). Replace it:

Before:
```python
        try:
            data = stream.get('data', b'')
            if isinstance(data, memoryview):
                data = bytes(data)
            elif not isinstance(data, bytes):
                data = b''
            b64 = base64.b64encode(data).decode('ascii')
            return {'base64': b64, 'format': img.get('srcsize', 'unknown')}
        except Exception as e:
            return {'error': str(e)}
```

After:
```python
        try:
            data = stream.get('data', b'')
            if isinstance(data, memoryview):
                data = bytes(data)
            elif not isinstance(data, bytes):
                data = b''
            fmt = _detect_image_format(data)
            b64 = base64.b64encode(data).decode('ascii')
            return {'base64': b64, 'format': fmt}
        except Exception as e:
            return {'error': str(e)}
```

- [ ] **Step 4: Update image preview in InspectorPanel with MIME-safe types and `onError`**

Replace the existing image preview section in `src/renderer/components/InspectorPanel/InspectorPanel.tsx`.

**4a. Update imports at top:**

Before:
```typescript
import { ipc } from '../../services/ipc-client';
import { useState, useEffect } from 'react';
```

After:
```typescript
import { ipc } from '../../services/ipc-client';
import { useState, useEffect, useCallback } from 'react';
```

**4b. Replace the image preview state and effect block and JSX with the version below:**

Before (the full block from `const [imagePreview, setImagePreview] = useState...` through the JSX section):
```typescript
const [imagePreview, setImagePreview] = useState<string | null>(null);

// Add effect to load image preview when an image is selected
useEffect(() => {
  if (!obj || obj.type !== 'image') {
    setImagePreview(null);
    return;
  }
  const imgObj = obj as any;
  if (imgObj.stream_id) {
    setImagePreview('loading...');
    ipc.getImageData(imgObj.stream_id).then((data) => {
      if ('base64' in data && data.base64) {
        setImagePreview(`data:image/${data.format || 'png'};base64,${data.base64}`);
      } else {
        setImagePreview('(preview unavailable)');
      }
    }).catch(() => setImagePreview('(error loading)'));
  }
}, [obj]);

// Add after the existing Image section:
{'width' in obj && obj.type === 'image' && imagePreview && (
  <Section label="Preview">
    {imagePreview.startsWith('data:') ? (
      <img
        src={imagePreview}
        alt="Extracted image"
        style={{ maxWidth: '100%', maxHeight: 150, borderRadius: 4, marginTop: 4 }}
      />
    ) : (
      <div style={{ color: '#888', fontSize: 11 }}>{imagePreview}</div>
    )}
  </Section>
)}
```

After:
```typescript
const [imagePreview, setImagePreview] = useState<string | null>(null);

// Stable format → MIME subtype mapping (only known types)
const MIME_SUBTYPES: Record<string, string> = {
  png:  'image/png',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
};

/** Return the MIME subtype for a given format string; fall back to 'image/jpeg'. */
function toMimeSubtype(fmt: string | undefined): string {
  return MIME_SUBTYPES[fmt || ''] || 'image/jpeg';
}

// Add effect to load image preview when an image is selected
useEffect(() => {
  if (!obj || obj.type !== 'image') {
    setImagePreview(null);
    return;
  }
  const imgObj = obj as any;
  if (imgObj.stream_id) {
    setImagePreview('loading...');
    ipc.getImageData(imgObj.stream_id).then((data) => {
      if ('base64' in data && data.base64) {
        const mime = toMimeSubtype(data.format);
        setImagePreview(`data:${mime};base64,${data.base64}`);
      } else {
        setImagePreview('(preview unavailable)');
      }
    }).catch(() => setImagePreview('(error loading)'));
  }
}, [obj]);

const handleImageError = useCallback(() => {
  setImagePreview('(error loading)');
}, []);

// Add after the existing Image section:
{'width' in obj && obj.type === 'image' && imagePreview && (
  <Section label="Preview">
    {imagePreview.startsWith('data:') ? (
      <img
        src={imagePreview}
        alt="Extracted image"
        onError={handleImageError}
        style={{ maxWidth: '100%', maxHeight: 150, borderRadius: 4, marginTop: 4 }}
      />
    ) : (
      <div style={{ color: '#888', fontSize: 11 }}>{imagePreview}</div>
    )}
  </Section>
)}
```

- [ ] **Step 5: Verify Python syntax and TypeScript compile**

Run these commands in order:

```bash
python3 -c "import ast; ast.parse(open('sidecar/extractor.py').read()); print('PYTHON OK')"
```
Expected: Output `PYTHON OK`. (Confirms the new `_detect_image_format` function and updated `get_image_data` are syntactically valid.)

```bash
npx tsc --noEmit
```
Expected: No type errors. The `useCallback` import is valid, the `toMimeSubtype` function is a plain function (not a hook) so it doesn't violate rules of hooks, and `onError` is a valid HTML img event handler.

```bash
npm run build
```
Expected: Build succeeds, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "fix: detect image formats for preview"
```
