"""Deterministic document audit engine.

The audit is transport agnostic: the desktop RPC, the CLI and the web server all
call :func:`audit_document`, :func:`audit_pages` and :func:`audit_file` and
serialise the returned dicts, so every surface shares one implementation.

Findings never contain timestamps or absolute paths, and they are sorted by
category (``fonts``, ``pages``, ``images``, ``metadata``, ``structure``,
``security``), then page ascending (document-level findings first), then title,
so two runs over the same file produce byte-identical JSON.

Document-level checks only read the info dictionary, the catalog and the page
dictionaries through ``PdfExtractor.get_metadata()`` / ``_page_geometry()``, so
they stay cheap on long documents.  Page-level checks call
``PdfExtractor.extract_page()``; a page that cannot be extracted becomes a
single ``error`` finding (the only ``error`` source, so ``--fail-on error`` gates
genuinely unreadable pages) and the rest of the batch is still reported.

Two implementation notes:

* ``PdfExtractor.extract_page()`` reports an image's ``width``/``height`` as the
  size it is drawn at (PDF points), not the size of its pixel grid.  The pixel
  grid is read from the same pdfplumber page image dict (``srcsize``), so the
  effective-DPI check compares pixels with the drawn box instead of comparing
  the box with itself; when ``srcsize`` cannot be read the check is skipped
  rather than guessed from the point values.
* Encrypted documents are detected through pdfminer's ``doc.encryption`` as well
  as the metadata flag: pdfplumber still reports ``is_encrypted`` for a document
  opened with an empty user password.
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Optional, Sequence, Union

try:  # imported as ``sidecar.audit`` (namespace package)
    from .diff import TOOL_NAME, tool_version
    from .extractor import PAGE_BOX_KEYS, STANDARD_14_FONTS, PdfExtractor
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from diff import TOOL_NAME, tool_version
    from extractor import PAGE_BOX_KEYS, STANDARD_14_FONTS, PdfExtractor


SCHEMA_VERSION = 1

# Emission and sort order of the finding categories.
AUDIT_CATEGORIES = ('fonts', 'pages', 'images', 'metadata', 'structure', 'security')
AUDIT_SEVERITIES = ('error', 'warning', 'info')

# Page-level checks run in batches of this size, like font analysis.
PAGE_BATCH_SIZE = 10
# An image drawn below this effective resolution is a warning.
MIN_IMAGE_DPI = 96.0

# Two numbers this close are the same page box coordinate (float noise only).
_BOX_TOLERANCE = 0.01

# ``PageData`` keys that make a page "not empty".
_CONTENT_KEYS = ('chars', 'words', 'rects', 'lines', 'curves', 'images', 'tables')

# reportlab-style subset tag in front of a BaseFont name.
_SUBSET_PREFIX = re.compile(r'^[A-Z]{6}\+')

FINDING_KEYS = (
    'category',
    'severity',
    'page',
    'title',
    'detail',
    'evidence',
    'recommendation',
)


class AuditError(ValueError):
    """Raised for an audit input that cannot be read or does not make sense.

    Subclasses :class:`ValueError` so both the CLI and the RPC layer report it as
    a user error (a message, never a traceback) through their existing paths.
    """


# --- small helpers ----------------------------------------------------------


def _text(value: Any) -> str:
    return '' if value is None else str(value)


def _optional_text(value: Any) -> Optional[str]:
    """A stripped non-empty string, or None (unreadable values count as absent)."""
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        try:
            value = bytes(value).decode('latin-1', 'replace')
        except Exception:  # pragma: no cover - defensive
            return None
    try:
        text = str(value).strip()
    except Exception:  # pragma: no cover - defensive
        return None
    return text or None


def _number(value: Any, default: float = 0.0) -> float:
    """Coerce a numeric field to a finite float, or ``default``."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def _fmt_number(value: Any) -> str:
    """Format a number without float noise: ``612``, ``595.28``, ``2.88``."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return _text(value)
    if not math.isfinite(number):
        return _text(value)
    rounded = round(number, 2)
    if rounded == int(rounded):
        return str(int(rounded))
    return f'{rounded:.2f}'.rstrip('0')


def _pages_text(pages: Iterable[int]) -> str:
    numbers = sorted(int(page) for page in pages)
    label = 'page' if len(numbers) == 1 else 'pages'
    return f'{label} ' + ', '.join(str(number) for number in numbers)


def _is_standard_14(name: Optional[str]) -> bool:
    """Standard 14 fonts are never "missing": every reader supplies them."""
    if not name:
        return False
    return name in STANDARD_14_FONTS or _SUBSET_PREFIX.sub('', name) in STANDARD_14_FONTS


def tool() -> dict[str, str]:
    """The ``{name, version}`` block every audit payload carries."""
    return {'name': TOOL_NAME, 'version': tool_version()}


def _finding(
    category: str,
    severity: str,
    page: Optional[int],
    title: str,
    detail: str,
    evidence: Optional[str] = None,
    recommendation: Optional[str] = None,
) -> dict[str, Any]:
    """Build one finding with exactly the shared contract's keys."""
    if category not in AUDIT_CATEGORIES:
        raise ValueError(f'Unknown audit category: {category!r}')
    if severity not in AUDIT_SEVERITIES:
        raise ValueError(f'Unknown audit severity: {severity!r}')
    return {
        'category': category,
        'severity': severity,
        'page': None if page is None else int(page),
        'title': title,
        'detail': detail,
        'evidence': evidence,
        'recommendation': recommendation,
    }


