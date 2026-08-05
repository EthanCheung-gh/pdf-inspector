from typing import Optional
import base64
import re

import pdfplumber
from pdfplumber.page import Page


class PdfExtractor:
    """Wraps pdfplumber to extract page-level structured data."""

    @staticmethod
    def _detect_image_format(data: bytes) -> str:
        """Identify a supported image format from its byte signature."""
        if data.startswith(b'\x89PNG\r\n\x1a\n'):
            return 'png'
        if data.startswith(b'\xff\xd8\xff'):
            return 'jpeg'
        if data.startswith((b'GIF87a', b'GIF89a')):
            return 'gif'
        if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
            return 'webp'
        return 'jpeg'

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

    def analyze_fonts(self) -> dict:
        fonts: dict[str, dict] = {}
        for page_num, page in enumerate(self._pdf.pages, start=1):
            for c in page.chars:
                name = c.get('fontname', '')
                if not name:
                    continue
                entry = fonts.setdefault(name, {
                    'fontname': name, 'pages': [], 'charCount': 0,
                    'sizeMin': float(c.get('size', 0)), 'sizeMax': float(c.get('size', 0)),
                    'colors': [],
                })
                entry['charCount'] += 1
                entry['sizeMin'] = min(entry['sizeMin'], float(c.get('size', 0)))
                entry['sizeMax'] = max(entry['sizeMax'], float(c.get('size', 0)))
                color = str(c.get('stroking_color', '#000000')) or '#000000'
                if color not in entry['colors']:
                    entry['colors'].append(color)
                if page_num not in entry['pages']:
                    entry['pages'].append(page_num)
        return {'fonts': sorted(fonts.values(), key=lambda f: f['charCount'], reverse=True)}

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
            stream = img.get('stream')
            images.append({
                'type': 'image',
                'x0': float(img['x0']), 'y0': float(img['y0']),
                'x1': float(img['x1']), 'y1': float(img['y1']),
                'width': float(img.get('width', 0)),
                'height': float(img.get('height', 0)),
                'stream_id': f'p{page_num}_img_{idx}',
                'format': 'unknown',
                'page': page_num,
                '_stream_data': stream,
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

        # Strip internal _stream_data from returned images
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
            return {'base64': b64, 'format': self._detect_image_format(data)}
        except Exception as e:
            return {'error': str(e)}

    def close(self):
        self._pdf.close()
