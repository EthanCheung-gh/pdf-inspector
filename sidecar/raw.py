"""Raw PDF object graph and decoded content streams for the Raw workspace.

Everything here reads pdfminer objects that the already-open ``PdfExtractor``
holds (``extractor._pdf`` / ``extractor._pdf.doc``). Nothing walks the page
layout, extracts text or mutates the document:

* indirect references stay references and are never resolved recursively;
* every container/string/preview is bounded (see the ``MAX_*`` constants);
* malformed objects and streams degrade to a readable summary/partial result
  instead of failing the whole request.

Payloads are plain JSON-serializable data: no timestamps, no absolute paths and
no stream bytes beyond a bounded text preview.
"""

from __future__ import annotations

import math
import os
import re
from typing import Any, Optional

from pdfminer.pdfinterp import PDFContentParser
from pdfminer.pdfdocument import PDFDocument
from pdfminer.pdfexceptions import PDFObjectNotFound
from pdfminer.pdftypes import PDFObjRef, PDFStream, resolve1
from pdfminer.psexceptions import PSEOF
from pdfminer.psparser import PSKeyword, PSLiteral


# Runtime limits, mirrored by the renderer's UI copy.
MAX_DEPTH = 4
MAX_ITEMS = 100
MAX_STRING = 4096
MAX_OPERATORS = 5000
MAX_CONTENT_STREAMS = 20

# Stream filters whose payload is an image/bitmap container, never text.
_BINARY_FILTERS = frozenset({
    'CCITTFaxDecode', 'CCF', 'DCTDecode', 'JPXDecode', 'JBIG2Decode',
})

# Container kinds that are serialized recursively (and therefore depth-capped).
_ARRAY_TYPES = (list, tuple)
_DICT_TYPES = (dict,)


class RawError(ValueError):
    """Invalid raw-object/page request; reported as an RPC error."""


# --- small helpers ----------------------------------------------------------


def _doc(extractor) -> PDFDocument:
    """Return the pdfminer document of an open extractor."""
    pdf = getattr(extractor, '_pdf', None)
    doc = getattr(pdf, 'doc', None)
    if doc is None:
        raise RawError('No PDF open')
    return doc


def _require_int(value: Any, label: str, minimum: int) -> int:
    """Validate an RPC integer argument (bool is not accepted as an int)."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise RawError(f'"{label}" must be an integer')
    if value < minimum:
        raise RawError(f'"{label}" must be at least {minimum}')
    return value


def _message(exc: BaseException) -> str:
    """A bounded, readable error text for payloads."""
    text = str(exc).strip() or type(exc).__name__
    return text[:200]


def _name_text(value: Any) -> Optional[str]:
    """Plain text of a PSLiteral/PSKeyword/bytes value, or None."""
    name = getattr(value, 'name', None)
    if isinstance(name, bytes):
        return name.decode('utf-8', 'replace')
    if isinstance(name, str):
        return name or None
    if isinstance(value, bytes):
        return value.decode('latin-1', 'replace')
    if isinstance(value, str):
        return value or None
    return None


def _key_text(key: Any) -> str:
    """Dictionary key as a JSON string; PDF names become their bare name."""
    if isinstance(key, PSLiteral):
        return _name_text(key) or ''
    if isinstance(key, bytes):
        return key.decode('latin-1', 'replace')
    return str(key)


def _decode_text(data: bytes) -> str:
    """Decode PDF bytes for display: UTF-16 BOM, UTF-8, then Latin-1."""
    if data.startswith(b'\xfe\xff'):
        return data[2:].decode('utf-16-be', 'replace')
    if data.startswith(b'\xff\xfe'):
        return data[2:].decode('utf-16-le', 'replace')
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return data.decode('latin-1')


def _looks_textual(text: str) -> bool:
    """Heuristic for text-like stream data: mostly printable characters."""
    sample = text[:MAX_STRING]
    if not sample:
        return True
    printable = sum(1 for ch in sample if ch.isprintable() or ch in '\r\n\t\f')
    return printable / len(sample) >= 0.9


def _serialize_string(value: Any) -> dict[str, Any]:
    """Bounded string value (PDF strings can be arbitrarily large)."""
    if isinstance(value, str):
        text = value
    else:
        text = _decode_text(bytes(value))
    truncated = len(text) > MAX_STRING
    return {'kind': 'string', 'value': text[:MAX_STRING], 'truncated': truncated}


def _xref_generation(doc: Any, object_number: int) -> Optional[int]:
    """Generation number of an object from the document's xrefs, if known."""
    for xref in getattr(doc, 'xrefs', None) or []:
        try:
            _strmid, _index, generation = xref.get_pos(object_number)
        except Exception:
            continue
        if isinstance(generation, int) and not isinstance(generation, bool):
            return generation
    return None


