"""Read-only document resources for the diff engine.

The collector inspects the pdfminer objects an already-open ``PdfExtractor``
holds (``extractor._pdf``) and never renders, executes, opens or writes
anything: no URI is probed, no ``/Launch`` target is touched, no form is filled
or submitted, no signature is verified and no stream other than a bounded
string value is decoded.  R1 only *collects and normalises*; comparing resources
and emitting ``DiffChange``/``documentChanges`` entries is R2's job.

``collect_document_resources(extractor)`` returns this shape::

    {
      "metadata": {
        "title": str | None,
        "author": str | None,
        "subject": str | None,
        "keywords": str | None,
        "creator": str | None,
        "producer": str | None,
        "creationDate": str | None,
        "modDate": str | None,
        "language": str | None,          # catalog /Lang
      },
      "pageLabels": [
        {
          "page": int,                  # 1-based PDF page
          "label": str,                 # e.g. "i", "A-2", "Cover"
          "style": str | None,          # /S: "D", "R", "r", "A", "a"
          "prefix": str | None,         # /P
          "start": int | None,          # /St as declared
        },
        ...                             # only pages whose label != str(page)
      ],
      "pages": [
        {
          "page": int,                  # 1-based; pages[i]["page"] == i + 1
          "annotations": [AnnotationEntry, ...],
          "links": [LinkEntry, ...],
          "forms": [FormEntry, ...],
        },
        ...                             # one entry per PDF page
      ],
      # Internal counters (not part of the future DiffResult contract):
      "truncated": {str: int},
      "skipped": {str: int},
    }

``AnnotationEntry`` (every annotation except ``/Link`` and ``/Widget``)::

    {
      "identity": str,                  # collision-safe, see below
      "nm": str | None,                 # /NM
      "subtype": str,                   # /Subtype, e.g. "Text", "Highlight"
      "rect": {"x0","y0","x1","y1"} | None,   # MediaBox-relative PDF points
      "contents": str | None,           # /Contents, bounded to MAX_TEXT
      "title": str | None,              # /T
      "color": [float, ...] | None,     # /C, up to 4 components
      "opacity": float | None,          # /CA, 0..1
      "flags": int | None,              # /F
      "hidden": bool,                   # Invisible/Hidden/NoView flag bits
      "textTruncated": bool,
    }

``LinkEntry`` (``/Subtype /Link``)::

    {
      "identity": str,
      "nm": str | None,
      "rect": {"x0","y0","x1","y1"} | None,
      "uri": str | None,                # /A /URI, bounded to MAX_URL
      "unsafeUrl": bool,                # non-http(s)/mailto/tel scheme
      "internalPage": int | None,       # /Dest or /A /S /GoTo page, 1-based
      "target": str | None,             # display text only, never opened
      "action": str | None,             # /A /S, e.g. "Launch", "GoToR"
      "contents": str | None,           # /Contents
      "textTruncated": bool,
      "urlTruncated": bool,
    }

``FormEntry`` (``/Subtype /Widget``)::

    {
      "identity": str,
      "fieldName": str | None,          # full name, e.g. "person.first"
      "fieldType": str | None,          # /FT: "Tx", "Ch", "Btn", "Sig"
      "value": str | None,              # /V (array values joined with "\\n")
      "defaultValue": str | None,       # /DV
      "options": [str, ...] | None,     # /Opt
      "flags": int | None,              # /Ff
      "rect": {"x0","y0","x1","y1"} | None,
      "textTruncated": bool,
    }

Coordinates use the diff/extractor contract: MediaBox-relative PDF points with
a bottom-left origin.  ``/Rect`` values are normalised (``x0 <= x1``,
``y0 <= y1``) and translated by the page MediaBox origin.

Identity rules (``resource_identity`` / ``annotation_identity`` etc.):

* annotation: ``/NM`` first, else subtype + rounded rect + whitespace-normalised
  contents;
* link: ``/NM`` first, else URI / internal page / target plus rect;
* form: full field name plus widget rect.

Identities are bounded strings.  When two resources on the same page produce the
same identity, ``_assign_identities`` appends ``#2``, ``#3``, ... in /Annots
order, so entries are never silently merged.

Limits (plan table): 500 annotations per page, 5000 annotations per document
(links and widgets included), 4096 characters of text, 2000 form widgets, 2000
visited AcroForm field nodes, 5000 page-label entries, 2048 URL characters and a
depth of 8 for number trees, name trees, form trees, destination lookups and
parent chains.  Malformed references/values are skipped and counted instead of
failing the document.  Output is deterministic: no timestamps, paths, random ids
or environment values are added.

``collect_page_resources(extractor, page_num)`` returns one element of
``pages`` for a caller that only needs one page; it builds its own document
context and therefore is not the right tool for a page loop (use
``collect_document_resources`` for that).

``page_resource_digest(page)`` / ``resource_fingerprint(resources)`` are stable
SHA-256 helpers for a bounded fast path; they hash normalised data only.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Iterator, Mapping
from typing import Any, Optional

try:  # imported as ``sidecar.diff_resources`` (namespace package)
    from .extractor import PdfExtractor
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from extractor import PdfExtractor


# --- limits (mirrored by the plan's resource table) -------------------------

MAX_ANNOTATIONS_PER_PAGE = 500
MAX_ANNOTATIONS = 5000
MAX_TEXT = 4096
MAX_FORMS = 2000
MAX_FORM_FIELDS = 2000
MAX_FORM_OPTIONS = 100
MAX_METADATA_FIELDS = 32
MAX_PAGE_LABELS = 5000
MAX_URL = 2048
MAX_DEPTH = 8
MAX_DESTINATIONS = 5000

# Identity strings are compared/hashed, not displayed at full length.
MAX_IDENTITY_TEXT = 256
# Annotation colour components (DeviceGray/CMYK + spot names are not resolved).
MAX_COLOR_COMPONENTS = 4
# Rect display precision matches the diff engine; identity uses 2 decimals.
RECT_DECIMALS = 3
IDENTITY_RECT_DECIMALS = 2

# URL schemes that are safe to *display* as plain links.  Nothing is fetched.
SAFE_URL_SCHEMES = frozenset({'http', 'https', 'mailto', 'tel'})
_URL_SCHEME = re.compile(r'^([a-zA-Z][a-zA-Z0-9+.\-]*):')

# Annotation /F bits that make an annotation invisible to a viewer.
_HIDDEN_FLAGS = 1 | 2 | 32  # Invisible | Hidden | NoView

# (public metadata key, PDF info dictionary key)
_METADATA_FIELDS = (
    ('title', 'Title'),
    ('author', 'Author'),
    ('subject', 'Subject'),
    ('keywords', 'Keywords'),
    ('creator', 'Creator'),
    ('producer', 'Producer'),
    ('creationDate', 'CreationDate'),
    ('modDate', 'ModDate'),
)


# --- small pdfminer helpers -------------------------------------------------


def _resolve(value: Any) -> Any:
    """Follow a pdfminer reference; unreadable references resolve to None."""
    return PdfExtractor._resolve_pdf_value(value)


def _get(mapping: Any, key: str) -> Any:
    """Read one key from a mapping, treating a broken accessor as absent."""
    if not isinstance(mapping, Mapping):
        return None
    try:
        return mapping.get(key)
    except Exception:
        return None


def _mapping(value: Any) -> Optional[Mapping[str, Any]]:
    value = _resolve(value)
    return value if isinstance(value, Mapping) else None


def _sequence(value: Any) -> Optional[list[Any]]:
    value = _resolve(value)
    return list(value) if isinstance(value, (list, tuple)) else None


def _decode_bytes(data: bytes) -> str:
    """Decode PDF text bytes: UTF-16 BOM, UTF-8, then Latin-1."""
    if data.startswith(b'\xfe\xff'):
        return data[2:].decode('utf-16-be', 'replace')
    if data.startswith(b'\xff\xfe'):
        return data[2:].decode('utf-16-le', 'replace')
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return data.decode('latin-1')


def _scalar_text(value: Any) -> Optional[str]:
    """Plain text of a PDF string/name, or None for structural values."""
    value = _resolve(value)
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray, memoryview)):
        text = _decode_bytes(bytes(value))
    elif isinstance(value, str):
        text = value
    else:
        name = getattr(value, 'name', None)
        if isinstance(name, bytes):
            text = name.decode('latin-1', 'replace')
        elif isinstance(name, str):
            text = name
        else:
            return None
    text = text.strip()
    return text or None


def _bounded(value: Any, limit: Optional[int] = None) -> tuple[Optional[str], bool]:
    """A stripped, length-bounded string and whether it had to be cut."""
    text = _scalar_text(value)
    if text is None:
        return None, False
    effective = MAX_TEXT if limit is None else limit
    return text[:effective], len(text) > effective


def _int_value(value: Any) -> Optional[int]:
    """An integer PDF value, or None (booleans and floats are not integers)."""
    value = _resolve(value)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _float_value(value: Any) -> Optional[float]:
    """A finite number, or None (booleans, NaN and infinities are rejected)."""
    value = _resolve(value)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _round_number(value: float, digits: int) -> float:
    number = round(float(value), digits)
    return 0.0 if number == 0 else number


def _key_text(key: Any) -> str:
    return _scalar_text(key) or ''


def _object_key(raw_value: Any, resolved: Any) -> tuple:
    """Stable identity for cycle protection and cross-reference matching."""
    objid = getattr(raw_value, 'objid', None)
    if isinstance(objid, int) and not isinstance(objid, bool):
        return ('objid', objid)
    return ('object', id(resolved))


def _note(counters: dict[str, int], key: str, amount: int = 1) -> None:
    if amount > 0:
        counters[key] = counters.get(key, 0) + amount


# --- document roots ---------------------------------------------------------


def _catalog(document: Any) -> Mapping[str, Any]:
    try:
        catalog = getattr(document, 'catalog', None)
    except Exception:
        return {}
    catalog = _resolve(catalog)
    return catalog if isinstance(catalog, Mapping) else {}


def _trailer(document: Any) -> dict[str, Any]:
    """Merged trailer of the document's xref sections (newest section wins)."""
    trailer: dict[str, Any] = {}
    try:
        xrefs = list(getattr(document, 'xrefs', None) or ())
    except Exception:
        return trailer
    for xref in reversed(xrefs):
        try:
            section = xref.get_trailer()
        except Exception:
            continue
        if isinstance(section, Mapping):
            trailer.update(section)
    return trailer


