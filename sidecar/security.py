"""Read-only document security resources.

The collector inspects pdfminer objects that the already-open ``PdfExtractor``
holds (``extractor._pdf.doc``).  It never executes JavaScript, follows
Launch/URI targets, opens, extracts or writes attachments, decrypts streams or
verifies signatures: every value is metadata, a bounded text preview or a hash.

Malformed references, streams and catalog entries degrade to ``None``/an empty
list (or skip one entry) instead of failing the whole request.  Output is
deterministic: no timestamps, absolute paths, random ids or environment values
are added, so the same PDF always produces the same JSON.
"""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Callable, Mapping
from typing import Any, Iterator, Optional

try:  # imported as ``sidecar.security`` (namespace package)
    from .extractor import PdfExtractor
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from extractor import PdfExtractor


# --- limits (mirrored by the plan's resource table) -------------------------

# Name tree and form field recursion.
MAX_NAME_TREE_DEPTH = 8
MAX_FIELD_DEPTH = 8
# Number of listed entries.
MAX_ATTACHMENTS = 100
MAX_JAVASCRIPT_ENTRIES = 100
MAX_ACTIONS = 500
MAX_SIGNATURES = 100
# Safety cap for field dictionaries visited while looking for signatures/AA.
MAX_FORM_FIELDS = 1000
# Display strings and bounded script previews.
MAX_TEXT = 512
MAX_SCRIPT_PREVIEW = 4096
# A JavaScript stream larger than this is not decoded for its preview.
MAX_SCRIPT_BYTES = 256 * 1024
# Attachment hashing is only attempted below this declared size.
MAX_ATTACHMENT_HASH_BYTES = 16 * 1024 * 1024

# Attachments whose name contains a path separator/parent reference or ends in
# one of these extensions are flagged for manual review (metadata only).
EXECUTABLE_EXTENSIONS = frozenset({
    '.apk', '.app', '.bash', '.bat', '.cmd', '.com', '.dll', '.exe', '.hta',
    '.jar', '.js', '.jse', '.lnk', '.msi', '.pif', '.ps1', '.psm1', '.scr',
    '.sh', '.vbe', '.vbs', '.wsf',
})

# Action subtypes that need manual confirmation before the document is opened
# or distributed.
RISKY_ACTION_TYPES = frozenset({
    'ImportData',
    'JavaScript',
    'Launch',
    'SubmitForm',
})

# Internal truncation counters.  They are not part of the public SecurityReport:
# ``security_findings`` turns non-zero counters into explicit findings so a
# capped listing can never look clean.
TRUNCATION_KEYS = (
    'actions',
    'riskyActions',
    'javascript',
    'javascriptSections',
    'attachments',
    'attachmentSections',
    'signatures',
    'formFields',
)

# PDF permission bits, read from the low bits of /Encrypt /P.
_PERMISSION_BITS = (
    ('print', 3),
    ('modify', 4),
    ('copy', 5),
    ('annotate', 6),
    ('fillForms', 9),
    ('accessibility', 10),
    ('assemble', 11),
    ('highQualityPrint', 12),
)


def _empty_truncation() -> dict[str, int]:
    # Only keys with an actual skipped item/section are present, so a clean or
    # exactly-at-cap document yields an empty, falsy record.
    return {}


def _note_truncation(truncation: dict[str, int], key: str) -> None:
    truncation[key] = truncation.get(key, 0) + 1


# --- small helpers ----------------------------------------------------------


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
    """Decode PDF text/script bytes: UTF-16 BOM, UTF-8, then Latin-1."""
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


def _bounded(value: Any, limit: int = MAX_TEXT) -> Optional[str]:
    """A stripped, length-bounded display string, or None."""
    text = _scalar_text(value)
    return None if text is None else text[:limit]


def _int_value(value: Any) -> Optional[int]:
    """An integer PDF value, or None (bool and floats are not integers here)."""
    value = _resolve(value)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _page_number(value: Any) -> Optional[int]:
    number = _int_value(value)
    return number if number is not None and number >= 1 else None