def _ref_for(value: Any, doc: Any) -> Optional[dict[str, int]]:
    """Build ``{objectNumber, generation}`` for a PDFObjRef/PDFStream."""
    object_number = getattr(value, 'objid', None)
    if not isinstance(object_number, int) or isinstance(object_number, bool):
        return None
    generation = getattr(value, 'genno', None)
    if not isinstance(generation, int) or isinstance(generation, bool):
        generation = _xref_generation(doc, object_number)
    return {
        'objectNumber': object_number,
        'generation': generation if isinstance(generation, int) else 0,
    }


# --- stream metadata / previews --------------------------------------------


def _stream_filters(stream: Any) -> list[str]:
    """Decoded filter names of a stream (never raises)."""
    try:
        pairs = stream.get_filters()
    except Exception:
        pairs = None
    if pairs is not None:
        names = []
        for item, _params in pairs:
            name = _name_text(item)
            if name:
                names.append(name)
        return names

    attrs = getattr(stream, 'attrs', None)
    if not isinstance(attrs, dict):
        return []
    try:
        value = resolve1(attrs.get('Filter'))
    except Exception:
        return []
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        value = [value]
    names = []
    for item in value:
        try:
            item = resolve1(item)
        except Exception:
            continue
        name = _name_text(item)
        if name:
            names.append(name)
    return names


def _stream_length(stream: Any) -> Optional[int]:
    """Declared /Length, falling back to the stored raw/decoded byte length."""
    attrs = getattr(stream, 'attrs', None)
    if isinstance(attrs, dict):
        try:
            length = resolve1(attrs.get('Length'))
        except Exception:
            length = None
        if isinstance(length, int) and not isinstance(length, bool):
            return length
    for attribute in ('rawdata', 'data'):
        data = getattr(stream, attribute, None)
        if isinstance(data, (bytes, bytearray, memoryview)):
            return len(data)
    return None


def _stream_subtype(stream: Any) -> Optional[str]:
    attrs = getattr(stream, 'attrs', None)
    if not isinstance(attrs, dict):
        return None
    try:
        subtype = resolve1(attrs.get('Subtype'))
    except Exception:
        return None
    return _name_text(subtype)


def _stream_preview(stream: Any) -> tuple[Optional[str], bool]:
    """Bounded decoded text preview of a stream, or ``(None, truncated)``.

    Image/binary-encoded streams are never decoded for a preview. Undecodable
    streams yield no preview rather than raising.
    """
    if _stream_subtype(stream) == 'Image':
        return None, True
    if any(name in _BINARY_FILTERS for name in _stream_filters(stream)):
        return None, True

    try:
        data = stream.get_data()
    except Exception:
        return None, True
    if not isinstance(data, (bytes, bytearray, memoryview)):
        return None, True
    data = bytes(data)
    if not data:
        return '', False

    text = _decode_text(data)
    if not _looks_textual(text):
        return None, True
    truncated = len(text) > MAX_STRING
    return text[:MAX_STRING], truncated


def _serialize_stream(stream: Any, doc: Any, depth: int) -> dict[str, Any]:
    """One RawValue stream: dict + length/filters + bounded preview."""
    attrs = getattr(stream, 'attrs', None)
    if not isinstance(attrs, dict):
        attrs = {}
    length = _stream_length(stream)
    filters = _stream_filters(stream)
    preview, truncated = _stream_preview(stream)
    return {
        'kind': 'stream',
        'dict': _serialize_dict(attrs, doc, depth + 1),
        'length': length,
        'filters': filters,
        'preview': preview,
        'truncated': truncated,
    }


# --- value serialization ----------------------------------------------------


def _serialize_array(items: Any, doc: Any, depth: int) -> dict[str, Any]:
    items = list(items)
    if depth >= MAX_DEPTH:
        return {'kind': 'array', 'items': [], 'truncated': True}
    truncated = len(items) > MAX_ITEMS
    return {
        'kind': 'array',
        'items': [serialize_value(item, doc, depth + 1) for item in items[:MAX_ITEMS]],
        'truncated': truncated,
    }


def _serialize_dict(mapping: dict, doc: Any, depth: int) -> dict[str, Any]:
    if depth >= MAX_DEPTH:
        return {'kind': 'dict', 'entries': [], 'truncated': True}
    entries = []
    truncated = len(mapping) > MAX_ITEMS
    for key, value in list(mapping.items())[:MAX_ITEMS]:
        entries.append({
            'key': _key_text(key),
            'value': serialize_value(value, doc, depth + 1),
        })
    return {'kind': 'dict', 'entries': entries, 'truncated': truncated}