def _pages(pdf: Any) -> list[Any]:
    try:
        return list(getattr(pdf, 'pages', None) or ())
    except Exception:
        return []


def _page_attrs(page: Any) -> Mapping[str, Any]:
    try:
        page_obj = getattr(page, 'page_obj', None)
        attrs = _resolve(getattr(page_obj, 'attrs', None))
    except Exception:
        return {}
    return attrs if isinstance(attrs, Mapping) else {}


def _page_numbers(pages: list[Any]) -> tuple[dict[int, int], dict[int, int]]:
    """Map page object ids and ``id(page_obj)`` to 1-based page numbers."""
    by_objid: dict[int, int] = {}
    by_id: dict[int, int] = {}
    for index, page in enumerate(pages, start=1):
        try:
            page_obj = getattr(page, 'page_obj', None)
        except Exception:
            continue
        pageid = getattr(page_obj, 'pageid', None)
        if isinstance(pageid, int) and not isinstance(pageid, bool):
            by_objid.setdefault(pageid, index)
        if page_obj is not None:
            by_id.setdefault(id(page_obj), index)
    return by_objid, by_id


def _media_box(attrs: Mapping[str, Any]) -> Optional[tuple[float, float, float, float]]:
    raw = _sequence(_get(attrs, 'MediaBox'))
    if raw is None or len(raw) != 4:
        return None
    values = [_float_value(item) for item in raw]
    if any(value is None for value in values):
        return None
    x0, y0, x1, y1 = (value for value in values if value is not None)
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _page_origin(attrs: Mapping[str, Any]) -> tuple[float, float]:
    """MediaBox origin, inherited through ``/Parent`` when necessary."""
    node: Any = attrs
    visited: set[tuple] = set()
    depth = 0
    while node is not None and depth <= MAX_DEPTH:
        mapping = _mapping(node)
        if mapping is None:
            break
        box = _media_box(mapping)
        if box is not None:
            return (box[0], box[1])
        identity = _object_key(node, mapping)
        if identity in visited:
            break
        visited.add(identity)
        node = _get(mapping, 'Parent')
        depth += 1
    return (0.0, 0.0)