def _identity(raw_value: Any, resolved: Any) -> tuple:
    """Stable identity for cycle protection of one tree/field node."""
    objid = getattr(raw_value, 'objid', None)
    if isinstance(objid, int) and not isinstance(objid, bool):
        return ('ref', objid)
    return ('object', id(resolved))


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


def _page_numbers(pages: list[Any]) -> dict[int, int]:
    """Map pdfminer page object ids (``/P`` targets) to 1-based page numbers."""
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
        self.page_numbers = _page_numbers(self.pages)
        self.acroform = _mapping(_get(self.catalog, 'AcroForm'))


def _empty_document() -> dict[str, Any]:
    return {
        'pages': 0,
        'version': 'unknown',
        'encrypted': False,
        'xfa': False,
        'hasMetadata': False,
        'outputIntents': 0,
    }


_PDF_HEADER = re.compile(rb'%PDF-(\d+\.\d+)')


def _header_version(extractor: Any) -> Optional[str]:
    """PDF header version (``%PDF-1.4`` -> ``1.4``), or None if unreadable."""
    try:
        path = os.fspath(getattr(extractor, '_path', None))
    except Exception:
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
        text = _scalar_text(_get(source, 'Version'))
        if text:
            return text
    return _header_version(context.extractor) or 'unknown'


def _has_xfa(context: _Context) -> bool:
    """``/AcroForm /XFA`` is present and readably declared (array or stream)."""
    acroform = context.acroform
    if acroform is None:
        return False
    return _resolve(_get(acroform, 'XFA')) is not None


def _output_intent_count(context: _Context) -> int:
    intents = _sequence(_get(context.catalog, 'OutputIntents'))
    return len(intents) if intents is not None else 0


def _encrypted(context: _Context, encryption: Optional[Mapping[str, Any]]) -> bool:
    if encryption is not None:
        return True
    try:
        if getattr(context.doc, 'encryption', None):
            return True
    except Exception:
        pass
    try:
        return bool(getattr(context.pdf, 'is_encrypted', False))
    except Exception:
        return False


def _document_block(
    context: _Context,
    encryption: Optional[Mapping[str, Any]],
) -> dict[str, Any]:
    return {
        'pages': len(context.pages),
        'version': _document_version(context),
        'encrypted': _encrypted(context, encryption),
        'xfa': _has_xfa(context),
        'hasMetadata': _resolve(_get(context.catalog, 'Metadata')) is not None,
        'outputIntents': _output_intent_count(context),
    }


# --- encryption -------------------------------------------------------------


def _permissions(raw: Optional[int]) -> dict[str, Optional[Any]]:
    """Map /Encrypt /P bits 3,4,5,6,9,10,11,12 to the shared permission keys."""
    result: dict[str, Optional[Any]] = {'raw': raw}
    for key, bit in _PERMISSION_BITS:
        result[key] = None if raw is None else bool(raw & (1 << (bit - 1)))
    return result


def _encryption(context: _Context) -> Optional[dict[str, Any]]:
    params = _mapping(_get(context.trailer, 'Encrypt'))
    if params is None:
        # pdfminer keeps the resolved /Encrypt dictionary on the document.
        try:
            encryption = getattr(context.doc, 'encryption', None)
        except Exception:
            encryption = None
        if isinstance(encryption, (list, tuple)) and len(encryption) == 2:
            params = _mapping(encryption[1])
    if params is None:
        return None
    return {
        'filter': _bounded(_get(params, 'Filter')),
        'version': _int_value(_get(params, 'V')),
        'revision': _int_value(_get(params, 'R')),
        'keyLength': _int_value(_get(params, 'Length')),
        'permissions': _permissions(_int_value(_get(params, 'P'))),
    }


# --- name trees -------------------------------------------------------------


