from typing import Iterable, Optional
import base64
import hashlib
import re
from io import BytesIO

import pdfplumber
from pdfplumber.page import Page

# Image formats the renderer (Chromium) can display straight from a data: URL.
DIRECT_IMAGE_FORMATS = frozenset({'png', 'jpeg', 'gif', 'webp'})

# JPEG2000 codestream / JP2 container signatures.
_JPX_SIGNATURES = (b'\x00\x00\x00\x0cjP  \r\n\x87\n', b'\xff\x4f\xff\x51')
_JBIG2_SIGNATURE = b'\x97JB2\r\n\x1a\n'

# Subset tag reportlab/Acrobat prepend to an embedded font's BaseFont.
_SUBSET_PREFIX = re.compile(r'^[A-Z]{6}\+')

# The 14 fonts every conforming PDF reader must provide itself; a document may
# therefore reference them without embedding anything.
STANDARD_14_FONTS = frozenset({
    'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
    'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
    'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
    'Symbol', 'ZapfDingbats',
})

# Page boxes a PDF may carry, in the order the UI lists them.
PAGE_BOX_KEYS = (
    ('media', 'MediaBox'),
    ('crop', 'CropBox'),
    ('trim', 'TrimBox'),
    ('bleed', 'BleedBox'),
    ('art', 'ArtBox'),
)