def serialize_value(value: Any, doc: Any = None, depth: int = 0) -> dict[str, Any]:
    """Serialize one PDF value into the shared ``RawValue`` shape.

    Indirect references are emitted as ``ref`` and never resolved. Containers
    stop at ``MAX_DEPTH``/``MAX_ITEMS``; strings and stream previews stop at
    ``MAX_STRING``. Unknown objects degrade to a bounded placeholder string.
    """
    if value is None:
        return {'kind': 'null'}
    if isinstance(value, bool):
        return {'kind': 'boolean', 'value': value}
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            # JSON cannot represent NaN/Infinity; keep a readable string.
            return {'kind': 'string', 'value': repr(value), 'truncated': False}
        return {'kind': 'number', 'value': value}
    if isinstance(value, PDFObjRef):
        ref = _ref_for(value, doc)
        if ref is None:
            return {'kind': 'null'}
        return {'kind': 'ref', 'ref': ref}
    if isinstance(value, PDFStream):
        return _serialize_stream(value, doc, depth)
    if isinstance(value, PSLiteral):
        return {'kind': 'name', 'value': _name_text(value) or ''}
    if isinstance(value, PSKeyword):
        return {'kind': 'name', 'value': _name_text(value) or ''}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return _serialize_string(value)
    if isinstance(value, str):
        return _serialize_string(value)
    if isinstance(value, _ARRAY_TYPES):
        return _serialize_array(value, doc, depth)
    if isinstance(value, _DICT_TYPES):
        return _serialize_dict(value, doc, depth)
    return {
        'kind': 'string',
        'value': f'<unreadable {type(value).__name__}>'[:MAX_STRING],
        'truncated': False,
    }


# --- document roots ---------------------------------------------------------


def _trailer(doc: PDFDocument) -> dict[str, Any]:
    """Merged trailer of the document's xref sections.

    Entries of more recent sections win; older sections fill keys the newest
    one omits (incremental updates usually only restate changed keys).
    """
    trailer: dict[str, Any] = {}
    for xref in reversed(getattr(doc, 'xrefs', None) or []):
        try:
            section = xref.get_trailer()
        except Exception:
            continue
        if isinstance(section, dict):
            trailer.update(section)
    return trailer


def _root(label: str, value: Any, doc: Any) -> dict[str, Any]:
    """One RawRoot: referenced roots are not resolved, direct values serialize."""
    if isinstance(value, PDFObjRef):
        return {'label': label, 'ref': _ref_for(value, doc), 'value': None}
    if value is None:
        return {'label': label, 'ref': None, 'value': None}
    return {'label': label, 'ref': None, 'value': serialize_value(value, doc)}


def _catalog(doc: PDFDocument, trailer: dict[str, Any]) -> dict[str, Any]:
    catalog = getattr(doc, 'catalog', None)
    if isinstance(catalog, dict):
        return catalog
    try:
        resolved = resolve1(trailer.get('Root'))
    except Exception:
        resolved = None
    return resolved if isinstance(resolved, dict) else {}


def _document_version(
    pdf: Any,
    trailer: dict[str, Any],
    catalog: dict[str, Any],
    path: Any = None,
) -> Optional[str]:
    version = getattr(pdf, 'pdf_version', None)
    if isinstance(version, bytes):
        version = version.decode('latin-1', 'replace')
    if isinstance(version, str) and version.strip():
        return version.strip()
    for source in (trailer, catalog):
        trailer_version = _name_text(source.get('Version'))
        if trailer_version:
            return trailer_version
    return _header_version(path)


_PDF_HEADER = re.compile(rb'%PDF-(\d+\.\d+)')


def _header_version(path: Any) -> Optional[str]:
    """PDF header version (``%PDF-1.4`` -> ``1.4``), or None if unreadable."""
    try:
        path = os.fspath(path)
    except TypeError:
        return None
    if not isinstance(path, (str, bytes)) or not path:
        return None
    try:
        with open(path, 'rb') as handle:
            header = handle.read(1024)
    except OSError:
        return None
    match = _PDF_HEADER.search(header)
    if match is None:
        return None
    return match.group(1).decode('ascii', 'replace')