def _walk_name_tree(
    root: Any,
    visited: set[tuple],
    on_depth_truncated: Optional[Callable[[], None]] = None,
    depth: int = 0,
) -> Iterator[tuple[Any, Any]]:
    """Yield ``(key, value)`` pairs from ``/Names`` arrays and ``/Kids``.

    ``on_depth_truncated`` is called when the cut node itself carries a
    non-empty ``/Names`` array, so the caller reports skipped entries instead of
    treating an empty deep section as truncated content.
    """
    if depth >= MAX_NAME_TREE_DEPTH:
        node = _mapping(root)
        if node is None:
            return
        names = _sequence(_get(node, 'Names'))
        if on_depth_truncated is not None and names and len(names) >= 2:
            on_depth_truncated()
        return
    node = _mapping(root)
    if node is None:
        return
    identity = _identity(root, node)
    if identity in visited:
        return
    visited.add(identity)

    names = _sequence(_get(node, 'Names'))
    if names:
        for index in range(0, len(names) - 1, 2):
            yield names[index], names[index + 1]

    for kid in _sequence(_get(node, 'Kids')) or ():
        yield from _walk_name_tree(kid, visited, on_depth_truncated, depth + 1)


# --- attachments ------------------------------------------------------------


def _risky_name(name: str) -> bool:
    """Path separators/parent references and executable-looking extensions."""
    if not name:
        return False
    lowered = name.lower()
    if '/' in name or '\\' in name or '..' in name:
        return True
    dot = lowered.rfind('.')
    if dot < 0:
        return False
    return lowered[dot:] in EXECUTABLE_EXTENSIONS


def _attachment_hash(
    stream: Any,
    declared_length: Optional[int],
    params_size: Optional[int],
) -> Optional[str]:
    """SHA-256 of a small, declared-size embedded stream; never unbounded."""
    if stream is None or declared_length is None:
        return None
    if declared_length < 0 or declared_length > MAX_ATTACHMENT_HASH_BYTES:
        return None
    if params_size is not None and (
        params_size < 0 or params_size > MAX_ATTACHMENT_HASH_BYTES
    ):
        return None
    get_data = getattr(stream, 'get_data', None)
    if not callable(get_data):
        return None
    try:
        data = get_data()
    except Exception:
        return None
    if isinstance(data, (bytearray, memoryview)):
        data = bytes(data)
    if not isinstance(data, bytes):
        return None
    return hashlib.sha256(data).hexdigest()


def _attachment_entry(key: Any, raw_filespec: Any) -> Optional[dict[str, Any]]:
    filespec = _mapping(raw_filespec)
    if filespec is None:
        return None

    name = (
        _bounded(_get(filespec, 'UF'))
        or _bounded(_get(filespec, 'F'))
        or _bounded(key)
        or ''
    )
    embedded = _mapping(_get(filespec, 'EF'))
    stream = None
    if embedded is not None:
        for field in ('UF', 'F'):
            raw_stream = _get(embedded, field)
            if raw_stream is None:
                continue
            stream = _resolve(raw_stream)
            if stream is not None:
                break

    attrs = getattr(stream, 'attrs', None)
    if not isinstance(attrs, Mapping):
        attrs = {}
    params = _mapping(_get(attrs, 'Params')) or {}
    declared_length = _int_value(_get(attrs, 'Length'))
    params_size = _int_value(_get(params, 'Size'))

    # /Params /Size is the uncompressed file size when present; prefer it over
    # the encoded stream length.
    size = (
        params_size
        if params_size is not None and params_size > 0
        else declared_length
    )
    if size is not None and size < 0:
        size = None

    return {
        'name': name,
        'description': _bounded(_get(filespec, 'Desc')),
        'size': size,
        'mimeType': (
            _bounded(_get(attrs, 'Subtype'))
            or _bounded(_get(filespec, 'Subtype'))
        ),
        'modified': _bounded(_get(params, 'ModDate')),
        'sha256': _attachment_hash(stream, declared_length, params_size),
        'risky': _risky_name(name),
    }


def _collect_attachments(
    context: _Context,
    truncation: dict[str, int],
) -> list[dict[str, Any]]:
    names = _mapping(_get(context.catalog, 'Names'))
    if names is None:
        return []
    root = _get(names, 'EmbeddedFiles')
    if root is None:
        return []

    def depth_truncated() -> None:
        _note_truncation(truncation, 'attachmentSections')

    attachments: list[dict[str, Any]] = []
    for key, value in _walk_name_tree(root, set(), depth_truncated):
        try:
            entry = _attachment_entry(key, value)
        except Exception:
            continue
        if entry is None:
            continue
        if len(attachments) >= MAX_ATTACHMENTS:
            # The tree has at least one more real attachment; stop rather than
            # walking an arbitrarily large tail, but never report a clean list.
            _note_truncation(truncation, 'attachments')
            break
        attachments.append(entry)
    return attachments