# --- document context -------------------------------------------------------


class _Context:
    """Cheap document state plus the bounded indexes the collector reuses."""

    def __init__(self, extractor: Any):
        try:
            self.pdf = getattr(extractor, '_pdf', None)
        except Exception:  # pragma: no cover - defensive
            self.pdf = None
        try:
            self.doc = getattr(self.pdf, 'doc', None)
        except Exception:  # pragma: no cover - defensive
            self.doc = None
        self.catalog = _catalog(self.doc)
        self.trailer = _trailer(self.doc)
        self.pages = _pages(self.pdf)
        self.page_numbers, self.page_numbers_by_id = _page_numbers(self.pages)
        self.acroform = _mapping(_get(self.catalog, 'AcroForm'))
        self.truncated: dict[str, int] = {}
        self.skipped: dict[str, int] = {}
        self._acroform_index: Optional[dict[tuple, dict[str, Any]]] = None
        self._acroform_index_built = False
        self._named_destinations: Optional[dict[str, Any]] = None
        self._parent_chains: dict[tuple, list[Mapping[str, Any]]] = {}
        self.annotation_budget = MAX_ANNOTATIONS
        self.form_count = 0


# --- metadata ---------------------------------------------------------------


def _metadata_info(context: _Context) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    try:
        sections = list(getattr(context.doc, 'info', None) or ())
    except Exception:
        sections = []
    for section in sections:
        if isinstance(section, Mapping):
            merged.update(section)
    if not merged:
        info = _mapping(_get(context.trailer, 'Info'))
        if info is not None:
            merged.update(info)

    # Info keys are normally names, but tolerate string keys from odd writers.
    normalized: dict[str, Any] = {}
    try:
        items = list(merged.items())
    except Exception:
        return {}
    for key, value in items:
        text = _key_text(key)
        if text:
            normalized[text] = value
    return normalized


def _collect_metadata(context: _Context) -> dict[str, Optional[str]]:
    metadata: dict[str, Optional[str]] = {
        name: None for name, _ in _METADATA_FIELDS
    }
    metadata['language'] = None
    try:
        info = _metadata_info(context)
    except Exception:
        info = {}

    for index, (name, pdf_key) in enumerate(_METADATA_FIELDS):
        if index >= MAX_METADATA_FIELDS:
            _note(context.truncated, 'metadata')
            break
        text, shortened = _bounded(_get(info, pdf_key))
        metadata[name] = text
        if shortened:
            _note(context.truncated, 'metadata')

    language, shortened = _bounded(_get(context.catalog, 'Lang'))
    metadata['language'] = language
    if shortened:
        _note(context.truncated, 'metadata')
    return metadata


# --- page labels ------------------------------------------------------------