def raw_document(extractor) -> dict[str, Any]:
    """Trailer roots, catalog Pages ref and document metadata.

    Reads only the xref trailers and the catalog: no page/content extraction
    and no traversal of the object graph.
    """
    pdf = getattr(extractor, '_pdf', None)
    if pdf is None:
        raise RawError('No PDF open')
    doc = _doc(extractor)
    trailer = _trailer(doc)
    catalog = _catalog(doc, trailer)

    roots = [
        _root('Catalog', trailer.get('Root'), doc),
        _root('Info', trailer.get('Info'), doc),
        _root('Encrypt', trailer.get('Encrypt'), doc),
        _root('ID', trailer.get('ID'), doc),
        _root('Pages', catalog.get('Pages'), doc),
    ]

    pages = getattr(pdf, 'pages', None)
    page_count = len(pages) if pages is not None else 0
    encrypted = bool(getattr(doc, 'encryption', None))
    if not encrypted:
        encrypted = bool(getattr(pdf, 'is_encrypted', False))

    return {
        'pages': page_count,
        'version': _document_version(
            pdf, trailer, catalog, getattr(extractor, '_path', None)
        ),
        'encrypted': encrypted,
        'roots': roots,
    }


# --- single object ----------------------------------------------------------


def _summary(value: Any, doc: Any = None) -> str:
    """Short human summary of one object (used by the object panel)."""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return f'boolean {str(value).lower()}'
    if isinstance(value, (int, float)):
        return f'number {value}'
    if isinstance(value, PDFObjRef):
        ref = _ref_for(value, doc) or {'objectNumber': value.objid, 'generation': 0}
        return f'ref {ref["objectNumber"]} {ref["generation"]} R'
    if isinstance(value, PDFStream):
        length = _stream_length(value)
        amount = f'{length} bytes' if length is not None else 'unknown length'
        filters = _stream_filters(value)
        if filters:
            return f'stream ({", ".join(filters)}, {amount})'
        return f'stream ({amount})'
    if isinstance(value, dict):
        return f'dict ({len(value)} entries)'
    if isinstance(value, _ARRAY_TYPES):
        return f'array ({len(value)} items)'
    if isinstance(value, bytes):
        return f'string ({len(value)} bytes)'
    if isinstance(value, str):
        return f'string ({len(value)} chars)'
    if isinstance(value, PSLiteral):
        return f'name {_name_text(value) or ""}'.rstrip()
    return type(value).__name__


def raw_object(
    extractor,
    object_number: Any,
    generation: Any = None,
) -> dict[str, Any]:
    """Serialize one indirect object, without resolving references inside it."""
    doc = _doc(extractor)
    number = _require_int(object_number, 'object_number', 1)
    requested_generation = (
        None if generation is None else _require_int(generation, 'generation', 0)
    )

    try:
        value = doc.getobj(number)
    except PDFObjectNotFound as exc:
        raise RawError(f'Object {number} not found') from exc
    except Exception as exc:
        raise RawError(
            f'Cannot read object {number}: {type(exc).__name__}: {_message(exc)}'
        ) from exc

    actual_generation = getattr(value, 'genno', None)
    if not isinstance(actual_generation, int) or isinstance(actual_generation, bool):
        actual_generation = _xref_generation(doc, number)
    if requested_generation is not None and actual_generation is not None:
        if requested_generation != actual_generation:
            raise RawError(
                f'Object {number} has generation {actual_generation}, '
                f'not {requested_generation}'
            )
    if not isinstance(actual_generation, int):
        actual_generation = requested_generation or 0

    return {
        'ref': {'objectNumber': number, 'generation': actual_generation},
        'value': serialize_value(value, doc),
        'summary': _summary(value, doc),
    }


# --- page content streams ---------------------------------------------------


def _content_streams(page_obj: Any) -> list[Any]:
    """Raw ``contents`` list of a pdfminer page object."""
    try:
        contents = getattr(page_obj, 'contents', None) or []
    except Exception as exc:
        raise RawError(f'Cannot read page contents: {_message(exc)}') from exc
    if not isinstance(contents, (list, tuple)):
        contents = [contents]
    return list(contents)


def _as_content_stream(value: Any) -> PDFStream:
    """Resolve a page /Contents entry to a PDFStream or raise a RawError.

    ``pdfminer.pdftypes.stream_value`` silently substitutes an empty stream in
    non-strict mode; a malformed /Contents must instead be visible as an error.
    """
    try:
        resolved = resolve1(value)
    except Exception as exc:
        raise RawError(
            f'Cannot resolve stream: {type(exc).__name__}: {_message(exc)}'
        ) from exc
    if not isinstance(resolved, PDFStream):
        raise RawError(
            f'Content stream is not a stream ({type(resolved).__name__})'
        )
    return resolved


def _operator_text(keyword: Any) -> str:
    return _name_text(keyword) or str(keyword)