# --- actions and JavaScript -------------------------------------------------


class _Collector:
    """Bounded actions, JavaScript previews and signature fields.

    The action *listing* is capped, but encounters past the cap are still
    inspected: JavaScript keeps filling its own bounded list, and skipped risky
    actions are counted so the findings can report a truncated rather than a
    clean document.
    """

    def __init__(self, truncation: dict[str, int]) -> None:
        self.actions: list[dict[str, Any]] = []
        self.javascript: list[dict[str, Any]] = []
        self.signatures: list[dict[str, Any]] = []
        self.truncation = truncation

    def add(
        self,
        raw_action: Any,
        location: str,
        page: Optional[int] = None,
        name: Optional[str] = None,
    ) -> None:
        try:
            action = _mapping(raw_action)
            if action is None:
                return
            subtype = _scalar_text(_get(action, 'S'))
            if subtype is None:
                return
            safe_page = _page_number(page)
            safe_location = _bounded(location) or ''
            risky = subtype in RISKY_ACTION_TYPES
            if len(self.actions) < MAX_ACTIONS:
                self.actions.append({
                    'location': safe_location,
                    'page': safe_page,
                    'subtype': _bounded(subtype) or '',
                    'target': _action_target(action),
                    'risky': risky,
                })
            else:
                _note_truncation(self.truncation, 'actions')
                if risky:
                    _note_truncation(self.truncation, 'riskyActions')

            if subtype != 'JavaScript':
                return
            # JavaScript has its own listing budget and is collected even when
            # the action list is already full.  Only count a truncation when a
            # readable source would actually have been omitted.
            source, truncated = _javascript_source(action)
            if source is None:
                return
            if len(self.javascript) >= MAX_JAVASCRIPT_ENTRIES:
                _note_truncation(self.truncation, 'javascript')
                return
            self.javascript.append({
                'name': _bounded(name),
                'location': safe_location,
                'page': safe_page,
                'source': source,
                'truncated': truncated,
            })
        except Exception:
            # One malformed action must not stop the rest of the document.
            return


def _filespec_display(value: Any) -> Optional[str]:
    resolved = _resolve(value)
    if isinstance(resolved, Mapping):
        return _bounded(_get(resolved, 'UF')) or _bounded(_get(resolved, 'F'))
    return _bounded(resolved)


def _destination_text(value: Any) -> Optional[str]:
    resolved = _resolve(value)
    if isinstance(resolved, (list, tuple)):
        items = list(resolved)
        return _bounded(items[0]) if items else None
    return _bounded(resolved)


def _action_target(action: Mapping[str, Any]) -> Optional[str]:
    """Display value of /URI, /F, /D or /N; references are not followed."""
    target = _bounded(_get(action, 'URI'))
    if target:
        return target
    target = _filespec_display(_get(action, 'F'))
    if target:
        return target
    target = _destination_text(_get(action, 'D'))
    if target:
        return target
    return _bounded(_get(action, 'N'))