def _walk_number_tree(
    context: _Context,
    root: Any,
    visited: set[tuple],
    depth: int = 0,
) -> Iterator[tuple[int, Mapping[str, Any]]]:
    """Yield ``(page_index, label_dict)`` pairs from ``/Nums`` and ``/Kids``."""
    node = _mapping(root)
    if node is None:
        return
    if depth >= MAX_DEPTH:
        nums = _sequence(_get(node, 'Nums'))
        if nums:
            # The cut node really carries entries; report them as skipped.
            _note(context.truncated, 'pageLabels', len(nums) // 2)
        return
    identity = _object_key(root, node)
    if identity in visited:
        return
    visited.add(identity)

    nums = _sequence(_get(node, 'Nums'))
    if nums:
        for index in range(0, len(nums) - 1, 2):
            page_index = _int_value(nums[index])
            entry = _mapping(nums[index + 1])
            if page_index is None or page_index < 0 or entry is None:
                _note(context.skipped, 'pageLabels')
                continue
            yield page_index, entry

    for kid in _sequence(_get(node, 'Kids')) or ():
        yield from _walk_number_tree(context, kid, visited, depth + 1)


_ROMAN_NUMERALS = (
    (1000, 'm'), (900, 'cm'), (500, 'd'), (400, 'cd'),
    (100, 'c'), (90, 'xc'), (50, 'l'), (40, 'xl'),
    (10, 'x'), (9, 'ix'), (5, 'v'), (4, 'iv'), (1, 'i'),
)


def _roman(value: int, upper: bool) -> str:
    if value <= 0:
        return ''
    remaining = value
    parts: list[str] = []
    for number, glyph in _ROMAN_NUMERALS:
        while remaining >= number:
            parts.append(glyph)
            remaining -= number
    text = ''.join(parts)
    return text.upper() if upper else text


def _letters(value: int, upper: bool) -> str:
    """Spreadsheet-style letters: 1 -> A, 26 -> Z, 27 -> AA."""
    if value <= 0:
        return ''
    letters: list[str] = []
    remaining = value
    while remaining > 0:
        remaining, digit = divmod(remaining - 1, 26)
        letters.append(chr(ord('A') + digit))
    text = ''.join(reversed(letters))
    return text if upper else text.lower()


def _page_label_number(counter: int, style: Optional[str]) -> str:
    if style == 'D':
        return str(counter)
    if style == 'R':
        return _roman(counter, True)
    if style == 'r':
        return _roman(counter, False)
    if style == 'A':
        return _letters(counter, True)
    if style == 'a':
        return _letters(counter, False)
    return ''


def _page_label_text(entry: Mapping[str, Any], counter: int) -> str:
    style = _scalar_text(_get(entry, 'S'))
    prefix, _ = _bounded(_get(entry, 'P'))
    return (prefix or '') + _page_label_number(counter, style)


def _collect_page_labels(context: _Context) -> list[dict[str, Any]]:
    root = _get(context.catalog, 'PageLabels')
    if root is None:
        return []
    entries: list[tuple[int, Mapping[str, Any]]] = []
    try:
        for entry in _walk_number_tree(context, root, set()):
            if len(entries) >= MAX_PAGE_LABELS:
                # Bound the walk itself: a pathological /Nums array must not be
                # materialised just to be cut afterwards.
                _note(context.truncated, 'pageLabels')
                break
            entries.append(entry)
    except Exception:
        # Keep the entries read so far; one broken subtree is not fatal.
        pass
    try:
        entries.sort(key=lambda item: item[0])
    except Exception:
        return []

    # Duplicate page indexes: keep the first definition (deterministic).
    unique: list[tuple[int, Mapping[str, Any]]] = []
    seen_indexes: set[int] = set()
    for page_index, entry in entries:
        if page_index in seen_indexes:
            _note(context.skipped, 'pageLabels')
            continue
        seen_indexes.add(page_index)
        unique.append((page_index, entry))

    page_count = len(context.pages)
    labels: list[dict[str, Any]] = []
    for position, (page_index, entry) in enumerate(unique):
        if page_index >= page_count:
            continue
        next_index = unique[position + 1][0] if position + 1 < len(unique) else page_count
        if next_index <= page_index:
            continue
        declared_start = _int_value(_get(entry, 'St'))
        start = declared_start if declared_start is not None and declared_start > 0 else 1
        style = _scalar_text(_get(entry, 'S'))
        prefix, shortened = _bounded(_get(entry, 'P'))
        if shortened:
            _note(context.truncated, 'pageLabels')

        last_page = min(next_index, page_count)
        for page in range(page_index + 1, last_page + 1):
            counter = start + (page - 1 - page_index)
            label = _page_label_text(entry, counter)
            if not label or label == str(page):
                # Defined but visually identical to the default decimal label.
                continue
            if len(labels) >= MAX_PAGE_LABELS:
                _note(context.truncated, 'pageLabels')
                return labels
            labels.append({
                'page': page,
                'label': label,
                'style': style,
                'prefix': prefix,
                'start': declared_start,
            })
    return labels


# --- rect / colour / number helpers ----------------------------------------


def _normalize_rect(
    value: Any,
    origin: tuple[float, float] = (0.0, 0.0),
) -> Optional[dict[str, float]]:
    """A normalised, MediaBox-relative ``DiffBBox``-shaped rect, or None."""
    raw = _sequence(value)
    if raw is None or len(raw) != 4:
        return None
    values = [_float_value(item) for item in raw]
    if any(item is None for item in values):
        return None
    x0, y0, x1, y1 = (item for item in values if item is not None)
    origin_x, origin_y = origin
    return {
        'x0': _round_number(min(x0, x1) - origin_x, RECT_DECIMALS),
        'y0': _round_number(min(y0, y1) - origin_y, RECT_DECIMALS),
        'x1': _round_number(max(x0, x1) - origin_x, RECT_DECIMALS),
        'y1': _round_number(max(y0, y1) - origin_y, RECT_DECIMALS),
    }


def _normalize_color(value: Any) -> Optional[list[float]]:
    raw = _sequence(value)
    if raw is None or not raw:
        return None
    values = [_float_value(item) for item in raw[:MAX_COLOR_COMPONENTS]]
    if any(item is None for item in values):
        return None
    return [_round_number(item, RECT_DECIMALS) for item in values if item is not None]


def _normalize_opacity(value: Any) -> Optional[float]:
    number = _float_value(value)
    if number is None:
        return None
    return _round_number(min(max(number, 0.0), 1.0), RECT_DECIMALS)


def _normalize_flags(value: Any) -> Optional[int]:
    return _int_value(value)


def _is_hidden(flags: Optional[int]) -> bool:
    return bool(flags is not None and flags & _HIDDEN_FLAGS)


def _field_text(value: Any) -> tuple[Optional[str], bool]:
    """A field value as display text (arrays joined with newlines)."""
    resolved = _resolve(value)
    if isinstance(resolved, (list, tuple)):
        parts: list[str] = []
        truncated = False
        for item in resolved:
            text, shortened = _bounded(item)
            truncated = truncated or shortened
            if text is not None:
                parts.append(text)
        joined = '\n'.join(parts)
        if len(joined) > MAX_TEXT:
            return joined[:MAX_TEXT], True
        return (joined or None), truncated
    return _bounded(resolved)


def _field_options(
    context: _Context,
    value: Any,
) -> Optional[list[str]]:
    raw = _sequence(value)
    if raw is None:
        return None
    options: list[str] = []
    for item in raw:
        if len(options) >= MAX_FORM_OPTIONS:
            _note(context.truncated, 'formOptions')
            break
        # Export/display pairs: show the human-readable display value.
        pair = _sequence(item)
        if pair is not None:
            display = pair[1] if len(pair) >= 2 else (pair[0] if pair else None)
        else:
            display = item
        text, shortened = _bounded(display)
        if shortened:
            _note(context.truncated, 'formOptions')
        options.append(text or '')
    return options


# --- destinations -----------------------------------------------------------


def _build_named_destinations(context: _Context) -> dict[str, Any]:
    destinations: dict[str, Any] = {}

    def add(key: Any, value: Any) -> None:
        text = _key_text(key)
        if not text:
            return
        if len(destinations) >= MAX_DESTINATIONS:
            _note(context.truncated, 'destinations')
            return
        destinations.setdefault(text, value)

    direct = _mapping(_get(context.catalog, 'Dests'))
    if direct is not None:
        try:
            keys = sorted(direct.keys(), key=_key_text)
        except Exception:
            keys = []
        for key in keys:
            if len(destinations) >= MAX_DESTINATIONS:
                _note(context.truncated, 'destinations')
                break
            add(key, _get(direct, key))

    names = _mapping(_get(context.catalog, 'Names'))
    tree = _get(names, 'Dests') if names is not None else None
    if tree is not None:
        visited: set[tuple] = set()

        def walk(root: Any, depth: int) -> Iterator[tuple[Any, Any]]:
            node = _mapping(root)
            if node is None:
                return
            if depth >= MAX_DEPTH:
                entries = _sequence(_get(node, 'Names'))
                if entries:
                    _note(context.truncated, 'destinations', len(entries) // 2)
                return
            identity = _object_key(root, node)
            if identity in visited:
                return
            visited.add(identity)
            entries = _sequence(_get(node, 'Names'))
            if entries:
                for index in range(0, len(entries) - 1, 2):
                    yield entries[index], entries[index + 1]
            for kid in _sequence(_get(node, 'Kids')) or ():
                yield from walk(kid, depth + 1)

        for key, value in walk(tree, 0):
            if len(destinations) >= MAX_DESTINATIONS:
                _note(context.truncated, 'destinations')
                break
            add(key, value)
    return destinations


def _named_destinations(context: _Context) -> dict[str, Any]:
    if context._named_destinations is None:
        context._named_destinations = _build_named_destinations(context)
    return context._named_destinations


def _page_number_for(context: _Context, raw_value: Any, resolved: Any) -> Optional[int]:
    objid = getattr(raw_value, 'objid', None)
    if isinstance(objid, int) and not isinstance(objid, bool):
        number = context.page_numbers.get(objid)
        if number is not None:
            return number
    if resolved is not None:
        pageid = getattr(resolved, 'pageid', None)
        if isinstance(pageid, int) and not isinstance(pageid, bool):
            number = context.page_numbers.get(pageid)
            if number is not None:
                return number
        number = context.page_numbers_by_id.get(id(resolved))
        if number is not None:
            return number
    return None


def _destination_page(
    context: _Context,
    raw_dest: Any,
    depth: int = 0,
) -> Optional[int]:
    """Resolve a destination to a 1-based page number without opening it."""
    if raw_dest is None or depth > MAX_DEPTH:
        return None
    value = _resolve(raw_dest)
    if value is None:
        return None
    if isinstance(value, Mapping):
        return _destination_page(context, _get(value, 'D'), depth + 1)
    if isinstance(value, (list, tuple)):
        items = list(value)
        if not items:
            return None
        first_raw = items[0]
        first = _resolve(first_raw)
        return _page_number_for(context, first_raw, first)
    text = _scalar_text(value)
    if text:
        target = _named_destinations(context).get(text)
        if target is not None:
            return _destination_page(context, target, depth + 1)
    return None


def _destination_text(value: Any, depth: int = 0) -> Optional[str]:
    """Display value of a destination; never a page number or a probe."""
    if value is None or depth > MAX_DEPTH:
        return None
    resolved = _resolve(value)
    if resolved is None:
        return None
    if isinstance(resolved, Mapping):
        return _destination_text(_get(resolved, 'D'), depth + 1)
    if isinstance(resolved, (list, tuple)):
        items = list(resolved)
        if not items:
            return None
        first = _resolve(items[0])
        if isinstance(first, Mapping):
            return None
        text, _ = _bounded(first, MAX_URL)
        return text
    text, _ = _bounded(resolved, MAX_URL)
    return text


def _filespec_display(value: Any) -> Optional[str]:
    resolved = _resolve(value)
    if isinstance(resolved, Mapping):
        return _bounded(_get(resolved, 'UF'))[0] or _bounded(_get(resolved, 'F'))[0]
    return _bounded(resolved, MAX_URL)[0]


def _action_target(action: Mapping[str, Any]) -> Optional[str]:
    """Display text of /URI, /F, /D or /N; no filesystem or network access."""
    for key in ('URI', 'F'):
        value = _get(action, key)
        text = (
            _bounded(value, MAX_URL)[0]
            if key == 'URI'
            else _filespec_display(value)
        )
        if text:
            return text
    destination = _destination_text(_get(action, 'D'))
    if destination:
        return destination
    return _bounded(_get(action, 'N'), MAX_URL)[0]


def _is_unsafe_url(uri: Optional[str]) -> bool:
    if not uri:
        return False
    match = _URL_SCHEME.match(uri.strip())
    if not match:
        return False
    return match.group(1).lower() not in SAFE_URL_SCHEMES


# --- annotations and links --------------------------------------------------


def _collect_annotation(
    annot: Mapping[str, Any],
    origin: tuple[float, float],
) -> dict[str, Any]:
    subtype, _ = _bounded(_get(annot, 'Subtype'))
    contents, contents_truncated = _bounded(_get(annot, 'Contents'))
    title, title_truncated = _bounded(_get(annot, 'T'))
    nm, _ = _bounded(_get(annot, 'NM'))
    flags = _normalize_flags(_get(annot, 'F'))
    return {
        'nm': nm,
        'subtype': subtype or '',
        'rect': _normalize_rect(_get(annot, 'Rect'), origin),
        'contents': contents,
        'title': title,
        'color': _normalize_color(_get(annot, 'C')),
        'opacity': _normalize_opacity(_get(annot, 'CA')),
        'flags': flags,
        'hidden': _is_hidden(flags),
        'textTruncated': contents_truncated or title_truncated,
    }


def _collect_link(
    context: _Context,
    annot: Mapping[str, Any],
    origin: tuple[float, float],
) -> dict[str, Any]:
    nm, _ = _bounded(_get(annot, 'NM'))
    contents, contents_truncated = _bounded(_get(annot, 'Contents'))
    action = _mapping(_get(annot, 'A'))
    action_type = _scalar_text(_get(action, 'S')) if action is not None else None

    uri: Optional[str] = None
    url_truncated = False
    internal_page: Optional[int] = None
    target: Optional[str] = None

    if action_type == 'URI':
        uri, url_truncated = _bounded(_get(action, 'URI'), MAX_URL)
        target = uri
    elif action_type == 'GoTo':
        internal_page = _destination_page(context, _get(action, 'D'))
        target = _destination_text(_get(action, 'D'))
    elif action is not None:
        target = _action_target(action)

    # Link annotations may carry /Dest directly instead of an action.
    if action_type is None:
        dest = _get(annot, 'Dest')
        if dest is not None:
            internal_page = _destination_page(context, dest)
            target = _destination_text(dest)

    return {
        'nm': nm,
        'rect': _normalize_rect(_get(annot, 'Rect'), origin),
        'uri': uri,
        'unsafeUrl': _is_unsafe_url(uri),
        'internalPage': internal_page,
        'target': target,
        'action': action_type,
        'contents': contents,
        'textTruncated': contents_truncated,
        'urlTruncated': url_truncated,
    }


# --- forms ------------------------------------------------------------------

# A field-node record shared by the AcroForm index and the parent fallback.
_FieldInfo = dict[str, Any]


def _parent_chain(context: _Context, raw_annot: Any) -> list[Mapping[str, Any]]:
    """Root-first list of a widget's ancestor field dictionaries."""
    chain: list[Mapping[str, Any]] = []
    raw_parent = _get(raw_annot, 'Parent') if isinstance(raw_annot, Mapping) else None
    visited: set[tuple] = set()
    depth = 0
    while raw_parent is not None and depth < MAX_DEPTH:
        parent = _mapping(raw_parent)
        if parent is None:
            break
        identity = _object_key(raw_parent, parent)
        if identity in visited:
            break
        visited.add(identity)
        chain.append(parent)
        raw_parent = _get(parent, 'Parent')
        depth += 1
    chain.reverse()
    return chain


def _join_field_name(prefix: Optional[str], name: Optional[str]) -> Optional[str]:
    if prefix and name:
        return f'{prefix}.{name}'
    return name or prefix or None


def _field_info_from_nodes(
    context: _Context,
    nodes: list[Mapping[str, Any]],
    name: Optional[str],
) -> _FieldInfo:
    """Merge inherited field attributes from root-first nodes (nearest wins)."""
    field_type: Optional[str] = None
    value: Optional[str] = None
    default_value: Optional[str] = None
    options: Optional[list[str]] = None
    flags: Optional[int] = None
    text_truncated = False

    for node in nodes:
        node_type = _scalar_text(_get(node, 'FT'))
        if node_type is not None:
            field_type = node_type
        node_flags = _int_value(_get(node, 'Ff'))
        if node_flags is not None:
            flags = node_flags
        for key, setter in (
            ('V', 'value'),
            ('DV', 'default_value'),
        ):
            if _resolve(_get(node, key)) is not None:
                text, shortened = _field_text(_get(node, key))
                text_truncated = text_truncated or shortened
                if setter == 'value':
                    value = text
                else:
                    default_value = text
        if _resolve(_get(node, 'Opt')) is not None:
            options = _field_options(context, _get(node, 'Opt'))

    return {
        'fullName': name,
        'fieldType': field_type,
        'value': value,
        'defaultValue': default_value,
        'options': options,
        'flags': flags,
        'textTruncated': text_truncated,
    }


def _build_acroform_index(context: _Context) -> dict[tuple, _FieldInfo]:
    index: dict[tuple, _FieldInfo] = {}
    visited: set[tuple] = set()
    produced = 0
    stopped = False

    def walk(
        raw_field: Any,
        inherited_name: Optional[str],
        inherited_type: Optional[str],
        inherited_value: Optional[str],
        inherited_default: Optional[str],
        inherited_options: Optional[list[str]],
        inherited_flags: Optional[int],
        depth: int,
    ) -> None:
        nonlocal produced, stopped
        if stopped:
            return
        node = _mapping(raw_field)
        if node is None:
            return
        identity = _object_key(raw_field, node)
        if identity in visited:
            return
        visited.add(identity)
        if depth >= MAX_DEPTH:
            _note(context.truncated, 'formFields')
            return
        if produced >= MAX_FORM_FIELDS:
            _note(context.truncated, 'formFields')
            stopped = True
            return
        produced += 1

        own_name, _ = _bounded(_get(node, 'T'))
        full_name = _join_field_name(inherited_name, own_name)
        field_type = _scalar_text(_get(node, 'FT')) or inherited_type
        flags = _int_value(_get(node, 'Ff'))
        if flags is None:
            flags = inherited_flags
        value = inherited_value
        if _resolve(_get(node, 'V')) is not None:
            value, _ = _field_text(_get(node, 'V'))
        default_value = inherited_default
        if _resolve(_get(node, 'DV')) is not None:
            default_value, _ = _field_text(_get(node, 'DV'))
        options = inherited_options
        if _resolve(_get(node, 'Opt')) is not None:
            options = _field_options(context, _get(node, 'Opt'))

        if _scalar_text(_get(node, 'Subtype')) == 'Widget':
            index[identity] = {
                'fullName': full_name,
                'fieldType': field_type,
                'value': value,
                'defaultValue': default_value,
                'options': options,
                'flags': flags,
                'textTruncated': False,
            }

        for kid in _sequence(_get(node, 'Kids')) or ():
            walk(
                kid,
                full_name,
                field_type,
                value,
                default_value,
                options,
                flags,
                depth + 1,
            )
            if stopped:
                return

    fields = _sequence(_get(context.acroform, 'Fields')) or ()
    for raw_field in fields:
        walk(raw_field, None, None, None, None, None, None, 0)
        if stopped:
            break
    return index


def _acroform_index(context: _Context) -> dict[tuple, _FieldInfo]:
    if not context._acroform_index_built:
        context._acroform_index_built = True
        try:
            context._acroform_index = _build_acroform_index(context)
        except Exception:
            context._acroform_index = {}
    return context._acroform_index or {}


def _collect_form(
    context: _Context,
    annot: Mapping[str, Any],
    raw_annot: Any,
    origin: tuple[float, float],
) -> dict[str, Any]:
    key = _object_key(raw_annot, annot)
    index = _acroform_index(context)
    info = index.get(key)

    chain = _parent_chain(context, annot)
    own_name, _ = _bounded(_get(annot, 'T'))
    chain_prefix = None
    for node in chain:
        node_name, _ = _bounded(_get(node, 'T'))
        chain_prefix = _join_field_name(chain_prefix, node_name)
    chain_info = _field_info_from_nodes(
        context,
        chain,
        name=chain_prefix,
    )
    own_info = _field_info_from_nodes(
        context,
        [annot],
        name=_join_field_name(chain_prefix, own_name),
    )

    full_name = (
        (info or {}).get('fullName')
        or own_info.get('fullName')
        or chain_info.get('fullName')
    )
    field_type = (
        own_info.get('fieldType')
        or (info or {}).get('fieldType')
        or chain_info.get('fieldType')
    )

    def first_value(key_name: str) -> Any:
        for source in (own_info, info or {}, chain_info):
            value = source.get(key_name)
            if value is not None:
                return value
        return None

    return {
        'fieldName': full_name,
        'fieldType': field_type,
        'value': first_value('value'),
        'defaultValue': first_value('defaultValue'),
        'options': first_value('options'),
        'flags': first_value('flags'),
        'rect': _normalize_rect(_get(annot, 'Rect'), origin),
        'textTruncated': bool(
            own_info.get('textTruncated')
            or (info or {}).get('textTruncated')
            or chain_info.get('textTruncated')
        ),
    }


# --- identities -------------------------------------------------------------


def _identity_text(value: Any, limit: int = MAX_IDENTITY_TEXT) -> str:
    text = _scalar_text(value) or ''
    text = ' '.join(text.split())
    return text[:limit]


def _rect_token(rect: Any) -> str:
    if isinstance(rect, Mapping):
        values = [rect.get('x0'), rect.get('y0'), rect.get('x1'), rect.get('y1')]
    elif isinstance(rect, (list, tuple)):
        values = list(rect[:4])
    else:
        return ''
    numbers = [_float_value(value) for value in values]
    if len(numbers) != 4 or any(value is None for value in numbers):
        return ''
    return ','.join(
        format(_round_number(value, IDENTITY_RECT_DECIMALS), '.2f')
        for value in numbers
        if value is not None
    )


def annotation_identity(annotation: Mapping[str, Any]) -> str:
    """Stable base identity of a normalised annotation (before de-duplication)."""
    nm = _identity_text(annotation.get('nm') or annotation.get('NM'))
    if nm:
        return f'ann:nm:{nm}'
    subtype = _identity_text(annotation.get('subtype') or annotation.get('Subtype'))
    contents = _identity_text(annotation.get('contents'))
    return f'ann:subtype={subtype}|rect={_rect_token(annotation.get("rect"))}|contents={contents}'


def link_identity(link: Mapping[str, Any]) -> str:
    """Stable base identity of a normalised link annotation."""
    nm = _identity_text(link.get('nm') or link.get('NM'))
    if nm:
        return f'link:nm:{nm}'
    rect = _rect_token(link.get('rect'))
    uri = _identity_text(link.get('uri'))
    if uri:
        return f'link:uri:{uri}|rect={rect}'
    internal_page = _int_value(link.get('internalPage'))
    if internal_page is not None:
        return f'link:page:{internal_page}|rect={rect}'
    target = _identity_text(link.get('target'))
    if target:
        return f'link:target:{target}|rect={rect}'
    return f'link:rect:{rect}'


def form_identity(form: Mapping[str, Any]) -> str:
    """Stable base identity of a normalised form widget."""
    name = _identity_text(form.get('fieldName'))
    rect = _rect_token(form.get('rect'))
    if name:
        return f'form:field={name}|rect={rect}'
    return f'form:rect:{rect}'


def resource_identity(kind: str, resource: Mapping[str, Any]) -> str:
    """Base identity for ``annotation``/``link``/``form`` resource entries."""
    normalized = str(kind or '').strip().lower()
    if normalized in ('annotation', 'annotations', 'ann'):
        return annotation_identity(resource)
    if normalized in ('link', 'links'):
        return link_identity(resource)
    if normalized in ('form', 'forms', 'widget'):
        return form_identity(resource)
    raise ValueError(f'Unsupported resource kind: {kind!r}')


def _assign_identities(
    entries: list[dict[str, Any]],
    base_identity: Any,
) -> None:
    """Set ``identity`` on every entry, suffixing same-base entries in order."""
    counts: dict[str, int] = {}
    for entry in entries:
        base = base_identity(entry)[:MAX_IDENTITY_TEXT] or 'resource'
        count = counts.get(base, 0) + 1
        counts[base] = count
        entry['identity'] = base if count == 1 else f'{base}#{count}'


# --- stable fingerprints ----------------------------------------------------


def _canonical_entry(entry: Mapping[str, Any]) -> str:
    return json.dumps(
        entry,
        sort_keys=True,
        ensure_ascii=False,
        separators=(',', ':'),
        allow_nan=False,
    )


def page_resource_digest(page_resources: Mapping[str, Any]) -> str:
    """SHA-256 of one page's annotations/links/forms, order-independent.

    Counters and the page number are intentionally excluded: the digest answers
    "are the resources of these two pages the same?" for a fast path.
    """
    payload = {
        kind: sorted(
            _canonical_entry(entry)
            for entry in (page_resources.get(kind) or ())
            if isinstance(entry, Mapping)
        )
        for kind in ('annotations', 'links', 'forms')
    }
    data = json.dumps(
        payload,
        sort_keys=True,
        ensure_ascii=False,
        separators=(',', ':'),
    )
    return hashlib.sha256(data.encode('utf-8')).hexdigest()


def resource_fingerprint(resources: Mapping[str, Any]) -> str:
    """SHA-256 over metadata, page labels and every page resource digest."""
    pages = [
        page_resource_digest(page)
        for page in (resources.get('pages') or ())
        if isinstance(page, Mapping)
    ]
    payload = {
        'metadata': resources.get('metadata') or {},
        'pageLabels': resources.get('pageLabels') or [],
        'pages': pages,
    }
    data = json.dumps(
        payload,
        sort_keys=True,
        ensure_ascii=False,
        separators=(',', ':'),
    )
    return hashlib.sha256(data.encode('utf-8')).hexdigest()


# --- per-page and document collection --------------------------------------


def _empty_page(page_num: int) -> dict[str, Any]:
    return {
        'page': page_num,
        'annotations': [],
        'links': [],
        'forms': [],
    }


def _collect_page(context: _Context, page_num: int) -> dict[str, Any]:
    page = _empty_page(page_num)
    attrs = _page_attrs(context.pages[page_num - 1])
    if not attrs:
        return page

    annots = _sequence(_get(attrs, 'Annots'))
    if not annots:
        return page
    origin = _page_origin(attrs)
    if len(annots) > MAX_ANNOTATIONS_PER_PAGE:
        _note(
            context.truncated,
            'annotationsPerPage',
            len(annots) - MAX_ANNOTATIONS_PER_PAGE,
        )
        annots = annots[:MAX_ANNOTATIONS_PER_PAGE]

    annotations: list[dict[str, Any]] = []
    links: list[dict[str, Any]] = []
    forms: list[dict[str, Any]] = []

    for raw_annot in annots:
        if context.annotation_budget <= 0:
            _note(context.truncated, 'annotations')
            continue
        try:
            annot = _mapping(raw_annot)
        except Exception:
            annot = None
        if annot is None:
            _note(context.skipped, 'annotations')
            continue
        subtype = _scalar_text(_get(annot, 'Subtype'))
        if subtype is None:
            _note(context.skipped, 'annotations')
            continue
        context.annotation_budget -= 1

        try:
            if subtype == 'Link':
                links.append(_collect_link(context, annot, origin))
            elif subtype == 'Widget':
                if context.form_count >= MAX_FORMS:
                    _note(context.truncated, 'forms')
                    continue
                forms.append(_collect_form(context, annot, raw_annot, origin))
                context.form_count += 1
            else:
                annotations.append(_collect_annotation(annot, origin))
        except Exception:
            # One malformed annotation must never fail the whole document.
            if subtype == 'Link':
                _note(context.skipped, 'links')
            elif subtype == 'Widget':
                _note(context.skipped, 'forms')
            else:
                _note(context.skipped, 'annotations')

    _assign_identities(annotations, annotation_identity)
    _assign_identities(links, link_identity)
    _assign_identities(forms, form_identity)
    page['annotations'] = annotations
    page['links'] = links
    page['forms'] = forms
    return page


def collect_document_resources(extractor: Any) -> dict[str, Any]:
    """Collect document metadata, page labels and per-page resources.

    See the module docstring for the exact shape.  Every block is best effort:
    an unreadable root degrades to an empty block and a malformed entry is
    skipped and counted, never raised.
    """
    try:
        context = _Context(extractor)
    except Exception:
        return {
            'metadata': {name: None for name, _ in _METADATA_FIELDS} | {'language': None},
            'pageLabels': [],
            'pages': [],
            'truncated': {},
            'skipped': {},
        }

    try:
        metadata = _collect_metadata(context)
    except Exception:
        metadata = {name: None for name, _ in _METADATA_FIELDS}
        metadata['language'] = None

    try:
        page_labels = _collect_page_labels(context)
    except Exception:
        page_labels = []

    pages: list[dict[str, Any]] = []
    for page_num in range(1, len(context.pages) + 1):
        try:
            pages.append(_collect_page(context, page_num))
        except Exception:
            _note(context.skipped, 'pages')
            pages.append(_empty_page(page_num))

    return {
        'metadata': metadata,
        'pageLabels': page_labels,
        'pages': pages,
        'truncated': {
            key: value for key, value in sorted(context.truncated.items()) if value
        },
        'skipped': {
            key: value for key, value in sorted(context.skipped.items()) if value
        },
    }


def collect_page_resources(extractor: Any, page_num: int) -> dict[str, Any]:
    """Collect one page's annotations, links and form widgets.

    Convenience entry point for a single page; it builds its own document
    context, so a page loop should call :func:`collect_document_resources`
    instead.  It raises ``ValueError`` for a page number outside the document
    so a stale page reference fails loudly.
    """
    if isinstance(page_num, bool) or not isinstance(page_num, int):
        raise ValueError(f'Page number must be an integer, got {page_num!r}')
    context = _Context(extractor)
    if page_num < 1 or page_num > len(context.pages):
        raise ValueError(
            f'Page {page_num} is outside this document (1..{len(context.pages)})'
        )
    return _collect_page(context, page_num)


__all__ = [
    'MAX_ANNOTATIONS',
    'MAX_ANNOTATIONS_PER_PAGE',
    'MAX_DEPTH',
    'MAX_DESTINATIONS',
    'MAX_FORMS',
    'MAX_FORM_FIELDS',
    'MAX_FORM_OPTIONS',
    'MAX_IDENTITY_TEXT',
    'MAX_METADATA_FIELDS',
    'MAX_PAGE_LABELS',
    'MAX_TEXT',
    'MAX_URL',
    'SAFE_URL_SCHEMES',
    'annotation_identity',
    'collect_document_resources',
    'collect_page_resources',
    'form_identity',
    'link_identity',
    'page_resource_digest',
    'resource_fingerprint',
    'resource_identity',
]
