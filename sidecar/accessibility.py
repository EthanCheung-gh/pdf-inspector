"""Read-only tagged-PDF structure resources.

The collector reads only pdfminer objects that the already-open ``PdfExtractor``
holds (``extractor._pdf.doc``): the catalog, the page tree and the structure
tree.  It never walks page content streams, extracts text, computes bounding
boxes, executes scripts or opens external resources.

Output is the resource half of the shared ``AccessibilityReport``:

* ``document`` -- page count, version, encryption/tagging flags, language, title,
  resolved RoleMap and structure-tree truncation/skipped counters;
* ``structure`` -- a deterministic forest of bounded ``StructureNode`` dicts.

The second return value is an internal truncation record.  It is not part of the
public report; ``audit.py`` (work package O2) turns its counters and facts into
explicit findings so a capped parse can never look clean.  It contains bounded
counters (``nodes``, ``depth``, ``children``, ``attributes``, ``scanned``,
``roleMap``, ``parentTree``, ``skipped``, ``cycles``) and presence facts
(``roleMapCycles``, ``parentTreeEntries``, ``pagesWithStructParents``,
``pagesMissingStructParents``, ``pagesMissingStructParentsTotal``).
``roleMapCycles`` counts distinct cyclic role chains and is an anomaly fact, not
a structural truncation cap.  ``pagesMissingStructParents`` is capped at 10 page
numbers while ``pagesMissingStructParentsTotal`` counts every affected page.

Every PDF string, name and role is treated as display text.  Malformed
references, streams and dictionaries skip one entry and increment ``skipped``
instead of failing the whole request.  No timestamps, absolute paths, random ids
or environment values are added, so the same PDF always yields the same result.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any, Optional

try:  # imported as ``sidecar.accessibility`` (namespace package)
    from .extractor import PdfExtractor
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from extractor import PdfExtractor


# --- limits (mirrored by the plan's resource table) -------------------------

MAX_NODES = 5000
MAX_DEPTH = 32
MAX_CHILDREN = 200
MAX_ROLE_MAP = 100
MAX_PARENT_TREE = 10000
MAX_PARENT_TREE_DEPTH = 16
MAX_ATTRIBUTES = 20
MAX_TEXT = 512
MAX_SCANNED = 5000
# Pages missing /StructParents named by O2's per-page finding.
MAX_MISSING_STRUCT_PARENTS = 10
# A single node may follow at most this many object-reference hops.
MAX_RESOLVE = 8

# Internal truncation counter keys.  They are not part of the public
# AccessibilityReport.
TRUNCATION_KEYS = (
    'nodes',
    'depth',
    'children',
    'attributes',
    'scanned',
    'roleMap',
    'parentTree',
    'skipped',
    'cycles',
)

# Internal presence/anomaly facts (not truncation) that O2 may use for findings.
# ``roleMapCycles`` counts distinct cyclic role chains, so it must never be
# treated as a structural truncation cap.
FACT_KEYS = (
    'roleMapCycles',
    'parentTreeEntries',
    'pagesWithStructParents',
    'pagesMissingStructParents',
    'pagesMissingStructParentsTotal',
)

_PDF_HEADER = re.compile(rb'%PDF-(\d+\.\d+)')


# --- small helpers ----------------------------------------------------------


def _note(truncation: dict[str, Any], key: str, amount: int = 1) -> None:
    truncation[key] = truncation.get(key, 0) + amount


def _resolve(value: Any) -> Any:
    """Follow PDF object references (at most ``MAX_RESOLVE`` hops).

    ``PdfExtractor._resolve_pdf_value`` performs one resolution; chains longer
    than the bound resolve to ``None`` instead of being exposed or followed
    indefinitely.
    """
    for _ in range(MAX_RESOLVE):
        if not callable(getattr(value, 'resolve', None)):
            return value
        resolved = PdfExtractor._resolve_pdf_value(value)
        if resolved is None:
            return None
        if resolved is value:
            return value
        value = resolved
    return None


def _raw_get(mapping: Any, key: str) -> Any:
    """Read one key without resolving it; a broken accessor means absent."""
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


def _name_text(value: Any) -> Optional[str]:
    """Plain name text of a PDF name (``PSLiteral``), or None."""
    value = _resolve(value)
    if value is None:
        return None
    name = getattr(value, 'name', None)
    if isinstance(name, bytes):
        text = name.decode('latin-1', 'replace')
    elif isinstance(name, str):
        text = name
    elif isinstance(value, bytes):
        text = value.decode('latin-1', 'replace')
    elif isinstance(value, str):
        text = value
    else:
        return None
    text = text.strip()
    return text or None


def _text(value: Any, limit: int = MAX_TEXT) -> Optional[str]:
    """A stripped, length-bounded display string for a PDF string/name."""
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
    if not text:
        return None
    return text[:limit]


def _key_text(key: Any) -> str:
    """Dictionary key as display text (PDF names lose their slash)."""
    if isinstance(key, str):
        return key
    name = getattr(key, 'name', None)
    if isinstance(name, bytes):
        return name.decode('latin-1', 'replace')
    if isinstance(name, str):
        return name
    if isinstance(key, (bytes, bytearray, memoryview)):
        return bytes(key).decode('latin-1', 'replace')
    try:
        return str(key)
    except Exception:  # pragma: no cover - defensive
        return ''


def _int_value(value: Any) -> Optional[int]:
    """An integer PDF value, or None (booleans are not integers here)."""
    value = _resolve(value)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _object_number(value: Any) -> Optional[int]:
    """Object number of an indirect reference (or a literal integer)."""
    number = getattr(value, 'objid', None)
    if isinstance(number, int) and not isinstance(number, bool):
        return number
    return _int_value(value)


def _identity(raw_value: Any, resolved: Any) -> tuple:
    """Stable identity for cycle protection of one structure/tree node."""
    objid = getattr(raw_value, 'objid', None)
    if isinstance(objid, int) and not isinstance(objid, bool):
        return ('ref', objid)
    return ('object', id(resolved))


def _pdf_true(value: Any) -> bool:
    value = _resolve(value)
    if value is True:
        return True
    if isinstance(value, str):
        return value.strip().lower() == 'true'
    name = getattr(value, 'name', None)
    if isinstance(name, bytes):
        name = name.decode('latin-1', 'replace')
    return isinstance(name, str) and name.strip().lower() == 'true'


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
    if isinstance(page, Mapping):
        return page
    try:
        page_obj = getattr(page, 'page_obj', None)
        attrs = _resolve(getattr(page_obj, 'attrs', None))
    except Exception:
        return {}
    return attrs if isinstance(attrs, Mapping) else {}


def _page_numbers(pages: list[Any]) -> dict[int, int]:
    """Map pdfminer page object ids (``/Pg`` targets) to 1-based page numbers."""
    numbers: dict[int, int] = {}
    for index, page in enumerate(pages, start=1):
        try:
            page_obj = getattr(page, 'page_obj', None)
            page_id = getattr(page_obj, 'pageid', None)
        except Exception:
            continue
        if isinstance(page_id, int) and not isinstance(page_id, bool):
            numbers.setdefault(page_id, index)
    return numbers


class _PageIndex:
    """Resolve ``/Pg`` references to 1-based page numbers."""

    def __init__(self, pages: list[Any]) -> None:
        self._count = len(pages)
        self._numbers = _page_numbers(pages)

    def page_number(self, raw_value: Any) -> Optional[int]:
        # A reference to a page object is matched by its object id.
        page_id = getattr(raw_value, 'objid', None)
        if isinstance(page_id, int) and not isinstance(page_id, bool):
            number = self._numbers.get(page_id)
            if number is not None:
                return number
        # Malformed producers sometimes store a plain 1-based page number.  Only
        # use it when it is unambiguously inside the page range.
        number = _int_value(raw_value)
        if number is not None and 1 <= number <= self._count:
            return number
        return None


class _Context:
    """Cheap document state read once by the collector."""

    def __init__(self, extractor: Any):
        self.extractor = extractor
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
        self.page_index = _PageIndex(self.pages)
        # Existence is tracked on the raw value so an unreadable reference still
        # reports "present".
        self.struct_root_raw = _raw_get(self.catalog, 'StructTreeRoot')
        self.struct_root = _mapping(self.struct_root_raw)
        self.parent_tree_raw = _raw_get(self.struct_root, 'ParentTree')


def _empty_document() -> dict[str, Any]:
    return {
        'pages': 0,
        'version': 'unknown',
        'encrypted': False,
        'tagged': False,
        'hasStructTreeRoot': False,
        'hasParentTree': False,
        'language': None,
        'title': None,
        'roleMap': {},
        'truncated': False,
        'skipped': 0,
    }


def _header_version(extractor: Any) -> Optional[str]:
    """PDF header version (``%PDF-1.4`` -> ``1.4``), or None."""
    try:
        path = os.fspath(getattr(extractor, '_path', None))
    except (TypeError, ValueError):
        return None
    if not isinstance(path, (str, bytes)) or not path:
        return None
    try:
        with open(path, 'rb') as handle:
            header = handle.read(1024)
    except (OSError, ValueError):
        return None
    match = _PDF_HEADER.search(header)
    return match.group(1).decode('ascii', 'replace') if match else None


def _document_version(context: _Context) -> str:
    version = getattr(context.pdf, 'pdf_version', None)
    if isinstance(version, bytes):
        version = version.decode('latin-1', 'replace')
    if isinstance(version, str) and version.strip():
        return version.strip()
    for source in (context.trailer, context.catalog):
        text = _text(_raw_get(source, 'Version'))
        if text:
            return text
    return _header_version(context.extractor) or 'unknown'


def _encrypted(context: _Context) -> bool:
    if _raw_get(context.trailer, 'Encrypt') is not None:
        return True
    try:
        if getattr(context.doc, 'encryption', None):
            return True
    except Exception:  # pragma: no cover - defensive
        pass
    try:
        return bool(getattr(context.pdf, 'is_encrypted', False))
    except Exception:  # pragma: no cover - defensive
        return False


def _tagged(context: _Context) -> bool:
    """Tagged when ``/StructTreeRoot`` or ``/MarkInfo /Marked true`` exists."""
    if context.struct_root_raw is not None:
        return True
    mark_info = _mapping(_raw_get(context.catalog, 'MarkInfo'))
    if mark_info is not None:
        return _pdf_true(_raw_get(mark_info, 'Marked'))
    return False


def _document_title(context: _Context) -> Optional[str]:
    """Title from the document information dictionary, newest entry first."""
    info = _mapping(_raw_get(context.trailer, 'Info'))
    if info is not None:
        title = _text(_raw_get(info, 'Title'))
        if title:
            return title
    try:
        infos = list(getattr(context.doc, 'info', None) or ())
    except Exception:
        infos = []
    for entry in infos:
        mapping = entry if isinstance(entry, Mapping) else _mapping(entry)
        if mapping is None:
            continue
        title = _text(_raw_get(mapping, 'Title'))
        if title:
            return title
    # pdfplumber decodes the same info entries into ``PDF.metadata``; it is only
    # a fallback for wrappers that do not expose ``doc.info``.
    try:
        metadata = getattr(context.pdf, 'metadata', None)
    except Exception:
        metadata = None
    if isinstance(metadata, Mapping):
        return _text(_raw_get(metadata, 'Title'))
    return None


def _document_block(context: _Context) -> dict[str, Any]:
    return {
        'pages': len(context.pages),
        'version': _document_version(context),
        'encrypted': _encrypted(context),
        'tagged': _tagged(context),
        'hasStructTreeRoot': context.struct_root_raw is not None,
        'hasParentTree': context.parent_tree_raw is not None,
        'language': _text(_raw_get(context.catalog, 'Lang')),
        'title': _document_title(context),
        'roleMap': {},
        'truncated': False,
        'skipped': 0,
    }


# --- RoleMap ----------------------------------------------------------------


def _resolve_role(
    raw_role: Optional[str],
    role_map: Mapping[str, str],
    truncation: dict[str, Any],
    reported_cycles: set[tuple[str, ...]],
) -> str:
    """Follow RoleMap entries recursively, breaking cycles deterministically.

    A distinct cyclic role chain is reported once, no matter how many elements
    use it.  Identity mappings such as ``/P /P`` are valid and are not cycles.
    """
    if not raw_role:
        return ''
    current = raw_role
    chain: list[str] = []
    seen: set[str] = set()
    while current in role_map:
        if current in seen:
            start = chain.index(current)
            cycle = tuple(sorted(chain[start:]))
            if cycle and cycle not in reported_cycles:
                reported_cycles.add(cycle)
                _note(truncation, 'roleMapCycles')
            break
        seen.add(current)
        chain.append(current)
        target = role_map[current]
        if target == current:
            # Identity mapping: resolved, but not a cycle.
            break
        current = target
    return current


def _collect_role_map(
    struct_root: Optional[Mapping[str, Any]],
    truncation: dict[str, Any],
    collector: '_StructureCollector',
) -> tuple[dict[str, str], dict[str, str]]:
    """Return ``(resolved map, direct map)`` for the structure root's RoleMap.

    Entries are sorted by raw role name and capped at ``MAX_ROLE_MAP``; the
    resolved map is the public ``document.roleMap`` value, while the direct map
    is what node roles are resolved through.
    """
    mapping = _mapping(_raw_get(struct_root, 'RoleMap'))
    if mapping is None:
        if _raw_get(struct_root, 'RoleMap') is not None:
            # The entry exists but cannot be read: skip it without inventing a
            # mapping.
            collector.skip()
        return {}, {}
    try:
        raw_keys = list(mapping.keys())
    except Exception:
        collector.skip()
        return {}, {}

    pairs: list[tuple[str, Any]] = []
    for raw_key in raw_keys:
        text = _key_text(raw_key)
        if text:
            pairs.append((text, raw_key))
    pairs.sort(key=lambda item: item[0])
    if len(pairs) > MAX_ROLE_MAP:
        _note(truncation, 'roleMap', len(pairs) - MAX_ROLE_MAP)
        pairs = pairs[:MAX_ROLE_MAP]

    direct: dict[str, str] = {}
    for text, raw_key in pairs:
        target = _name_text(_raw_get(mapping, raw_key))
        if target is None:
            # An unreadable target leaves the role unresolved; it is a malformed
            # mapping entry rather than a role with an invented value.
            collector.skip()
            continue
        direct[text] = target

    resolved: dict[str, str] = {}
    for text in sorted(direct):
        resolved[text] = _resolve_role(
            text, direct, truncation, collector.role_cycles
        )
    return resolved, direct


# --- attributes -------------------------------------------------------------


def _attribute_value(value: Any) -> Optional[str]:
    """Bounded display value of one attribute; containers are not serialized."""
    value = _resolve(value)
    if value is None:
        return None
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return str(value)[:MAX_TEXT]
    if isinstance(value, (bytes, bytearray, memoryview)):
        text = _decode_bytes(bytes(value)).strip()
        return text[:MAX_TEXT] or None
    if isinstance(value, str):
        return value.strip()[:MAX_TEXT] or None
    name = getattr(value, 'name', None)
    if isinstance(name, (str, bytes)):
        text = _name_text(value)
        return text[:MAX_TEXT] if text else None
    if isinstance(value, (list, tuple)):
        items = list(value)
        if len(items) > 64:
            # A partial join would silently look complete; leave it unreadable.
            return None
        parts: list[str] = []
        for item in items:
            resolved_item = _resolve(item)
            if isinstance(resolved_item, (list, tuple, Mapping)):
                # Nested containers are not meaningful attribute text and are
                # never serialized recursively.
                return None
            text = _attribute_value(resolved_item)
            if text is None:
                return None
            parts.append(text)
        return ', '.join(parts)[:MAX_TEXT] or None
    # Dictionaries and streams are intentionally not serialized recursively.
    return None


def _attribute_dicts(value: Any) -> tuple[list[Mapping[str, Any]], bool]:
    """Resolve ``/A`` into dictionaries plus whether its array was cut."""
    resolved = _resolve(value)
    if isinstance(resolved, Mapping):
        return [resolved], False
    if isinstance(resolved, (list, tuple)):
        items = list(resolved)
        cut = len(items) > MAX_ATTRIBUTES
        result: list[Mapping[str, Any]] = []
        for item in items[:MAX_ATTRIBUTES]:
            mapping = _mapping(item)
            if mapping is not None:
                result.append(mapping)
        return result, cut
    return [], False


def _attributes(value: Any) -> tuple[dict[str, Optional[str]], bool]:
    """Bounded attribute map (``MAX_ATTRIBUTES`` keys) plus a truncated flag."""
    mappings, cut = _attribute_dicts(value)
    attributes: dict[str, Optional[str]] = {}
    for mapping in mappings:
        try:
            items = list(mapping.items())
        except Exception:
            continue
        key_cut = False
        for raw_key, raw_value in items:
            if len(attributes) >= MAX_ATTRIBUTES:
                cut = True
                key_cut = True
                break
            key = _key_text(raw_key)
            if not key or key in attributes:
                continue
            attributes[key] = _attribute_value(raw_value)
        if key_cut:
            break
    return attributes, cut


# --- structure tree ---------------------------------------------------------


def _kids(value: Any) -> list[Any]:
    """``/K`` entries in original order, keeping raw references for identity."""
    if value is None:
        return []
    resolved = _resolve(value)
    if resolved is None:
        # A present but unreadable /K is one malformed entry; return the raw
        # reference so the caller can count it as skipped.
        return [value]
    if isinstance(resolved, (list, tuple)):
        return list(resolved)
    return [value]


def _node(
    path: str,
    kind: str,
    role: str,
    raw_role: Optional[str],
    page: Optional[int],
    mcid: Optional[int],
    object_number: Optional[int],
) -> dict[str, Any]:
    return {
        'id': path,
        'kind': kind,
        'role': role,
        'rawRole': raw_role,
        'title': None,
        'alt': None,
        'actualText': None,
        'lang': None,
        'page': page,
        'mcid': mcid,
        'objectNumber': object_number,
        'attributes': {},
        'children': [],
        'truncated': False,
    }


class _StructureCollector:
    """Bounded, cycle-safe depth-first traversal of ``/StructTreeRoot /K``."""

    def __init__(
        self,
        role_map: Mapping[str, str],
        page_index: _PageIndex,
        truncation: dict[str, Any],
    ) -> None:
        self.role_map = role_map
        self.page_index = page_index
        self.truncation = truncation
        self.visited: set[tuple] = set()
        # Canonical role chains already reported as cyclic (one fact per chain).
        self.role_cycles: set[tuple[str, ...]] = set()
        self.node_count = 0
        self.scanned = 0
        self.skipped = 0
        self.exhausted = False

    # -- counters ---------------------------------------------------------

    def skip(self) -> None:
        self.skipped += 1
        _note(self.truncation, 'skipped')

    def _budget_exhausted(self) -> bool:
        if self.node_count >= MAX_NODES:
            self.exhausted = True
            _note(self.truncation, 'nodes')
            return True
        if self.scanned >= MAX_SCANNED:
            self.exhausted = True
            _note(self.truncation, 'scanned')
            return True
        return False

    # -- node factories ---------------------------------------------------

    def _make_node(
        self,
        path: str,
        kind: str,
        role: str,
        raw_role: Optional[str],
        page: Optional[int],
        mcid: Optional[int],
        object_number: Optional[int],
        source: Optional[Mapping[str, Any]] = None,
    ) -> dict[str, Any]:
        node = _node(path, kind, role, raw_role, page, mcid, object_number)
        if isinstance(source, Mapping):
            if kind == 'element':
                node['title'] = _text(_raw_get(source, 'T'))
                node['alt'] = _text(_raw_get(source, 'Alt'))
                node['actualText'] = _text(_raw_get(source, 'ActualText'))
                node['lang'] = _text(_raw_get(source, 'Lang'))
            attributes, cut = _attributes(_raw_get(source, 'A'))
            node['attributes'] = attributes
            if cut:
                _note(self.truncation, 'attributes')
        self.node_count += 1
        return node

    def _page_for(
        self,
        source: Mapping[str, Any],
        inherited_page: Optional[int],
    ) -> Optional[int]:
        page = self.page_index.page_number(_raw_get(source, 'Pg'))
        return inherited_page if page is None else page

    # -- entries ----------------------------------------------------------

    def _content_node(
        self,
        source: Mapping[str, Any],
        type_name: str,
        path: str,
        inherited_page: Optional[int],
    ) -> tuple[Optional[dict[str, Any]], bool]:
        page = self._page_for(source, inherited_page)
        if type_name == 'MCR':
            mcid = _int_value(_raw_get(source, 'MCID'))
            if mcid is None:
                self.skip()
                return None, False
            return self._make_node(
                path, 'mcid', 'MCID', None, page, mcid, None, source
            ), False
        object_number = _object_number(_raw_get(source, 'Obj'))
        if object_number is None:
            self.skip()
            return None, False
        return self._make_node(
            path, 'object', 'OBJR', None, page, None, object_number, source
        ), False

    def _element_node(
        self,
        raw_value: Any,
        source: Mapping[str, Any],
        path: str,
        depth: int,
        inherited_page: Optional[int],
    ) -> tuple[Optional[dict[str, Any]], bool]:
        identity = _identity(raw_value, source)
        if identity in self.visited:
            # The same StructElem is already on (or was already emitted from)
            # this traversal: stop instead of recursing forever.
            _note(self.truncation, 'cycles')
            return None, True
        self.visited.add(identity)

        raw_role = _name_text(_raw_get(source, 'S'))
        role = _resolve_role(
            raw_role, self.role_map, self.truncation, self.role_cycles
        )
        page = self._page_for(source, inherited_page)
        node = self._make_node(
            path, 'element', role, raw_role, page, None, None, source
        )

        children_raw = _kids(_raw_get(source, 'K'))
        if depth >= MAX_DEPTH:
            if children_raw:
                node['truncated'] = True
                _note(self.truncation, 'depth')
            return node, False

        emitted = 0
        for index, child_raw in enumerate(children_raw):
            if index >= MAX_CHILDREN:
                node['truncated'] = True
                _note(self.truncation, 'children')
                break
            child, cut = self._build(
                child_raw,
                f'{path}/{emitted}',
                depth + 1,
                page,
            )
            if child is not None:
                node['children'].append(child)
                emitted += 1
            if cut:
                node['truncated'] = True
            if self.exhausted:
                break
        return node, False

    def _build(
        self,
        raw_value: Any,
        path: str,
        depth: int,
        inherited_page: Optional[int],
    ) -> tuple[Optional[dict[str, Any]], bool]:
        """Build one ``/K`` entry; ``cut`` asks the parent to mark truncated."""
        if self.exhausted:
            return None, True
        if self._budget_exhausted():
            return None, True
        self.scanned += 1

        resolved = _resolve(raw_value)
        if resolved is None or isinstance(resolved, bool):
            self.skip()
            return None, False
        if isinstance(resolved, int):
            node = self._make_node(
                path, 'mcid', 'MCID', None, inherited_page, resolved, None
            )
            return node, False
        if not isinstance(resolved, Mapping):
            self.skip()
            return None, False

        type_name = _name_text(_raw_get(resolved, 'Type'))
        if type_name in ('MCR', 'OBJR'):
            return self._content_node(resolved, type_name, path, inherited_page)
        if type_name == 'StructElem':
            return self._element_node(
                raw_value, resolved, path, depth, inherited_page
            )
        if type_name is None:
            # Be liberal for producers that omit /Type on content dictionaries.
            if _raw_get(resolved, 'MCID') is not None:
                return self._content_node(
                    resolved, 'MCR', path, inherited_page
                )
            if _raw_get(resolved, 'Obj') is not None:
                return self._content_node(
                    resolved, 'OBJR', path, inherited_page
                )
            return self._element_node(
                raw_value, resolved, path, depth, inherited_page
            )
        self.skip()
        return None, False

    # -- forest -----------------------------------------------------------

    def collect(self, struct_root: Optional[Mapping[str, Any]]) -> list[dict[str, Any]]:
        if struct_root is None:
            return []
        roots: list[dict[str, Any]] = []
        emitted = 0
        for index, raw_entry in enumerate(_kids(_raw_get(struct_root, 'K'))):
            if index >= MAX_CHILDREN:
                _note(self.truncation, 'children')
                break
            node, _cut = self._build(raw_entry, str(emitted), 0, None)
            if node is not None:
                roots.append(node)
                emitted += 1
            if self.exhausted:
                break
        return roots


# --- ParentTree -------------------------------------------------------------


def _collect_parent_tree(
    raw_root: Any,
    truncation: dict[str, Any],
    collector: _StructureCollector,
) -> int:
    """Count number-tree entries, capped at ``MAX_PARENT_TREE``.

    Only leaf entry counts matter here: the public contract exposes
    ``document.hasParentTree`` and O2 needs the count/truncation flag, never the
    tree itself.
    """
    if raw_root is None:
        return 0
    root = _mapping(raw_root)
    if root is None:
        collector.skip()
        return 0

    count = 0
    visited: set[tuple] = set()

    def walk(raw_node: Any, depth: int) -> bool:
        nonlocal count
        if count >= MAX_PARENT_TREE:
            _note(truncation, 'parentTree')
            return True
        if depth >= MAX_PARENT_TREE_DEPTH:
            _note(truncation, 'parentTree')
            return True
        if len(visited) >= MAX_PARENT_TREE:
            # Empty tree nodes are not entries; cap them as well so a huge
            # /Kids forest cannot force unbounded traversal.
            _note(truncation, 'parentTree')
            return True
        node = _mapping(raw_node)
        if node is None:
            collector.skip()
            return False
        identity = _identity(raw_node, node)
        if identity in visited:
            _note(truncation, 'parentTree')
            return False
        visited.add(identity)

        nums = _sequence(_raw_get(node, 'Nums'))
        if nums:
            if len(nums) % 2:
                collector.skip()
            for _index in range(0, len(nums) - 1, 2):
                if count >= MAX_PARENT_TREE:
                    _note(truncation, 'parentTree')
                    return True
                count += 1

        for kid in _sequence(_raw_get(node, 'Kids')) or ():
            if walk(kid, depth + 1):
                return True
        return False

    walk(raw_root, 0)
    return count


def _pages_with_struct_parents(pages: list[Any]) -> int:
    """Number of pages that declare ``/StructParents`` (presence only)."""
    count = 0
    for page in pages:
        if _raw_get(_page_attrs(page), 'StructParents') is not None:
            count += 1
    return count


def _contents_has_data(value: Any) -> bool:
    """True when ``/Contents`` has data, without decoding any stream.

    A page whose content streams are all absent or declare ``/Length 0`` is
    treated as blank and is not named by the page-level finding.  A stream with
    no readable length is assumed to carry content rather than guessed blank.
    """
    if value is None:
        return False
    resolved = _resolve(value)
    if resolved is None:
        return False
    if isinstance(resolved, (list, tuple)):
        return any(_contents_has_data(item) for item in resolved)
    attrs = getattr(resolved, 'attrs', None)
    if isinstance(attrs, Mapping):
        length = _int_value(_raw_get(attrs, 'Length'))
        if length is not None:
            return length > 0
    return True


def _pages_missing_struct_parents(
    context: _Context,
) -> Optional[tuple[list[int], int]]:
    """Bounded list of affected pages plus the total affected count.

    Only a tagged document with a ``/ParentTree`` produces this fact; without a
    parent tree the omission is a document-level problem, not a per-page one.
    Pages without content (including ``/Length 0`` streams) are ignored so O2
    can name pages it can judge.  The returned list is capped at
    ``MAX_MISSING_STRUCT_PARENTS``; the count always covers every affected page.
    ``None`` means the check does not apply to this document.
    """
    if context.struct_root_raw is None or context.parent_tree_raw is None:
        return None
    missing: list[int] = []
    total = 0
    for number, page in enumerate(context.pages, start=1):
        attrs = _page_attrs(page)
        if _raw_get(attrs, 'StructParents') is not None:
            continue
        if not _contents_has_data(_raw_get(attrs, 'Contents')):
            continue
        total += 1
        if len(missing) < MAX_MISSING_STRUCT_PARENTS:
            missing.append(number)
    return missing, total


# --- collection -------------------------------------------------------------


def collect_accessibility(
    extractor: Any,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Collect the ``document``/``structure`` resource blocks.

    Returns ``(resources, truncation)``.  Every block is best effort: an
    unreadable root, one malformed structure entry or a broken reference
    degrades to an empty value/counter instead of failing the request.
    """
    resources: dict[str, Any] = {
        'document': _empty_document(),
        'structure': [],
    }
    truncation: dict[str, Any] = {}

    try:
        context = _Context(extractor)
    except Exception:
        return resources, truncation

    try:
        resources['document'] = _document_block(context)
    except Exception:
        resources['document'] = _empty_document()
        resources['document']['pages'] = len(context.pages)

    collector = _StructureCollector({}, context.page_index, truncation)

    try:
        resolved_map, direct_map = _collect_role_map(
            context.struct_root, truncation, collector
        )
    except Exception:
        resolved_map, direct_map = {}, {}
    resources['document']['roleMap'] = resolved_map
    collector.role_map = direct_map

    try:
        if context.struct_root_raw is not None and context.struct_root is None:
            collector.skip()
        resources['structure'] = collector.collect(context.struct_root)
    except Exception:
        resources['structure'] = []

    try:
        parent_count = _collect_parent_tree(
            context.parent_tree_raw, truncation, collector
        )
        if parent_count:
            truncation['parentTreeEntries'] = parent_count
    except Exception:
        pass

    try:
        page_parents = _pages_with_struct_parents(context.pages)
        if page_parents:
            truncation['pagesWithStructParents'] = page_parents
    except Exception:
        pass

    try:
        missing_parents = _pages_missing_struct_parents(context)
        if missing_parents is not None:
            missing_pages, missing_total = missing_parents
            if missing_pages:
                truncation['pagesMissingStructParents'] = missing_pages
            truncation['pagesMissingStructParentsTotal'] = missing_total
    except Exception:
        pass

    resources['document']['truncated'] = bool(
        truncation.get('nodes')
        or truncation.get('depth')
        or truncation.get('children')
        or truncation.get('scanned')
        or truncation.get('cycles')
    )
    resources['document']['skipped'] = collector.skipped
    return resources, truncation


__all__ = [
    'FACT_KEYS',
    'MAX_ATTRIBUTES',
    'MAX_CHILDREN',
    'MAX_DEPTH',
    'MAX_MISSING_STRUCT_PARENTS',
    'MAX_NODES',
    'MAX_PARENT_TREE',
    'MAX_PARENT_TREE_DEPTH',
    'MAX_RESOLVE',
    'MAX_ROLE_MAP',
    'MAX_SCANNED',
    'MAX_TEXT',
    'TRUNCATION_KEYS',
    'collect_accessibility',
]