def _javascript_source(action: Mapping[str, Any]) -> tuple[Optional[str], bool]:
    """Bounded source preview of a /JS string or stream, or ``(None, False)``."""
    value = _resolve(_get(action, 'JS'))
    if value is None:
        return None, False
    if isinstance(value, (bytes, bytearray, memoryview)):
        text = _decode_bytes(bytes(value))
    elif isinstance(value, str):
        text = value
    else:
        attrs = getattr(value, 'attrs', None)
        length = _int_value(_get(attrs, 'Length'))
        if length is None or length < 0:
            # Without a declared length, bound the encoded bytes before any
            # filter decode so an unknown stream is never decompressed blindly.
            get_rawdata = getattr(value, 'get_rawdata', None)
            if not callable(get_rawdata):
                return '', True
            try:
                raw = get_rawdata()
            except Exception:
                return '', True
            if isinstance(raw, (bytearray, memoryview)):
                raw = bytes(raw)
            if not isinstance(raw, bytes):
                return '', True
            length = len(raw)
        if length > MAX_SCRIPT_BYTES:
            return '', True
        get_data = getattr(value, 'get_data', None)
        if not callable(get_data):
            text = _scalar_text(value)
            if text is None:
                return None, False
        else:
            try:
                data = get_data()
            except Exception:
                return None, False
            if isinstance(data, (bytearray, memoryview)):
                data = bytes(data)
            if not isinstance(data, bytes):
                return None, False
            text = _decode_bytes(data)

    truncated = len(text) > MAX_SCRIPT_PREVIEW
    return text[:MAX_SCRIPT_PREVIEW], truncated


def _trigger_text(key: Any) -> str:
    if isinstance(key, str):
        return key
    return _scalar_text(key) or ''


def _add_aa(
    collector: _Collector,
    raw_aa: Any,
    base: str,
    page: Optional[int],
    name: Optional[str],
) -> None:
    """Add every action of an ``/AA`` trigger dictionary.

    Triggers are visited in sorted order for determinism.  The location is the
    trigger's owner (for example ``Page 3`` or ``Annotation 12 AA``); the shared
    contract has no separate trigger field.
    """
    aa = _mapping(raw_aa)
    if aa is None:
        return
    try:
        triggers = sorted(aa.keys(), key=_trigger_text)
    except Exception:
        return
    for trigger in triggers:
        collector.add(_get(aa, trigger), base, page, name)


def _page_attrs(page: Any) -> Mapping[str, Any]:
    if isinstance(page, Mapping):
        return page
    try:
        page_obj = getattr(page, 'page_obj', None)
        attrs = _resolve(getattr(page_obj, 'attrs', None))
    except Exception:
        return {}
    return attrs if isinstance(attrs, Mapping) else {}


def _collect_javascript_tree(
    context: _Context,
    collector: _Collector,
    truncation: dict[str, int],
) -> None:
    names = _mapping(_get(context.catalog, 'Names'))
    if names is None:
        return
    root = _get(names, 'JavaScript')
    if root is None:
        return

    def depth_truncated() -> None:
        _note_truncation(truncation, 'javascriptSections')

    for key, value in _walk_name_tree(root, set(), depth_truncated):
        collector.add(value, 'Names', None, _bounded(key))


def _collect_catalog_actions(context: _Context, collector: _Collector) -> None:
    open_action = _resolve(_get(context.catalog, 'OpenAction'))
    if isinstance(open_action, Mapping):
        collector.add(open_action, 'OpenAction')
    _add_aa(collector, _get(context.catalog, 'AA'), 'AA', None, None)


def _collect_page_actions(context: _Context, collector: _Collector) -> None:
    for page_num, page in enumerate(context.pages, start=1):
        attrs = _page_attrs(page)
        _add_aa(collector, _get(attrs, 'AA'), f'Page {page_num}', page_num, None)

        annots = _sequence(_get(attrs, 'Annots'))
        if annots is None:
            continue
        for index, raw_annot in enumerate(annots, start=1):
            annot = _mapping(raw_annot)
            if annot is None:
                continue
            name = _bounded(_get(annot, 'NM')) or _bounded(_get(annot, 'T'))
            collector.add(_get(annot, 'A'), f'Annotation {index}', page_num, name)
            _add_aa(
                collector,
                _get(annot, 'AA'),
                f'Annotation {index} AA',
                page_num,
                name,
            )


# --- form fields and signatures --------------------------------------------