class PdfExtractor:
    """Wraps pdfplumber to extract page-level structured data."""

    @staticmethod
    def _detect_image_format(data: bytes) -> Optional[str]:
        """Identify an image format from its byte signature.

        Returns a browser-renderable name for PNG/JPEG/GIF/WebP, 'jpx' or
        'jbig2' for JPEG2000/JBIG2 payloads (both PDF-native and not directly
        renderable), and None when the signature is unknown.
        """
        if data.startswith(b'\x89PNG\r\n\x1a\n'):
            return 'png'
        if data.startswith(b'\xff\xd8\xff'):
            return 'jpeg'
        if data.startswith((b'GIF87a', b'GIF89a')):
            return 'gif'
        if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
            return 'webp'
        if data.startswith(_JPX_SIGNATURES):
            return 'jpx'
        if data.startswith(_JBIG2_SIGNATURE):
            return 'jbig2'
        return None

    @staticmethod
    def _transcode_to_png(data: bytes) -> Optional[bytes]:
        """Re-encode anything Pillow can decode as PNG; None if that is impossible."""
        try:
            from PIL import Image
        except Exception:
            return None
        try:
            with Image.open(BytesIO(data)) as image:
                if image.mode not in ('1', 'L', 'LA', 'P', 'RGB', 'RGBA'):
                    # CMYK, I;16, F, ... have no direct PNG equivalent.
                    image = image.convert('RGBA' if 'A' in image.mode else 'RGB')
                out = BytesIO()
                image.save(out, format='PNG')
                return out.getvalue()
        except Exception:
            return None

    @staticmethod
    def _word_y_range(
        word: dict,
        page_height: float,
        mediabox_top: float,
    ) -> tuple[float, float]:
        """Return a word's (y0, y1) in the same PDF-space coords as page.chars.

        pdfplumber's WordExtractor only reports top/bottom, derived from the char
        boxes as ``top = page.height - y1 + mediabox_top`` and
        ``bottom = page.height - y0 + mediabox_top`` (Page.process_object). The
        inverse therefore has to add the MediaBox vertical origin back, otherwise
        words are displaced by |mediabox_top| relative to chars/rects/lines on
        pages whose MediaBox does not start at y = 0.
        """
        y0 = word.get('y0')
        y1 = word.get('y1')
        if y0 is None:
            y0 = page_height + mediabox_top - float(word['bottom'])
        if y1 is None:
            y1 = page_height + mediabox_top - float(word['top'])
        return float(y0), float(y1)

    @classmethod
    def _encode_for_preview(cls, data: bytes) -> dict:
        """Build the {'base64', 'format'} payload the renderer can display.

        Directly renderable formats pass through untouched; every other format
        is transcoded to PNG; payloads that cannot be decoded yield {'error'}.
        """
        fmt = cls._detect_image_format(data)
        if fmt in DIRECT_IMAGE_FORMATS:
            return {'base64': base64.b64encode(data).decode('ascii'), 'format': fmt}

        png = cls._transcode_to_png(data)
        if png is not None:
            return {'base64': base64.b64encode(png).decode('ascii'), 'format': 'png'}

        return {'error': f'Unsupported image format: {fmt or "unknown"}'}

    @staticmethod
    def _image_content_hash(stream) -> Optional[str]:
        """SHA-256 of an image XObject's decoded bytes, or None.

        Used by the diff engine to tell "the same picture moved" from "the
        picture changed". A stream that cannot be decoded must not fail page
        extraction, so every failure path returns None.
        """
        if stream is None:
            return None
        try:
            data = stream.get('data') if hasattr(stream, 'get') else None
            if not isinstance(data, (bytes, bytearray, memoryview)):
                # pdfminer's PDFStream exposes the decoded payload via get_data().
                data = stream.get_data()
            if isinstance(data, (bytearray, memoryview)):
                data = bytes(data)
            if not isinstance(data, bytes):
                return None
            return hashlib.sha256(data).hexdigest()
        except Exception:
            return None

    @staticmethod
    def _resolve_pdf_value(value):
        """Follow a pdfminer PDFObjRef (or any ``.resolve()`` wrapper) to its target.

        Returns None when resolution fails so callers can skip a broken object
        instead of failing the whole request.
        """
        resolve = getattr(value, 'resolve', None)
        if callable(resolve):
            try:
                return resolve()
            except Exception:
                return None
        return value

    @classmethod
    def _name_text(cls, value) -> Optional[str]:
        """Return a resolved PDF name/string object as plain text, or None.

        pdfminer represents names as PSLiteral, so ``.name`` is the reliable
        accessor; ``str(PSLiteral('Helvetica'))`` is ``"/'Helvetica'"`` and is
        only used as a last-resort fallback.
        """
        value = cls._resolve_pdf_value(value)
        if value is None:
            return None

        name = getattr(value, 'name', None)
        if isinstance(name, bytes):
            name = name.decode('latin-1', 'replace')
        if isinstance(name, str) and name:
            return name
        if isinstance(value, bytes):
            text = value.decode('latin-1', 'replace').strip()
            return text or None
        if isinstance(value, str):
            return value or None

        try:
            text = str(value).strip()
        except Exception:
            return None
        # PSLiteral fallback form: "/'Helvetica'" -> "Helvetica".
        if text.startswith('/'):
            text = text[1:]
        text = text.strip().strip("'").strip()
        return text or None

    @classmethod
    def _base_font_name(cls, font_obj) -> Optional[str]:
        """Return a font dictionary's BaseFont as a plain string, or None."""
        getter = getattr(font_obj, 'get', None)
        if not callable(getter):
            return None
        try:
            return cls._name_text(getter('BaseFont'))
        except Exception:
            return None

    @classmethod
    def _font_descriptor(cls, font_obj) -> tuple[Optional[dict], bool]:
        """Find the FontDescriptor of a simple font or of a Type0 descendant.

        Returns ``(descriptor, resolved)``. ``resolved`` is False when the
        document does point at a descriptor but it cannot be read (broken
        reference), which the caller reports as ``unknown`` instead of guessing
        "not embedded".
        """
        candidates = []
        unresolved = False
        getter = getattr(font_obj, 'get', None)
        if callable(getter):
            own = getter('FontDescriptor')
            if own is not None:
                candidates.append(own)
            descendants = cls._resolve_pdf_value(getter('DescendantFonts'))
            if isinstance(descendants, dict):
                # Malformed but seen in the wild: a single descendant, not an array.
                descendants = [descendants]
            if isinstance(descendants, (list, tuple)):
                for descendant in descendants:
                    resolved = cls._resolve_pdf_value(descendant)
                    if not isinstance(resolved, dict):
                        # The descendant (and its descriptor) cannot be read.
                        unresolved = True
                        continue
                    descendant_descriptor = resolved.get('FontDescriptor')
                    if descendant_descriptor is not None:
                        candidates.append(descendant_descriptor)

        for candidate in candidates:
            descriptor = cls._resolve_pdf_value(candidate)
            if isinstance(descriptor, dict):
                return descriptor, True
        return None, not candidates and not unresolved

    @classmethod
    def _font_file_type(cls, descriptor) -> Optional[str]:
        """Classify the embedded font program of a descriptor, if any.

        ``/FontFile`` holds a Type1 program, ``/FontFile2`` a TrueType one and
        ``/FontFile3`` a CFF/OpenType one whose exact flavour is in its
        ``/Subtype``. FontFile3 is CFF-flavoured when the subtype is unknown, so
        that is the fallback rather than None.
        """
        if not isinstance(descriptor, dict):
            return None
        try:
            if descriptor.get('FontFile2') is not None:
                return 'TrueType'
            font_file3 = descriptor.get('FontFile3')
            if font_file3 is not None:
                stream = cls._resolve_pdf_value(font_file3)
                # pdfminer's PDFStream is not a dict; its attributes are in .attrs.
                stream_attrs = getattr(stream, 'attrs', stream)
                subtype = None
                stream_get = getattr(stream_attrs, 'get', None)
                if callable(stream_get):
                    subtype = cls._name_text(stream_get('Subtype'))
                if subtype == 'OpenType':
                    return 'OpenType'
                return 'CFF'
            if descriptor.get('FontFile') is not None:
                return 'Type1'
        except Exception:
            return None
        return None

    @classmethod
    def _font_encoding(cls, font_obj) -> Optional[str]:
        """Return the font's encoding name: literal, or a dictionary's BaseEncoding."""
        getter = getattr(font_obj, 'get', None)
        if not callable(getter):
            return None
        try:
            encoding = cls._resolve_pdf_value(getter('Encoding'))
            if isinstance(encoding, dict):
                return cls._name_text(encoding.get('BaseEncoding'))
            return cls._name_text(encoding)
        except Exception:
            return None

    @classmethod
    def _font_info(cls, font_obj) -> Optional[dict]:
        """Build one ``FontInfo`` entry from a font resource dictionary.

        Never raises for a malformed font: unreadable descriptors degrade to
        ``embedding: 'unknown'`` and a font without a BaseFont yields None.
        """
        name = cls._base_font_name(font_obj)
        if not name:
            return None

        descriptor, descriptor_resolved = cls._font_descriptor(font_obj)
        font_file_type = cls._font_file_type(descriptor)
        embedded = font_file_type is not None

        if embedded:
            embedding = 'embedded'
        elif not descriptor_resolved:
            # A descriptor exists but cannot be read: do not claim "not embedded".
            embedding = 'unknown'
        elif descriptor is None and name in STANDARD_14_FONTS:
            embedding = 'standard14'
        else:
            embedding = 'not-embedded'

        getter = getattr(font_obj, 'get', None)
        subtype = None
        has_to_unicode = False
        if callable(getter):
            try:
                subtype = cls._name_text(getter('Subtype'))
            except Exception:
                subtype = None
            try:
                has_to_unicode = cls._resolve_pdf_value(getter('ToUnicode')) is not None
            except Exception:
                has_to_unicode = False

        return {
            'fontname': name,
            'subtype': subtype,
            'embedded': embedded,
            'embedding': embedding,
            'subset': bool(_SUBSET_PREFIX.match(name)),
            'encoding': cls._font_encoding(font_obj),
            'hasToUnicode': has_to_unicode,
            'fontFileType': font_file_type,
        }

    def _iter_font_dicts(self):
        """Yield every resolvable font dictionary referenced by page resources.

        This is the single traversal shared by the name and the detail scans, so
        both see exactly the same fonts with the same per-page/per-font
        exception protection. Walking ``page.chars`` instead would require full
        text layout of every page, which times out on large PDFs.
        """
        for page in self._pdf.pages:
            try:
                page_obj = getattr(page, 'page_obj', None)
                resources = self._resolve_pdf_value(getattr(page_obj, 'resources', None))
                if not isinstance(resources, dict):
                    continue
                font_resources = self._resolve_pdf_value(resources.get('Font'))
                if not isinstance(font_resources, dict):
                    continue
                for font_ref in list(font_resources.values()):
                    try:
                        font_obj = self._resolve_pdf_value(font_ref)
                    except Exception:
                        continue
                    if isinstance(font_obj, dict):
                        yield font_obj
            except Exception:
                # A malformed page (or resources accessor) must not break metadata.
                continue

    def _collect_font_names(self) -> list[str]:
        """Collect BaseFont names from page font resources, without page layout.

        Any per-page or per-font failure is skipped: metadata must never fail
        because of one malformed font resource.
        """
        names: set[str] = set()
        for font_obj in self._iter_font_dicts():
            try:
                name = self._base_font_name(font_obj)
            except Exception:
                continue
            if name:
                names.add(name)
        return sorted(names)

    def _collect_font_info(self) -> list[dict]:
        """Font embedding details, deduplicated by fontname and cached.

        Reads only resource dictionaries (see ``_iter_font_dicts``), so metadata
        stays cheap. The first occurrence of a fontname wins; a font that cannot
        be described at all is skipped rather than reported half-way.
        """
        cache = getattr(self, '_font_info_cache', None)
        if cache is None:
            info_by_name: dict[str, dict] = {}
            for font_obj in self._iter_font_dicts():
                try:
                    info = self._font_info(font_obj)
                except Exception:
                    continue
                if not info:
                    continue
                info_by_name.setdefault(info['fontname'], info)
            cache = [info_by_name[name] for name in sorted(info_by_name)]
            self._font_info_cache = cache
        # Hand out copies so a caller cannot mutate the cached document state.
        return [dict(entry) for entry in cache]

    def __init__(self, path: str, password: Optional[str] = None):
        self._path = path
        self._password = password
        self._pdf = pdfplumber.open(path, password=password)
        # analyze_fonts() needs a full char walk; memoize it for the document.
        self._font_stats_cache: Optional[dict] = None
        # get_metadata() scans font resources once and reuses the result.
        self._font_info_cache: Optional[list[dict]] = None

    def get_metadata(self) -> dict:
        doc = self._pdf.metadata
        return {
            'pages': len(self._pdf.pages),
            'version': self._pdf.pdf_version if hasattr(self._pdf, 'pdf_version') else 'unknown',
            'encrypted': self._pdf.is_encrypted if hasattr(self._pdf, 'is_encrypted') else False,
            'page_w': float(self._pdf.pages[0].width) if self._pdf.pages else 0,
            'page_h': float(self._pdf.pages[0].height) if self._pdf.pages else 0,
            'title': doc.get('Title', ''),
            'author': doc.get('Author', ''),
            'producer': doc.get('Producer', ''),
            'fonts': self._collect_font_names(),
            'fontInfo': self._collect_font_info(),
        }

    def analyze_fonts(
        self,
        start_page: Optional[int] = None,
        end_page: Optional[int] = None,
    ) -> dict:
        """Character-level font statistics for the whole document or a page range.

        With no page arguments this keeps the original behaviour: one full-document
        walk, memoized in ``_font_stats_cache``. A page range (1-based, inclusive)
        is computed on demand and never reads or populates that cache, so the
        renderer can request small batches without forcing a full-document walk
        (and without blocking the next sidecar request on one).
        """
        if start_page is None and end_page is None:
            if self._font_stats_cache is None:
                self._font_stats_cache = self._compute_font_stats()
            return self._font_stats_cache
        return self._compute_font_stats(start_page, end_page)

    def _validate_page_range(
        self,
        start_page: Optional[int],
        end_page: Optional[int],
    ) -> tuple[int, int]:
        """Resolve a partially specified 1-based, inclusive page range.

        ``None`` on either side falls back to the document bounds, so one-sided
        ranges are allowed. Raises ValueError for non-integer bounds (bool is not
        accepted as an int) and for ranges outside ``1..len(pages)``.
        """
        total = len(self._pdf.pages)
        for value in (start_page, end_page):
            if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
                raise ValueError(
                    f'Invalid page range: {start_page!r}-{end_page!r} '
                    f'(page numbers must be integers, document has {total} pages)'
                )
        start = 1 if start_page is None else start_page
        end = total if end_page is None else end_page
        if not (1 <= start <= end <= total):
            raise ValueError(
                f'Invalid page range: {start}-{end} (document has {total} pages)'
            )
        return start, end

    @staticmethod
    def _accumulate_font_stats(fonts: dict[str, dict], page, page_num: int) -> None:
        """Fold one page's chars into ``fonts``; the single per-char implementation.

        Both the full-document and the page-range analyses go through here, so a
        batch's numbers are defined exactly like the full walk's: charCount summed,
        sizeMin/sizeMax extended, colors kept in first-seen order (deduplicated),
        pages kept in first-seen ascending order.
        """
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

    def _compute_font_stats(
        self,
        start_page: Optional[int] = None,
        end_page: Optional[int] = None,
    ) -> dict:
        """Font statistics for pages ``start_page..end_page`` inclusive.

        Both bounds ``None`` means the whole document (the cached full walk); an
        empty document therefore yields ``{'fonts': []}``.
        """
        pages = self._pdf.pages
        if start_page is None and end_page is None:
            first, last = 1, len(pages)
        else:
            first, last = self._validate_page_range(start_page, end_page)

        fonts: dict[str, dict] = {}
        for page_num in range(first, last + 1):
            self._accumulate_font_stats(fonts, pages[page_num - 1], page_num)
        return {'fonts': sorted(fonts.values(), key=lambda f: f['charCount'], reverse=True)}

    # --- page geometry -----------------------------------------------------

    @classmethod
    def _normalize_box(cls, raw) -> Optional[dict]:
        """Turn a PDF rectangle array into a ``PageBox``, or None when unusable.

        Corners are ordered so renderers can assume ``x0 <= x1`` / ``y0 <= y1``;
        the values themselves are the raw PDF points, never adjusted.
        """
        raw = cls._resolve_pdf_value(raw)
        if not isinstance(raw, (list, tuple)) or len(raw) != 4:
            return None
        try:
            values = [float(cls._resolve_pdf_value(value)) for value in raw]
        except (TypeError, ValueError):
            return None
        x0, y0, x1, y1 = values
        return {
            'x0': min(x0, x1), 'y0': min(y0, y1),
            'x1': max(x0, x1), 'y1': max(y0, y1),
        }

    @classmethod
    def _page_rotation(cls, attrs: dict) -> int:
        """Read ``/Rotate`` and normalize it to 0/90/180/270.

        ``/Rotate`` is often an indirect object (``/Rotate 5 0 R``), so the
        reference is resolved before the numeric conversion. Non-multiples of 90
        (and unreadable values) are reported as 0: the renderer cannot express
        them, and guessing would misplace every overlay.
        """
        raw = cls._resolve_pdf_value(attrs.get('Rotate'))
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return 0
        value %= 360
        return value if value in (0, 90, 180, 270) else 0

    @classmethod
    def _page_geometry(cls, page) -> dict:
        """Page rotation plus the five page boxes, read from the page dictionary.

        The values are the raw, unrotated PDF attributes (what other tools show
        in a preflight report), while ``PageData.width/height`` keep following
        pdfplumber's rotation-aware page size. Missing boxes stay None; MediaBox
        is mandatory in PDF, so a document that omits it gets a derived fallback
        instead of a null.
        """
        page_obj = getattr(page, 'page_obj', None)
        attrs = cls._resolve_pdf_value(getattr(page_obj, 'attrs', None))
        if not isinstance(attrs, dict):
            attrs = {}

        rotation = cls._page_rotation(attrs)

        boxes: dict[str, Optional[dict]] = {}
        for key, attr_name in PAGE_BOX_KEYS:
            try:
                boxes[key] = cls._normalize_box(attrs.get(attr_name))
            except Exception:
                boxes[key] = None

        if boxes.get('media') is None:
            width = float(getattr(page, 'width', 0) or 0)
            height = float(getattr(page, 'height', 0) or 0)
            if rotation in (90, 270):
                # pdfplumber already swapped width/height for the rotation.
                width, height = height, width
            boxes['media'] = {'x0': 0.0, 'y0': 0.0, 'x1': width, 'y1': height}

        return {
            'rotation': rotation,
            'boxes': {
                'media': boxes['media'],
                'crop': boxes.get('crop'),
                'trim': boxes.get('trim'),
                'bleed': boxes.get('bleed'),
                'art': boxes.get('art'),
            },
        }

    # --- table geometry ----------------------------------------------------

    @staticmethod
    def _pdf_y_range(
        top: float,
        bottom: float,
        page_height: float,
        mediabox_top: float,
    ) -> tuple[float, float]:
        """Invert pdfplumber's top-left ``top``/``bottom`` into PDF-space y values."""
        return (
            page_height + mediabox_top - float(bottom),
            page_height + mediabox_top - float(top),
        )

    @classmethod
    def _table_bbox_to_pdf(
        cls,
        bbox,
        page_height: float,
        mediabox_top: float,
    ) -> Optional[dict]:
        """Convert a pdfplumber top-left bbox to the chars/words bottom-left frame.

        pdfplumber reports table and cell bboxes as ``(x0, top, x1, bottom)``,
        i.e. y measured down from the top of the MediaBox, while chars, words and
        rects are exposed in pdfminer's page frame (y up from the bottom, shifted
        by the MediaBox origin). Drawing or hit-testing a table with the
        unconverted box is therefore vertically mirrored; this is the same
        inversion ``_word_y_range`` performs for words.
        """
        if bbox is None:
            return None
        try:
            x0, top, x1, bottom = (float(value) for value in bbox)
        except (TypeError, ValueError):
            return None
        y0, y1 = cls._pdf_y_range(top, bottom, page_height, mediabox_top)
        return {
            'x0': min(x0, x1), 'y0': min(y0, y1),
            'x1': max(x0, x1), 'y1': max(y0, y1),
        }

    @classmethod
    def _cell_bbox_to_pdf(
        cls,
        bbox,
        page_height: float,
        mediabox_top: float,
    ) -> Optional[dict]:
        """Convert one cell bbox; ``None`` (a missing cell) stays ``None``."""
        return cls._table_bbox_to_pdf(bbox, page_height, mediabox_top)

    @classmethod
    def _table_cell_geometry(
        cls,
        tbl,
        extracted: list,
        page_height: float,
        mediabox_top: float,
    ) -> tuple[list[list[Optional[dict]]], list[list[Optional[dict]]]]:
        """Build ``cellBoxes`` / ``cellSpans`` aligned to ``tbl.extract()`` rows.

        Both matrices have exactly the shape of the extracted text matrix, so a
        merged, missing or unreadable cell can never shift the row it belongs to.
        A cell whose bbox spans several grid positions keeps the box on its
        top-left anchor and is marked as covering the other positions (null box,
        null span); when the grid lines do not line up the span stays null rather
        than inventing one.
        """
        grid: list[list] = []
        for row in getattr(tbl, 'rows', None) or []:
            grid.append(list(getattr(row, 'cells', None) or []))

        row_count = max(len(extracted), len(grid))
        col_count = max(
            [len(row) for row in extracted] + [len(row) for row in grid] + [0]
        )
        cell_boxes: list[list[Optional[dict]]] = [
            [None] * col_count for _ in range(row_count)
        ]
        cell_spans: list[list[Optional[dict]]] = [
            [None] * col_count for _ in range(row_count)
        ]
        if not grid or not col_count:
            return cell_boxes, cell_spans

        # Pass 1: every cell that exists gets its converted box, so a problem in
        # the span inference below can never cost a box.
        for row_index, row_cells in enumerate(grid):
            if row_index >= row_count:
                break
            for col_index, bbox in enumerate(row_cells):
                if bbox is None or col_index >= col_count:
                    continue
                cell_boxes[row_index][col_index] = cls._cell_bbox_to_pdf(
                    bbox, page_height, mediabox_top
                )

        table_bbox = getattr(tbl, 'bbox', None) or (0, 0, 0, 0)
        # Grid lines of the table, in pdfplumber's top-left coordinates. A cell
        # spanning several positions ends on a line further along its axis.
        try:
            xs = sorted(
                {float(cell[0]) for row in grid for cell in row if cell}
                | {float(table_bbox[2])}
            )
            tops = sorted(
                {float(cell[1]) for row in grid for cell in row if cell}
                | {float(table_bbox[3])}
            )
        except (TypeError, ValueError, IndexError):
            # Unusable cell geometry: keep the boxes, report no spans at all.
            return cell_boxes, cell_spans

        def line_index(lines: list[float], target: float) -> Optional[int]:
            for index, line in enumerate(lines):
                if abs(line - target) <= 0.5:
                    return index
            return None

        # Pass 2: best-effort spans, with covered positions nulled out.
        for row_index, row_cells in enumerate(grid):
            if row_index >= row_count:
                break
            for col_index, bbox in enumerate(row_cells):
                if bbox is None or col_index >= col_count:
                    continue
                try:
                    x0, top, x1, bottom = (float(value) for value in bbox)
                except (TypeError, ValueError):
                    continue
                start_col = line_index(xs, x0)
                end_col = line_index(xs, x1)
                start_row = line_index(tops, top)
                end_row = line_index(tops, bottom)
                if (
                    None in (start_col, end_col, start_row, end_row)
                    or start_col != col_index
                    or start_row != row_index
                    or end_col <= start_col
                    or end_row <= start_row
                ):
                    # The grid does not line up: keep the box, do not guess a span.
                    continue
                row_span = end_row - start_row
                col_span = end_col - start_col
                cell_spans[row_index][col_index] = {
                    'rowSpan': row_span, 'colSpan': col_span,
                }
                for covered_row in range(row_index, min(row_index + row_span, row_count)):
                    covered_cells = grid[covered_row]
                    for covered_col in range(col_index, min(col_index + col_span, col_count)):
                        if (covered_row, covered_col) == (row_index, col_index):
                            continue
                        covered = (
                            covered_cells[covered_col]
                            if covered_col < len(covered_cells) else None
                        )
                        if covered is None or covered == bbox:
                            cell_boxes[covered_row][covered_col] = None
                            cell_spans[covered_row][covered_col] = None
        return cell_boxes, cell_spans

    def extract_page(
        self,
        page_num: int,
        include_types: Optional[Iterable[str]] = None,
    ) -> dict:
        """Extract one page's structured objects.

        ``include_types`` narrows the object lists that are built.  ``None``
        (the default) keeps the historical behaviour and returns every list, so
        the UI, the audit and the CLI are unaffected.  Passing a set of
        ``char``/``word``/``rect``/``line``/``curve``/``image``/``table`` names
        lets the diff engine skip work for object types it was told to ignore:
        an unrequested list comes back empty and its expensive source (word
        grouping, table detection, image content hashing) is not touched.

        Page geometry (``width``/``height``/``rotation``/``boxes``) is always
        returned: the diff needs it for page pairing and for page-level size
        changes even when every object type is ignored.
        """
        page: Page = self._pdf.pages[page_num - 1]  # pdfplumber is 0-indexed
        requested = None if include_types is None else set(include_types)

        def wants(type_: str) -> bool:
            return requested is None or type_ in requested

        chars = []
        if wants('char'):
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

        page_height = float(page.height)
        mediabox = getattr(page, 'mediabox', None)
        mediabox_top = float(mediabox[1]) if mediabox is not None else 0.0
        geometry = self._page_geometry(page)

        words = []
        if wants('word'):
            # pdfplumber's word dicts do not include font attributes by default;
            # extra_attrs makes the extractor aggregate them from the word's chars,
            # so word objects can show/filter by font like chars do.  extract_words
            # reads page.chars internally, which is why a skipped 'char' list does
            # not make word extraction cheaper — it only skips the dict building.
            for w in page.extract_words(extra_attrs=['fontname', 'size']):
                y0, y1 = self._word_y_range(w, page_height, mediabox_top)
                words.append({
                    'type': 'word',
                    'x0': float(w['x0']), 'y0': y0,
                    'x1': float(w['x1']), 'y1': y1,
                    'text': w.get('text', ''),
                    'fontname': w.get('fontname', ''),
                    'size': float(w.get('size', 0)),
                    'page': page_num,
                })

        rects = []
        if wants('rect'):
            for r in page.rects:
                rects.append({
                    'type': 'rect',
                    'x0': float(r['x0']), 'y0': float(r['y0']),
                    'x1': float(r['x1']), 'y1': float(r['y1']),
                    'fill': r.get('non_stroking_color') is not None,
                    'stroke': r.get('stroking_color') is not None,
                    'color': str(r.get('stroking_color', '#000000')),
                    # pdfplumber names the line width 'linewidth'; older releases
                    # exposed 'stroke_width' as well, so accept either.
                    'width': float(r.get('linewidth', r.get('stroke_width', 1)) or 0),
                    'page': page_num,
                })

        lines = []
        if wants('line'):
            for ln in page.lines:
                lines.append({
                    'type': 'line',
                    'x0': float(ln['x0']), 'y0': float(ln['y0']),
                    'x1': float(ln['x1']), 'y1': float(ln['y1']),
                    'stroke': ln.get('stroking_color') is not None,
                    'color': str(ln.get('stroking_color', '#000000')),
                    'width': float(ln.get('linewidth', ln.get('stroke_width', 1)) or 0),
                    'page': page_num,
                })

        curves = []
        if wants('curve'):
            for cv in page.curves:
                # pdfplumber's curve/line records expose the path points as 'pts'.
                raw_points = cv.get('pts')
                if raw_points is None:
                    raw_points = cv.get('points', [])
                curves.append({
                    'type': 'curve',
                    'x0': float(cv['x0']), 'y0': float(cv['y0']),
                    'x1': float(cv['x1']), 'y1': float(cv['y1']),
                    'points': [[float(p[0]), float(p[1])] for p in raw_points or ()],
                    'stroke': cv.get('stroking_color') is not None,
                    'page': page_num,
                })

        images = []
        if wants('image'):
            for idx, img in enumerate(page.images):
                stream = img.get('stream')
                image = {
                    'type': 'image',
                    'x0': float(img['x0']), 'y0': float(img['y0']),
                    'x1': float(img['x1']), 'y1': float(img['y1']),
                    'width': float(img.get('width', 0)),
                    'height': float(img.get('height', 0)),
                    'stream_id': f'p{page_num}_img_{idx}',
                    'format': 'unknown',
                    'page': page_num,
                    '_stream_data': stream,
                }
                # Hashing decodes the whole image stream: only do it for a caller
                # that actually compares image content.
                content_hash = self._image_content_hash(stream)
                if content_hash:
                    image['content_hash'] = content_hash
                images.append(image)

        tables = []
        for tbl in (page.find_tables() if wants('table') else ()):
            # tbl.cells holds bbox tuples; tbl.extract() holds the actual text.
            extracted = tbl.extract() or []
            cells = [
                ['' if cell is None else str(cell) for cell in (row or [])]
                for row in extracted
            ]
            # pdfplumber's table/cell bboxes are top-left; chars, words and the
            # overlay canvas are bottom-left, so convert before exposing them.
            bbox = self._table_bbox_to_pdf(tbl.bbox, page_height, mediabox_top) or {
                'x0': 0.0, 'y0': 0.0, 'x1': 0.0, 'y1': 0.0,
            }
            cell_boxes, cell_spans = self._table_cell_geometry(
                tbl, extracted, page_height, mediabox_top
            )
            tables.append({
                'type': 'table',
                'x0': bbox['x0'], 'y0': bbox['y0'],
                'x1': bbox['x1'], 'y1': bbox['y1'],
                'rows': len(extracted),
                'cols': max((len(row) for row in extracted), default=0),
                'cells': cells,
                'cellBoxes': cell_boxes,
                'cellSpans': cell_spans,
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
            'rotation': geometry['rotation'],
            'boxes': geometry['boxes'],
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
            data = stream.get('data') if hasattr(stream, 'get') else None
            if not isinstance(data, (bytes, bytearray, memoryview)):
                # pdfminer's PDFStream exposes the decoded payload via get_data().
                data = stream.get_data()
            if isinstance(data, (bytearray, memoryview)):
                data = bytes(data)
            if not isinstance(data, bytes):
                data = b''
            return self._encode_for_preview(data)
        except Exception as e:
            return {'error': str(e)}

    def close(self):
        self._pdf.close()