def _parse_content_stream(
    stream: Any,
    doc: Any,
    budget: int,
    start_index: int,
) -> tuple[list[dict[str, Any]], Optional[str], int, bool]:
    """Pair operands with content-stream operators.

    Returns ``(operators, error, used_operators, truncated)``. A malformed
    stream yields its partial operators plus an error string; it never fails the
    page.
    """
    operators: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    index = start_index
    error: Optional[str] = None
    truncated = False

    try:
        parser = PDFContentParser([stream])
    except Exception as exc:
        return [], f'{type(exc).__name__}: {_message(exc)}', 0, True

    while True:
        if len(operators) >= budget:
            truncated = True
            break
        try:
            offset, token = parser.nextobject()
        except PSEOF:
            # A clean stream ends on an operator. Trailing operands or an
            # unfinished array/dict means the tail was lost, not that the
            # stream simply ended.
            unparsed = len(pending)
            unfinished = getattr(parser, 'curtype', None)
            if unfinished or unparsed:
                if unfinished:
                    kind = {
                        'a': 'array',
                        'd': 'dictionary',
                        'p': 'procedure',
                        'inline': 'inline image',
                    }.get(unfinished, 'structure')
                    error = f'Stream ended inside an unfinished {kind}'
                    if unparsed:
                        error += f' ({unparsed} unparsed operand(s) before it)'
                else:
                    error = f'Stream ended with {unparsed} unparsed operand(s)'
                truncated = True
            break
        except Exception as exc:
            error = f'{type(exc).__name__}: {_message(exc)}'
            truncated = True
            break

        if isinstance(token, PSKeyword):
            operators.append({
                'index': index,
                'offset': int(offset) if isinstance(offset, int) else 0,
                'operator': _operator_text(token),
                'operands': pending,
            })
            pending = []
            index += 1
        else:
            pending.append(serialize_value(token, doc))

    return operators, error, len(operators), truncated


def raw_page_content(extractor, page: Any) -> dict[str, Any]:
    """Decoded content-stream operators of one 1-based page.

    Streams, operators and operands are bounded; a broken stream contributes an
    error and its partial operators while the rest of the page still loads.
    """
    pdf = getattr(extractor, '_pdf', None)
    if pdf is None:
        raise RawError('No PDF open')
    doc = _doc(extractor)
    page_number = _require_int(page, 'page', 1)

    pages = list(getattr(pdf, 'pages', None) or [])
    total = len(pages)
    if page_number > total:
        raise RawError(
            f'Page {page_number} out of range (document has {total} pages)'
        )

    page_obj = getattr(pages[page_number - 1], 'page_obj', None)
    if page_obj is None:
        raise RawError(f'Page {page_number} is not readable')

    raw_streams = _content_streams(page_obj)
    page_truncated = len(raw_streams) > MAX_CONTENT_STREAMS
    stream_entries: list[dict[str, Any]] = []
    budget = MAX_OPERATORS
    next_index = 0

    for raw_stream in raw_streams[:MAX_CONTENT_STREAMS]:
        entry: dict[str, Any] = {
            'ref': None,
            'length': None,
            'filters': [],
            'operators': [],
            'truncated': False,
            'error': None,
        }

        try:
            stream = _as_content_stream(raw_stream)
        except Exception as exc:
            entry['error'] = f'Cannot read stream: {_message(exc)}'
            entry['truncated'] = True
            page_truncated = True
            stream_entries.append(entry)
            continue

        entry['ref'] = _ref_for(stream, doc)
        entry['length'] = _stream_length(stream)
        entry['filters'] = _stream_filters(stream)

        if budget <= 0:
            entry['truncated'] = True
            page_truncated = True
            stream_entries.append(entry)
            continue

        # Decode once for a readable error instead of an opaque parser failure;
        # PDFContentParser then reuses the cached decoded bytes.
        try:
            stream.get_data()
        except Exception as exc:
            entry['error'] = (
                f'Cannot decode stream: {type(exc).__name__}: {_message(exc)}'
            )
            entry['truncated'] = True
            page_truncated = True
            stream_entries.append(entry)
            continue

        operators, error, used, truncated = _parse_content_stream(
            stream, doc, budget, next_index
        )
        entry['operators'] = operators
        entry['error'] = error
        entry['truncated'] = truncated
        if error is not None or truncated:
            page_truncated = True
        next_index += used
        budget -= used
        stream_entries.append(entry)

        if budget <= 0:
            # No operator budget left for any further stream.
            page_truncated = True
            break

    return {
        'page': page_number,
        'streams': stream_entries,
        'truncated': page_truncated,
    }