def _field_page(
    node: Mapping[str, Any],
    page_numbers: Mapping[int, int],
    depth: int = 0,
) -> Optional[int]:
    """Resolve ``/P`` to a 1-based page number when it points at a page object."""
    raw_page = _get(node, 'P')
    page_id = getattr(raw_page, 'objid', None)
    if isinstance(page_id, int) and not isinstance(page_id, bool):
        number = page_numbers.get(page_id)
        if number is not None:
            return number
    page = _page_number(raw_page)
    if page is not None:
        return page
    if depth >= MAX_FIELD_DEPTH:
        return None
    for raw_kid in _sequence(_get(node, 'Kids')) or ():
        kid = _mapping(raw_kid)
        if kid is None:
            continue
        page = _field_page(kid, page_numbers, depth + 1)
        if page is not None:
            return page
    return None


def _is_widget(node: Mapping[str, Any]) -> bool:
    return _scalar_text(_get(node, 'Subtype')) == 'Widget'


def _iter_fields(
    context: _Context,
    truncation: dict[str, int],
) -> Iterator[
    tuple[Mapping[str, Any], Optional[str], Optional[str], Optional[int], bool]
]:
    """Yield ``(field, inherited FT, name, page, is_widget_child)``.

    ``/FT`` and ``/T`` are inherited down ``/Kids``; widget annotation children
    are yielded for their actions but never treated as separate fields.  A
    readable field skipped by the depth or field-count bound increments the
    ``formFields`` truncation counter.
    """
    visited: set[tuple] = set()
    produced = 0
    count_limit_hit = False

    def walk(
        raw_field: Any,
        inherited_ft: Optional[str],
        inherited_name: Optional[str],
        depth: int,
        is_widget_child: bool,
    ) -> Iterator[
        tuple[Mapping[str, Any], Optional[str], Optional[str], Optional[int], bool]
    ]:
        nonlocal produced, count_limit_hit
        node = _mapping(raw_field)
        if node is None:
            return
        identity = _identity(raw_field, node)
        if identity in visited:
            return
        visited.add(identity)
        if depth >= MAX_FIELD_DEPTH:
            _note_truncation(truncation, 'formFields')
            return
        if produced >= MAX_FORM_FIELDS:
            _note_truncation(truncation, 'formFields')
            count_limit_hit = True
            return
        produced += 1

        field_type = _scalar_text(_get(node, 'FT')) or inherited_ft
        field_name = _bounded(_get(node, 'T')) or inherited_name
        page = _field_page(node, context.page_numbers)
        yield node, field_type, field_name, page, is_widget_child

        for raw_kid in _sequence(_get(node, 'Kids')) or ():
            kid = _mapping(raw_kid)
            yield from walk(
                raw_kid,
                field_type,
                field_name,
                depth + 1,
                kid is not None and _is_widget(kid),
            )
            if count_limit_hit:
                return

    for raw_field in _sequence(_get(context.acroform, 'Fields')) or ():
        yield from walk(raw_field, None, None, 0, False)
        if count_limit_hit:
            break


def _terminal_field(
    node: Mapping[str, Any],
    is_widget_child: bool,
) -> bool:
    """True for a signature field that does not contain nested child fields."""
    if is_widget_child:
        return False
    for raw_kid in _sequence(_get(node, 'Kids')) or ():
        kid = _mapping(raw_kid)
        if kid is not None and not _is_widget(kid):
            return False
    return True


def _byte_range_valid(value: Any) -> Optional[bool]:
    """Structural ByteRange check: even non-negative pairs, starting at 0."""
    resolved = _resolve(value)
    if resolved is None:
        return None
    if not isinstance(resolved, (list, tuple)):
        return False
    if len(resolved) < 4 or len(resolved) % 2:
        return False
    numbers: list[int] = []
    for item in resolved:
        number = _int_value(item)
        if number is None or number < 0:
            return False
        numbers.append(number)
    if numbers[0] != 0:
        return False
    # The first range is the signed span; a zero-length span means there is no
    # signed content at all.
    if numbers[1] <= 0:
        return False
    for index in range(2, len(numbers), 2):
        if numbers[index] < numbers[index - 2] + numbers[index - 1]:
            return False
    return True