def _sort_key(finding: Mapping[str, Any]) -> tuple:
    page = finding.get('page')
    return (
        AUDIT_CATEGORIES.index(finding['category']),
        -1 if page is None else int(page),
        finding['title'],
        finding['detail'],
        finding.get('evidence') or '',
        finding.get('recommendation') or '',
    )


def sort_findings(findings: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Order findings: category, then page (document-level first), then title."""
    return sorted(findings, key=_sort_key)


def summarize_findings(findings: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    """Count findings by severity; the shared ``AuditSummary`` shape."""
    summary = {'total': 0, 'errors': 0, 'warnings': 0, 'info': 0}
    for finding in findings:
        summary['total'] += 1
        severity = finding.get('severity')
        if severity == 'error':
            summary['errors'] += 1
        elif severity == 'warning':
            summary['warnings'] += 1
        elif severity == 'info':
            summary['info'] += 1
    return summary


# --- document information ---------------------------------------------------


def _catalog(extractor: Any) -> Mapping[str, Any]:
    """The resolved document catalog, or an empty mapping when unreadable."""
    pdf = getattr(extractor, '_pdf', None)
    document = getattr(pdf, 'doc', None)
    catalog = getattr(document, 'catalog', None)
    catalog = PdfExtractor._resolve_pdf_value(catalog)
    return catalog if isinstance(catalog, Mapping) else {}


def _catalog_value(catalog: Mapping[str, Any], key: str) -> Any:
    try:
        return PdfExtractor._resolve_pdf_value(catalog.get(key))
    except Exception:  # pragma: no cover - a broken catalog entry
        return None


def _catalog_name(catalog: Mapping[str, Any], key: str) -> Optional[str]:
    try:
        return _optional_text(PdfExtractor._name_text(_catalog_value(catalog, key)))
    except Exception:  # pragma: no cover - a broken catalog entry
        return None


def _pdf_true(value: Any) -> bool:
    if value is True:
        return True
    if isinstance(value, str):
        return value.strip().lower() == 'true'
    name = getattr(value, 'name', None)
    if isinstance(name, bytes):
        name = name.decode('latin-1', 'replace')
    return isinstance(name, str) and name.strip().lower() == 'true'


def _is_tagged(catalog: Mapping[str, Any]) -> bool:
    """Tagged when a structure tree or ``/MarkInfo /Marked true`` exists."""
    if _catalog_value(catalog, 'StructTreeRoot') is not None:
        return True
    mark_info = _catalog_value(catalog, 'MarkInfo')
    if isinstance(mark_info, Mapping):
        marked = PdfExtractor._resolve_pdf_value(mark_info.get('Marked'))
        return _pdf_true(marked)
    return False


def _is_encrypted(extractor: Any, metadata: Mapping[str, Any]) -> bool:
    if metadata.get('encrypted'):
        return True
    document = getattr(getattr(extractor, '_pdf', None), 'doc', None)
    try:
        return bool(getattr(document, 'encryption', None))
    except Exception:  # pragma: no cover - defensive
        return False


def _document_info(extractor: Any, metadata: Mapping[str, Any]) -> dict[str, Any]:
    """Build the shared ``AuditDocumentInfo`` block from cheap document state."""
    catalog = _catalog(extractor)
    try:
        pages = max(int(metadata.get('pages') or 0), 0)
    except (TypeError, ValueError):
        pages = 0
    return {
        'pages': pages,
        'version': _optional_text(metadata.get('version')) or 'unknown',
        'encrypted': _is_encrypted(extractor, metadata),
        'title': _optional_text(metadata.get('title')),
        'author': _optional_text(metadata.get('author')),
        'producer': _optional_text(metadata.get('producer')),
        'language': _catalog_name(catalog, 'Lang'),
        'tagged': _is_tagged(catalog),
    }


def _metadata_findings(document: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Missing Title/Author/Language are diagnostics, not defects."""
    checks = (
        (
            'title',
            'Missing document title',
            'The document information dictionary has no Title, so windows, tabs '
            'and reports show a file name instead of the document name.',
            'Set the document title when producing the PDF.',
        ),
        (
            'author',
            'Missing document author',
            'The document information dictionary has no Author.',
            'Set the document author when producing the PDF.',
        ),
        (
            'language',
            'Missing document language',
            'The document catalog has no /Lang entry, so assistive technology '
            'cannot tell which language the text is in.',
            'Set the document language (for example /Lang (en-US)) when producing the PDF.',
        ),
    )
    findings = []
    for field, title, detail, recommendation in checks:
        if document.get(field):
            continue
        findings.append(
            _finding('metadata', 'info', None, title, detail, None, recommendation)
        )
    return findings


def _font_findings(metadata: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Embedding and ToUnicode checks over the existing ``fontInfo`` list."""
    findings: list[dict[str, Any]] = []
    for info in metadata.get('fontInfo') or ():
        if not isinstance(info, Mapping):
            continue
        name = _optional_text(info.get('fontname')) or 'unknown'
        embedding = _optional_text(info.get('embedding'))
        subtype = _optional_text(info.get('subtype'))
        font_file_type = _optional_text(info.get('fontFileType'))
        standard_14 = embedding == 'standard14' or _is_standard_14(name)
        evidence = (
            f'subtype={subtype or "unknown"}, fontFileType={font_file_type or "none"}'
        )

        if embedding == 'not-embedded' and not standard_14:
            findings.append(
                _finding(
                    'fonts',
                    'warning',
                    None,
                    f'Font not embedded: {name}',
                    f'Font {name} has no embedded font program, so every viewer '
                    'substitutes its own font and line breaks or glyph shapes can '
                    'change.',
                    evidence,
                    'Embed the font when producing the PDF so it renders the same '
                    'everywhere.',
                )
            )
        elif embedding == 'unknown':
            findings.append(
                _finding(
                    'fonts',
                    'info',
                    None,
                    f'Font embedding unknown: {name}',
                    f'Font {name} points at font data that cannot be read, so its '
                    'embedding state is unknown.',
                    evidence,
                    None,
                )
            )

        if (
            info.get('hasToUnicode') is False
            and not standard_14
            and subtype != 'Type3'
        ):
            findings.append(
                _finding(
                    'fonts',
                    'warning',
                    None,
                    f'Font has no ToUnicode mapping: {name}',
                    f'Font {name} has no /ToUnicode CMap, so copied, searched or '
                    'extracted text may contain wrong characters.',
                    f'subtype={subtype or "unknown"}, hasToUnicode=false',
                    'Add a ToUnicode CMap (or re-export the PDF) so text can be '
                    'copied and searched reliably.',
                )
            )
    return findings


def _security_findings(document: Mapping[str, Any]) -> list[dict[str, Any]]:
    if not document.get('encrypted'):
        return []
    return [
        _finding(
            'security',
            'warning',
            None,
            'Document is encrypted',
            'The document is encrypted, so text extraction and printing may be '
            'restricted by its permissions.',
            'encrypted=true',
            'Check the document permissions before relying on automated processing.',
        )
    ]


def _structure_findings(document: Mapping[str, Any]) -> list[dict[str, Any]]:
    if document.get('tagged'):
        return []
    return [
        _finding(
            'structure',
            'info',
            None,
            'PDF is not tagged',
            'No /StructTreeRoot and no /MarkInfo /Marked true was found, so the '
            'document is not a tagged PDF. This is a diagnostic hint, not a '
            'PDF/A certification.',
            None,
            'Tag the document if it must be accessible or its reading order must '
            'be machine readable.',
        )
    ]


# --- document-level page geometry ------------------------------------------


def _iter_pages(extractor: Any) -> list[Any]:
    """The extractor's pdfplumber pages, or an empty list when unreadable."""
    pdf = getattr(extractor, '_pdf', None)
    try:
        return list(getattr(pdf, 'pages', None) or ())
    except Exception:  # pragma: no cover - defensive
        return []


def _iter_page_geometry(extractor: Any) -> Iterator[tuple[int, Mapping[str, Any]]]:
    """Yield ``(page_number, geometry)``; a broken page is simply skipped."""
    for page_num, page in enumerate(_iter_pages(extractor), start=1):
        try:
            geometry = extractor._page_geometry(page)
        except Exception:
            continue
        if isinstance(geometry, Mapping):
            yield page_num, geometry


def _media_size(geometry: Mapping[str, Any]) -> Optional[tuple[float, float]]:
    boxes = geometry.get('boxes')
    media = boxes.get('media') if isinstance(boxes, Mapping) else None
    if not isinstance(media, Mapping):
        return None
    width = _number(media.get('x1')) - _number(media.get('x0'))
    height = _number(media.get('y1')) - _number(media.get('y0'))
    if width <= 0 or height <= 0:
        return None
    return (round(width, 2), round(height, 2))


def _box_outside(box: Mapping[str, Any], media: Mapping[str, Any]) -> bool:
    """True when any edge of ``box`` sticks out of ``media``."""
    try:
        return (
            float(box.get('x0')) < float(media.get('x0')) - _BOX_TOLERANCE
            or float(box.get('y0')) < float(media.get('y0')) - _BOX_TOLERANCE
            or float(box.get('x1')) > float(media.get('x1')) + _BOX_TOLERANCE
            or float(box.get('y1')) > float(media.get('y1')) + _BOX_TOLERANCE
        )
    except (TypeError, ValueError):
        return False


def _page_geometry_findings(extractor: Any) -> list[dict[str, Any]]:
    """Mixed sizes, rotation and page boxes that exceed the MediaBox."""
    sizes: dict[tuple[float, float], list[int]] = {}
    rotated: list[tuple[int, int]] = []
    outside: dict[str, list[int]] = {}

    for page_num, geometry in _iter_page_geometry(extractor):
        size = _media_size(geometry)
        if size is not None:
            sizes.setdefault(size, []).append(page_num)

        rotation = geometry.get('rotation') or 0
        try:
            rotation = int(rotation) % 360
        except (TypeError, ValueError):  # pragma: no cover - defensive
            rotation = 0
        if rotation:
            rotated.append((page_num, rotation))

        boxes = geometry.get('boxes')
        media = boxes.get('media') if isinstance(boxes, Mapping) else None
        if not isinstance(media, Mapping):
            continue
        for key, label in PAGE_BOX_KEYS:
            if key == 'media':
                continue
            box = boxes.get(key)
            if isinstance(box, Mapping) and _box_outside(box, media):
                outside.setdefault(label, []).append(page_num)

    findings: list[dict[str, Any]] = []

    if len(sizes) > 1:
        ordered = sorted(sizes)
        sizes_text = '; '.join(
            f'{_fmt_number(width)} x {_fmt_number(height)} pt on '
            f'{_pages_text(sizes[(width, height)])}'
            for width, height in ordered
        )
        findings.append(
            _finding(
                'pages',
                'warning',
                None,
                'Mixed page sizes',
                f'The document has {len(ordered)} distinct MediaBox sizes: '
                f'{sizes_text}.',
                '; '.join(
                    f'{_fmt_number(width)} x {_fmt_number(height)} pt'
                    for width, height in ordered
                ),
                'Use one MediaBox size for every page, or split the document.',
            )
        )

    if rotated:
        rotation_text = ', '.join(
            f'page {page_num} = {rotation}°' for page_num, rotation in rotated
        )
        label = 'page' if len(rotated) == 1 else 'pages'
        findings.append(
            _finding(
                'pages',
                'info',
                None,
                'Rotated pages',
                f'Rotated {label}: {rotation_text}. Object '
                'overlays are unavailable on rotated pages.',
                '; '.join(
                    f'page {page_num}: /Rotate {rotation}'
                    for page_num, rotation in rotated
                ),
                'Prefer unrotated page content when the page must be inspected '
                'with object overlays.',
            )
        )

    if outside:
        labels = [label for _, label in PAGE_BOX_KEYS if label in outside]
        findings.append(
            _finding(
                'pages',
                'warning',
                None,
                'Page box outside MediaBox',
                'These page boxes exceed the MediaBox: '
                + '; '.join(
                    f'{label} on {_pages_text(outside[label])}' for label in labels
                )
                + '.',
                '; '.join(
                    f'{label}: {_pages_text(outside[label])}' for label in labels
                ),
                'Adjust the page boxes so every box stays inside the MediaBox.',
            )
        )

    return findings


def _document_findings(
    extractor: Any,
    metadata: Mapping[str, Any],
    document: Mapping[str, Any],
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    findings.extend(_font_findings(metadata))
    findings.extend(_metadata_findings(document))
    findings.extend(_security_findings(document))
    findings.extend(_structure_findings(document))
    findings.extend(_page_geometry_findings(extractor))
    return findings


# --- page-level checks ------------------------------------------------------


def _resolve_range(extractor: Any, start_page: Any, end_page: Any) -> tuple[int, int]:
    """Validate a 1-based, inclusive page range, raising :class:`AuditError`."""
    validate = getattr(extractor, '_validate_page_range', None)
    try:
        if callable(validate):
            return validate(start_page, end_page)
        # Duck-typed extractor: validate with the real implementation.
        return PdfExtractor._validate_page_range(extractor, start_page, end_page)
    except AuditError:
        raise
    except ValueError as exc:
        raise AuditError(str(exc)) from exc


def _release_page_layout(extractor: Any, page_num: int) -> None:
    """Drop pdfplumber's per-page layout cache once a page has been consumed."""
    try:
        page = extractor._pdf.pages[page_num - 1]
        flush = getattr(page, 'flush_cache', None)
        if callable(flush):
            flush()
    except Exception:
        pass


def _pixel_size(
    extractor: Any,
    page_num: int,
    index: int,
) -> Optional[tuple[float, float]]:
    """Source pixel dimensions of one image, or None when they cannot be read.

    Only the page image's ``srcsize`` is valid pixel data: ``extract_page()``
    reports ``width``/``height`` as the size the image is *drawn* at in PDF
    points, so using them would compare the drawn box with itself and report 72
    dpi for every image.  When the pixel grid is unavailable the DPI check is
    skipped instead of guessing.
    """
    try:
        raw_images = list(
            getattr(extractor._pdf.pages[page_num - 1], 'images', None) or ()
        )
        if not (0 <= index < len(raw_images)):
            return None
        raw = raw_images[index]
        if not isinstance(raw, Mapping):
            return None
        candidate = raw.get('srcsize')
        pixel_width = float(candidate[0])
        pixel_height = float(candidate[1])
    except Exception:
        return None
    if pixel_width > 0 and pixel_height > 0:
        return (pixel_width, pixel_height)
    return None


def _image_findings(
    extractor: Any,
    page_num: int,
    index: int,
    image: Any,
) -> list[dict[str, Any]]:
    if not isinstance(image, Mapping):
        return []
    box_width = _number(image.get('x1')) - _number(image.get('x0'))
    box_height = _number(image.get('y1')) - _number(image.get('y0'))
    if box_width <= 0 or box_height <= 0:
        return []

    pixels = _pixel_size(extractor, page_num, index)
    if pixels is None:
        return []
    pixel_width, pixel_height = pixels

    dpi = min(
        pixel_width / (box_width / 72.0),
        pixel_height / (box_height / 72.0),
    )
    if not math.isfinite(dpi) or dpi >= MIN_IMAGE_DPI:
        return []

    evidence = (
        f'pixels {_fmt_number(pixel_width)} x {_fmt_number(pixel_height)}, '
        f'box {_fmt_number(box_width)} x {_fmt_number(box_height)} pt, '
        f'effective {_fmt_number(dpi)} dpi'
    )
    return [
        _finding(
            'images',
            'warning',
            page_num,
            f'Page {page_num} has a low-resolution image',
            f'Image {index} on page {page_num} is drawn at {_fmt_number(dpi)} dpi, '
            f'below the {_fmt_number(MIN_IMAGE_DPI)} dpi threshold, so it may look '
            'pixelated when printed or zoomed.',
            evidence,
            'Use a higher-resolution image, or draw the image at a smaller size.',
        )
    ]


def _extraction_failure(page_num: int, error: Exception) -> dict[str, Any]:
    """An unreadable page is the one genuine ``error``: `--fail-on error` gates it."""
    return _finding(
        'pages',
        'error',
        page_num,
        f'Page {page_num} could not be analysed',
        f'Extracting page {page_num} failed: {error}. The rest of the batch was '
        'still audited.',
        f'exception={type(error).__name__}',
        'Check the page content stream; the page may be damaged.',
    )


def _page_findings(
    extractor: Any,
    page_num: int,
    page_data: Any,
) -> list[dict[str, Any]]:
    if not isinstance(page_data, Mapping):
        return [
            _finding(
                'pages',
                'warning',
                page_num,
                f'Page {page_num} returned no data',
                f'Extracting page {page_num} produced no page data.',
                None,
                'Check the page content stream; the page may be damaged.',
            )
        ]

    chars = page_data.get('chars') or []
    words = page_data.get('words') or []
    images = page_data.get('images') or []
    has_content = any(page_data.get(key) for key in _CONTENT_KEYS)

    findings: list[dict[str, Any]] = []

    if not has_content:
        findings.append(
            _finding(
                'pages',
                'info',
                page_num,
                f'Page {page_num} has no content',
                f'Page {page_num} contains no text, vector or image objects.',
                None,
                None,
            )
        )

    if images and not chars and not words:
        findings.append(
            _finding(
                'images',
                'warning',
                page_num,
                f'Page {page_num} has images but no extractable text',
                f'Page {page_num} contains {len(images)} image(s) and no text '
                'layer, so it may be a scan.',
                f'images={len(images)}, characters=0, words=0',
                'Add a text layer (OCR) if the page must be searchable or '
                'accessible.',
            )
        )

    for index, image in enumerate(images):
        findings.extend(_image_findings(extractor, page_num, index, image))

    return findings


# --- public API -------------------------------------------------------------


def audit_document(extractor: Any) -> dict[str, Any]:
    """Document-level audit: ``{tool, document, findings}``.

    Reads only the info dictionary, the catalog and the page dictionaries, so it
    is cheap enough to run before the page batches.
    """
    metadata = extractor.get_metadata() or {}
    if not isinstance(metadata, Mapping):
        metadata = {}
    document = _document_info(extractor, metadata)
    findings = _document_findings(extractor, metadata, document)
    return {
        'tool': tool(),
        'document': document,
        'findings': sort_findings(findings),
    }


def audit_pages(extractor: Any, start_page: Any, end_page: Any) -> dict[str, Any]:
    """Audit pages ``start_page..end_page`` (1-based, inclusive).

    A page that cannot be extracted yields one ``error`` finding; the rest of the
    batch is still audited.
    """
    first, last = _resolve_range(extractor, start_page, end_page)
    findings: list[dict[str, Any]] = []
    for page_num in range(first, last + 1):
        try:
            page_data = extractor.extract_page(page_num)
            # The page-level checks run before the layout cache is flushed: the
            # image DPI check reads the page's ``srcsize``, which needs the page
            # object (and its content stream) still intact.
            findings.extend(_page_findings(extractor, page_num, page_data))
        except Exception as exc:
            findings.append(_extraction_failure(page_num, exc))
        finally:
            _release_page_layout(extractor, page_num)
    return {'tool': tool(), 'findings': sort_findings(findings)}


def _close_extractor(extractor: Any) -> None:
    if extractor is None:
        return
    try:
        extractor.close()
    except Exception:
        # Closing is best effort: never mask the real audit result or error.
        pass


def audit_file(path: Union[str, Path]) -> dict[str, Any]:
    """Audit a whole PDF file and return the complete ``AuditReport``."""
    target = path if isinstance(path, Path) else Path(str(path))
    extractor = None
    try:
        extractor = PdfExtractor(str(target))
    except Exception as exc:
        raise AuditError(f'Cannot open PDF {str(target)!r}: {exc}') from exc

    try:
        metadata = extractor.get_metadata() or {}
        if not isinstance(metadata, Mapping):
            metadata = {}
        document = _document_info(extractor, metadata)
        findings = list(_document_findings(extractor, metadata, document))

        page_total = int(document.get('pages') or 0)
        for start in range(1, page_total + 1, PAGE_BATCH_SIZE):
            end = min(start + PAGE_BATCH_SIZE - 1, page_total)
            findings.extend(audit_pages(extractor, start, end)['findings'])

        ordered = sort_findings(findings)
        return {
            'schemaVersion': SCHEMA_VERSION,
            'tool': tool(),
            'document': document,
            'summary': summarize_findings(ordered),
            'findings': ordered,
        }
    finally:
        _close_extractor(extractor)


__all__ = [
    'AUDIT_CATEGORIES',
    'AUDIT_SEVERITIES',
    'AuditError',
    'FINDING_KEYS',
    'MIN_IMAGE_DPI',
    'PAGE_BATCH_SIZE',
    'SCHEMA_VERSION',
    'audit_document',
    'audit_file',
    'audit_pages',
    'sort_findings',
    'summarize_findings',
    'tool',
]