def _signature_entry(
    field: Mapping[str, Any],
    field_name: Optional[str],
    page: Optional[int],
) -> dict[str, Any]:
    value = _mapping(_get(field, 'V'))
    return {
        'fieldName': field_name,
        'page': page,
        'signer': _bounded(_get(value, 'Name')) if value is not None else None,
        'signedAt': _bounded(_get(value, 'M')) if value is not None else None,
        'reason': _bounded(_get(value, 'Reason')) if value is not None else None,
        'location': _bounded(_get(value, 'Location')) if value is not None else None,
        'subFilter': _bounded(_get(value, 'SubFilter')) if value is not None else None,
        'byteRangeValid': (
            _byte_range_valid(_get(value, 'ByteRange')) if value is not None else None
        ),
        # This tool never verifies signatures cryptographically.
        'verified': False,
    }


def _collect_form(
    context: _Context,
    collector: _Collector,
    truncation: dict[str, int],
) -> list[dict[str, Any]]:
    signatures: list[dict[str, Any]] = []
    for node, field_type, field_name, page, is_widget_child in _iter_fields(
        context, truncation
    ):
        try:
            if (
                not is_widget_child
                and field_type == 'Sig'
                and _terminal_field(node, is_widget_child)
            ):
                if len(signatures) < MAX_SIGNATURES:
                    signatures.append(_signature_entry(node, field_name, page))
                else:
                    _note_truncation(truncation, 'signatures')
            _add_aa(
                collector,
                _get(node, 'AA'),
                f'Field {field_name or "unnamed"} AA',
                page,
                field_name,
            )
        except Exception:
            # A single broken field degrades to nothing; the walk continues.
            continue
    return signatures


# --- collection -------------------------------------------------------------


def collect_security_with_meta(
    extractor: Any,
) -> tuple[dict[str, Any], dict[str, int]]:
    """Collect the six resource blocks plus internal truncation counters.

    The counters are not part of the public ``SecurityReport``; ``audit`` turns
    them into explicit findings so a capped listing is never reported as clean.
    """
    resources: dict[str, Any] = {
        'document': _empty_document(),
        'attachments': [],
        'javascript': [],
        'actions': [],
        'signatures': [],
        'encryption': None,
    }
    truncation = _empty_truncation()
    try:
        context = _Context(extractor)
    except Exception:
        return resources, truncation

    try:
        resources['encryption'] = _encryption(context)
    except Exception:
        resources['encryption'] = None

    try:
        resources['document'] = _document_block(context, resources['encryption'])
    except Exception:
        resources['document'] = _empty_document()
        resources['document']['pages'] = len(context.pages)

    try:
        resources['attachments'] = _collect_attachments(context, truncation)
    except Exception:
        resources['attachments'] = []

    collector = _Collector(truncation)
    try:
        _collect_javascript_tree(context, collector, truncation)
    except Exception:
        pass
    try:
        _collect_catalog_actions(context, collector)
    except Exception:
        pass
    try:
        _collect_page_actions(context, collector)
    except Exception:
        pass
    try:
        resources['signatures'] = _collect_form(context, collector, truncation)
    except Exception:
        resources['signatures'] = []
    resources['actions'] = collector.actions
    resources['javascript'] = collector.javascript

    return resources, truncation


def collect_security(extractor: Any) -> dict[str, Any]:
    """Collect the six security resource blocks for an open extractor.

    Returns ``document``, ``attachments``, ``javascript``, ``actions``,
    ``signatures`` and ``encryption``.  Every block is best effort: an
    unreadable root or one malformed entry degrades to an empty block/``None``.
    """
    return collect_security_with_meta(extractor)[0]


__all__ = [
    'EXECUTABLE_EXTENSIONS',
    'MAX_ACTIONS',
    'MAX_ATTACHMENT_HASH_BYTES',
    'MAX_ATTACHMENTS',
    'MAX_FIELD_DEPTH',
    'MAX_FORM_FIELDS',
    'MAX_JAVASCRIPT_ENTRIES',
    'MAX_NAME_TREE_DEPTH',
    'MAX_SCRIPT_BYTES',
    'MAX_SCRIPT_PREVIEW',
    'MAX_SIGNATURES',
    'MAX_TEXT',
    'RISKY_ACTION_TYPES',
    'TRUNCATION_KEYS',
    'collect_security',
    'collect_security_with_meta',
]
