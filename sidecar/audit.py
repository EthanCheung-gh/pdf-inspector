"""Deterministic document audit engine.

The audit is transport agnostic: the desktop RPC, the CLI and the web server all
call :func:`audit_document`, :func:`audit_pages` and :func:`audit_file` and
serialise the returned dicts, so every surface shares one implementation.

Findings never contain timestamps or absolute paths, and they are sorted by
category (``fonts``, ``pages``, ``images``, ``metadata``, ``structure``,
``security``), then page ascending (document-level findings first), then title,
so two runs over the same file produce byte-identical JSON.

Every finding also carries a stable ``fingerprint``: a hash of its category,
title, detail and evidence only, so a baseline can recognise the same problem
across runs even when it moved to another page or changed severity.  References
to the finding's own page in those texts are normalised (``Page 3`` becomes
``Page #``) before hashing; see :func:`finding_fingerprint`.  :mod:`baseline`
compares reports by it.

The ``structure`` category combines the original "not tagged" hint with the
heuristic accessibility checks in :func:`accessibility_findings`, which consume
the read-only resources collected by :mod:`accessibility`.  That inventory
(and the structure tree) is never added to ``AuditReport``; the same findings
are also available on their own through :func:`accessibility_report`.

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

import hashlib
import math
import re
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Optional, Sequence, Union

try:  # imported as ``sidecar.audit`` (namespace package)
    from .accessibility import (
        MAX_ATTRIBUTES as MAX_STRUCTURE_ATTRIBUTES,
        MAX_CHILDREN as MAX_STRUCTURE_CHILDREN,
        MAX_DEPTH as MAX_STRUCTURE_DEPTH,
        MAX_NODES as MAX_STRUCTURE_NODES,
        MAX_PARENT_TREE,
        MAX_ROLE_MAP,
        MAX_SCANNED,
        collect_accessibility,
    )
    from .diff import TOOL_NAME, tool_version
    from .extractor import PAGE_BOX_KEYS, STANDARD_14_FONTS, PdfExtractor
    from .security import (
        MAX_ACTIONS,
        MAX_ATTACHMENTS,
        MAX_JAVASCRIPT_ENTRIES,
        MAX_SIGNATURES,
        MAX_TEXT,
        collect_security_with_meta,
    )
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from accessibility import (
        MAX_ATTRIBUTES as MAX_STRUCTURE_ATTRIBUTES,
        MAX_CHILDREN as MAX_STRUCTURE_CHILDREN,
        MAX_DEPTH as MAX_STRUCTURE_DEPTH,
        MAX_NODES as MAX_STRUCTURE_NODES,
        MAX_PARENT_TREE,
        MAX_ROLE_MAP,
        MAX_SCANNED,
        collect_accessibility,
    )
    from diff import TOOL_NAME, tool_version
    from extractor import PAGE_BOX_KEYS, STANDARD_14_FONTS, PdfExtractor
    from security import (
        MAX_ACTIONS,
        MAX_ATTACHMENTS,
        MAX_JAVASCRIPT_ENTRIES,
        MAX_SIGNATURES,
        MAX_TEXT,
        collect_security_with_meta,
    )


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

# A page reference inside finding text: ``Page 7`` / ``page 7``.  Only the
# finding's own page number is normalised before hashing (see
# :func:`finding_fingerprint`), so page-scoped findings keep their identity when
# the page moves.
_PAGE_REFERENCE = re.compile(r'\b(Page|page)\s+(\d+)\b')

FINDING_KEYS = (
    'category',
    'severity',
    'page',
    'title',
    'detail',
    'evidence',
    'recommendation',
)

# Stable finding identity, appended after the seven contract keys.
FINGERPRINT_KEY = 'fingerprint'
FINGERPRINT_VERSION = 'pdf-inspector-finding-v1'
FINGERPRINT_LENGTH = 32

# Every key ``_finding()`` emits: the seven fields above plus the fingerprint.
FINDING_OUTPUT_KEYS = FINDING_KEYS + (FINGERPRINT_KEY,)


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


def _normalize_page_reference(value: Any, page: Any) -> str:
    """Replace references to the finding's own page with ``Page #``/``page #``.

    Page-scoped checks embed the page number in their title and detail
    (``Page 3 has a low-resolution image``), so a finding that moves to another
    page would otherwise hash as a different finding and be reported as
    new+fixed instead of moved.  Only the finding's own positive page number is
    normalised and the case of the word is preserved; every other number is
    hashed verbatim.  Document-level findings (``page`` ``None``) are unchanged.
    """
    text = _text(value)
    if isinstance(page, bool) or not isinstance(page, int) or page < 1:
        return text
    expected = str(page)

    def replace(match: re.Match) -> str:
        if match.group(2) != expected:
            return match.group(0)
        return f'{match.group(1)} #'

    return _PAGE_REFERENCE.sub(replace, text)


def finding_fingerprint(finding: Mapping[str, Any]) -> str:
    """Stable identity of one finding: 32 lowercase hex characters.

    Only ``category``, ``title``, ``detail`` and ``evidence`` are hashed, so the
    same problem keeps its identity when it moves to another page, when its
    severity changes or when its recommendation is reworded.  ``page``,
    ``severity`` and ``recommendation`` are deliberately excluded; a wording
    change to a hashed field is a different finding and needs a fresh baseline.

    References to the finding's own page in ``title``/``detail``/``evidence``
    are normalised before hashing: ``Page 3`` becomes ``Page #`` and ``page 3``
    becomes ``page #`` (the case of the word is preserved) when the finding is
    on page 3.  A page-scoped check therefore keeps its identity when the page
    moves, while a different page number mentioned in the same text is still
    hashed verbatim, and a document-level finding is not normalised at all.

    Missing values hash as the empty string (``None`` and ``''`` are the same
    identity); no other normalisation is applied.  The version prefix is part of
    the payload so an algorithm change can bump :data:`FINGERPRINT_VERSION` and
    make stale baselines fail to match instead of matching wrongly.
    """
    page = finding.get('page')
    payload = '\x1f'.join([
        FINGERPRINT_VERSION,
        _text(finding.get('category')),
        _normalize_page_reference(finding.get('title'), page),
        _normalize_page_reference(finding.get('detail'), page),
        _normalize_page_reference(finding.get('evidence'), page),
    ])
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()[:FINGERPRINT_LENGTH]


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
    finding = {
        'category': category,
        'severity': severity,
        'page': None if page is None else int(page),
        'title': title,
        'detail': detail,
        'evidence': evidence,
        'recommendation': recommendation,
    }
    # Computed last so every call site gets it without passing it around, and
    # the fingerprint never feeds back into its own input.
    finding[FINGERPRINT_KEY] = finding_fingerprint(finding)
    return finding


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


# --- security resources -----------------------------------------------------


def _resource_list(resources: Mapping[str, Any], key: str) -> list[Mapping[str, Any]]:
    value = resources.get(key)
    if not isinstance(value, (list, tuple)):
        return []
    return [entry for entry in value if isinstance(entry, Mapping)]


def _locations(entries: Sequence[Mapping[str, Any]]) -> list[str]:
    """Bounded, unique location/name labels for a finding's evidence line."""
    labels: list[str] = []
    seen: set[str] = set()
    for entry in entries:
        label = entry.get('location') or entry.get('name') or entry.get('fieldName')
        if not label:
            continue
        text = _text(label)[:MAX_TEXT]
        if text in seen:
            continue
        seen.add(text)
        labels.append(text)
    return labels


def _security_evidence(label: str, entries: Sequence[Mapping[str, Any]]) -> Optional[str]:
    locations = _locations(entries)
    text = f'{label}={len(entries)}'
    if locations:
        text += '; locations=' + ', '.join(locations)
    return text[:MAX_TEXT]


def _truncation_count(truncation: Optional[Mapping[str, Any]], key: str) -> int:
    """Read one internal truncation counter (booleans are accepted as 1)."""
    if not isinstance(truncation, Mapping):
        return 0
    value = truncation.get(key)
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int) and value > 0:
        return value
    return 0


def _is_automatic_javascript(location: str) -> bool:
    """OpenAction, catalog/page AA and field/annotation AA triggers."""
    return (
        location == 'OpenAction'
        or location == 'AA'
        or location.startswith('Page ')
        or ' AA' in location
    )


def _risky_action_findings(
    actions: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    checks = (
        (
            'Launch',
            'Launch action',
            'Launch actions can start an external program when the document is '
            'opened or a trigger fires. This tool never runs them.',
            'Remove the Launch action unless the document really needs to start '
            'an external program.',
        ),
        (
            'SubmitForm',
            'SubmitForm action',
            'SubmitForm actions send form data to a remote target. This tool never '
            'follows or submits them.',
            'Review the submission target before opening or distributing the '
            'document.',
        ),
        (
            'ImportData',
            'ImportData action',
            'ImportData actions read form data from an external file. This tool '
            'never follows or imports them.',
            'Review the import target before opening or distributing the document.',
        ),
    )
    findings: list[dict[str, Any]] = []
    for subtype, title, detail, recommendation in checks:
        matching = [a for a in actions if a.get('subtype') == subtype]
        if not matching:
            continue
        findings.append(
            _finding(
                'security',
                'warning',
                None,
                title,
                detail,
                _security_evidence('actions', matching),
                recommendation,
            )
        )
    return findings


def _truncation_findings(
    truncation: Optional[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Explicit findings for listings the collector actually had to skip."""
    if not isinstance(truncation, Mapping):
        return []

    findings: list[dict[str, Any]] = []

    actions = _truncation_count(truncation, 'actions')
    if actions:
        risky = _truncation_count(truncation, 'riskyActions')
        detail = (
            f'{actions} action(s) beyond the {MAX_ACTIONS}-action listing limit '
            'were not listed.'
        )
        if risky:
            detail += (
                f' {risky} of them are risky (Launch, JavaScript, SubmitForm or '
                'ImportData).'
            )
        evidence = f'limit={MAX_ACTIONS}; skipped={actions}; risky={risky}'
        findings.append(
            _finding(
                'security',
                'warning',
                None,
                'Action listing truncated',
                detail,
                evidence,
                'Review the document with another tool if every action must be '
                'enumerated.',
            )
        )

    javascript = _truncation_count(truncation, 'javascript')
    sections = _truncation_count(truncation, 'javascriptSections')
    if javascript or sections:
        detail = (
            f'{javascript} JavaScript action(s) beyond the '
            f'{MAX_JAVASCRIPT_ENTRIES}-entry listing limit were not listed.'
            if javascript
            else ''
        )
        if sections:
            detail += (
                f' At least {sections} name-tree section(s) exceeded the depth '
                'limit and were not expanded.'
            )
        findings.append(
            _finding(
                'security',
                'warning',
                None,
                'JavaScript listing truncated',
                detail.strip(),
                f'limit={MAX_JAVASCRIPT_ENTRIES}; skipped={javascript}; '
                f'sections={sections}',
                'Review the JavaScript name tree with another tool if every entry '
                'must be enumerated.',
            )
        )

    attachments = _truncation_count(truncation, 'attachments')
    sections = _truncation_count(truncation, 'attachmentSections')
    if attachments or sections:
        detail = (
            f'At least {attachments} additional embedded file(s) beyond the '
            f'{MAX_ATTACHMENTS}-entry listing limit were not listed.'
            if attachments
            else ''
        )
        if sections:
            detail += (
                f' At least {sections} name-tree section(s) exceeded the depth '
                'limit and were not expanded.'
            )
        findings.append(
            _finding(
                'security',
                'warning',
                None,
                'Attachment listing truncated',
                detail.strip(),
                f'limit={MAX_ATTACHMENTS}; skipped={attachments}; sections={sections}',
                'Review the embedded files with another tool if every attachment '
                'must be enumerated.',
            )
        )

    signatures = _truncation_count(truncation, 'signatures')
    if signatures:
        findings.append(
            _finding(
                'security',
                'info',
                None,
                'Signature listing truncated',
                f'{signatures} signature field(s) beyond the {MAX_SIGNATURES}-entry '
                'listing limit were not listed.',
                f'limit={MAX_SIGNATURES}; skipped={signatures}',
                'Review the signature fields with another tool if every field must '
                'be enumerated.',
            )
        )

    form_fields = _truncation_count(truncation, 'formFields')
    if form_fields:
        findings.append(
            _finding(
                'security',
                'warning',
                None,
                'Form field traversal truncated',
                f'{form_fields} form field(s) were skipped by the field traversal '
                'depth/count limit, so some actions or signature fields may be '
                'missing.',
                f'skipped={form_fields}',
                'Review the form fields with another tool if every field must be '
                'inspected.',
            )
        )

    return findings


def security_findings(
    resources: Mapping[str, Any],
    truncation: Optional[Mapping[str, Any]] = None,
) -> list[dict[str, Any]]:
    """Turn the security resource inventory into ``security`` findings.

    Document-level only: the inventory itself (attachments, scripts, actions,
    signatures, encryption) is not part of the audit report.  Encrypted is
    emitted exactly once even when both the document flag and the /Encrypt
    dictionary report it.  ``truncation`` carries the collector's internal
    counters; non-zero values become explicit findings instead of a silent cap.
    """
    if not isinstance(resources, Mapping):
        resources = {}
    document = resources.get('document')
    if not isinstance(document, Mapping):
        document = {}
    encryption = resources.get('encryption')
    attachments = _resource_list(resources, 'attachments')
    javascript = _resource_list(resources, 'javascript')
    actions = _resource_list(resources, 'actions')
    signatures = _resource_list(resources, 'signatures')

    findings: list[dict[str, Any]] = []

    # Exactly one encrypted warning, whether it comes from the document flag or
    # from an /Encrypt dictionary.
    if document.get('encrypted') or isinstance(encryption, Mapping):
        findings.append(
            _finding(
                'security',
                'warning',
                None,
                'Document is encrypted',
                'The document is encrypted, so text extraction and printing may be '
                'restricted by its permissions.',
                'encrypted=true',
                'Check the document permissions before relying on automated '
                'processing.',
            )
        )

    if javascript:
        findings.append(
            _finding(
                'security',
                'warning',
                None,
                'Document contains JavaScript',
                f'{len(javascript)} JavaScript action(s) were found. Sources are '
                'shown as bounded previews and are never executed.',
                _security_evidence('entries', javascript),
                'Review or remove the JavaScript before distributing this document.',
            )
        )
        automatic = [
            entry
            for entry in javascript
            if _is_automatic_javascript(_text(entry.get('location')))
        ]
        if automatic:
            findings.append(
                _finding(
                    'security',
                    'warning',
                    None,
                    'JavaScript runs automatically',
                    f'{len(automatic)} JavaScript action(s) run from OpenAction or '
                    'an /AA trigger, so they can execute when the document is '
                    'opened or an event fires.',
                    _security_evidence('entries', automatic),
                    'Confirm that the automatic JavaScript is expected, or remove '
                    'it from the document.',
                )
            )

    findings.extend(_risky_action_findings(actions))

    if document.get('xfa'):
        findings.append(
            _finding(
                'security',
                'warning',
                None,
                'Document contains an XFA form',
                'The document catalog points at an /AcroForm /XFA form, so the '
                'visible content may come from a dynamic form description.',
                'xfa=true',
                'Check the XFA form before relying on the page content.',
            )
        )

    if attachments:
        findings.append(
            _finding(
                'security',
                'info',
                None,
                'Document contains embedded files',
                f'{len(attachments)} embedded file(s) are listed as metadata only; '
                'no attachment is opened, extracted or written.',
                _security_evidence('attachments', attachments),
                'Confirm that every embedded file is expected before distributing '
                'the document.',
            )
        )
        for attachment in attachments:
            if not attachment.get('risky'):
                continue
            name = _text(attachment.get('name'))
            title = (
                f'Risky attachment name: {name}' if name else 'Risky attachment'
            )
            findings.append(
                _finding(
                    'security',
                    'warning',
                    None,
                    title,
                    f'Attachment {name!r} has a path separator, parent reference or '
                    'executable-looking extension. It is listed only; it is never '
                    'opened or extracted.',
                    f'name={name}'[:MAX_TEXT],
                    'Confirm that the attachment is expected, or remove it before '
                    'distributing the document.',
                )
            )

    if signatures:
        label = 'signature field' if len(signatures) == 1 else 'signature fields'
        title = (
            'Document has a signature field'
            if len(signatures) == 1
            else 'Document has signature fields'
        )
        findings.append(
            _finding(
                'security',
                'info',
                None,
                title,
                f'{len(signatures)} {label} were found. Signatures are reported as '
                'present but are not cryptographically verified.',
                _security_evidence('fields', signatures),
                'Verify the signature in a dedicated PDF reader if its authenticity '
                'matters.',
            )
        )

    findings.extend(_truncation_findings(truncation))

    seen: set[tuple] = set()
    unique: list[dict[str, Any]] = []
    for finding in findings:
        key = _sort_key(finding)
        if key in seen:
            continue
        seen.add(key)
        unique.append(finding)
    return sort_findings(unique)


def security_report(extractor: Any) -> dict[str, Any]:
    """The complete ``SecurityReport``: resource blocks, findings and summary."""
    resources, truncation = collect_security_with_meta(extractor)
    findings = security_findings(resources, truncation)
    return {
        'schemaVersion': SCHEMA_VERSION,
        'tool': tool(),
        'document': resources['document'],
        'attachments': resources['attachments'],
        'javascript': resources['javascript'],
        'actions': resources['actions'],
        'signatures': resources['signatures'],
        'encryption': resources['encryption'],
        'findings': findings,
        'summary': summarize_findings(findings),
    }


# --- accessibility findings -------------------------------------------------

# Standard structure types (ISO 32000-1 Table 333).  A resolved role outside
# this set is only reported when the RoleMap does not define it either.
STANDARD_STRUCTURE_ROLES = frozenset({
    'Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC',
    'TOCI', 'Index', 'NonStruct', 'Private',
    'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'L', 'LI', 'Lbl', 'LBody',
    'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
    'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot',
    'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP',
    'Figure', 'Formula', 'Form',
})

# Heading roles that carry an explicit level (the generic /H does not).
HEADING_LEVELS = {f'H{level}': level for level in range(1, 7)}

# Evidence lines name at most this many affected nodes.
MAX_EVIDENCE_NODES = 3
# Distinct unknown role names reported individually; the rest are summarised.
MAX_UNKNOWN_ROLE_FINDINGS = 20
# Per-page /StructParents findings; longer documents get a bounded list.
MAX_PAGE_FINDINGS = 10

# Resource limit shown next to each non-zero counter, for context.
_STRUCTURE_LIMITS = {
    'nodes': MAX_STRUCTURE_NODES,
    'depth': MAX_STRUCTURE_DEPTH,
    'children': MAX_STRUCTURE_CHILDREN,
    'attributes': MAX_STRUCTURE_ATTRIBUTES,
    'scanned': MAX_SCANNED,
    'roleMap': MAX_ROLE_MAP,
    'parentTree': MAX_PARENT_TREE,
}

# Counters that mean the structure tree itself was cut short.
_TREE_TRUNCATION_KEYS = (
    'nodes', 'depth', 'children', 'attributes', 'scanned', 'cycles'
)
# Counters that mean a structure listing (RoleMap/ParentTree) was cut short.
# RoleMap cycles have their own finding and are not a listing cap.
_LIST_TRUNCATION_KEYS = ('roleMap', 'parentTree')


def _iter_structure_nodes(nodes: Sequence[Any]) -> Iterator[Mapping[str, Any]]:
    """Depth-first, pre-order walk over the structure forest.

    The collector emits an acyclic, ordered forest; the ``id`` guard only keeps
    this helper safe if a caller passes hand-built data with a cycle.
    """
    stack = [node for node in reversed(nodes) if isinstance(node, Mapping)]
    seen: set[int] = set()
    while stack:
        node = stack.pop()
        identity = id(node)
        if identity in seen:
            continue
        seen.add(identity)
        yield node
        children = node.get('children')
        if isinstance(children, (list, tuple)):
            for child in reversed(children):
                if isinstance(child, Mapping):
                    stack.append(child)


def _child_roles(node: Mapping[str, Any]) -> list[str]:
    children = node.get('children')
    if not isinstance(children, (list, tuple)):
        return []
    return [
        _text(child.get('role'))
        for child in children
        if isinstance(child, Mapping)
    ]


def _table_has_rows(node: Mapping[str, Any]) -> bool:
    """True when the table has a TR child, directly or in a THead/TBody/TFoot."""
    children = node.get('children')
    if not isinstance(children, (list, tuple)):
        return False
    for child in children:
        if not isinstance(child, Mapping):
            continue
        role = _text(child.get('role'))
        if role == 'TR':
            return True
        if role in ('THead', 'TBody', 'TFoot') and 'TR' in _child_roles(child):
            return True
    return False


def _first_page(nodes: Sequence[Mapping[str, Any]]) -> Optional[int]:
    """Page of the first affected node that carries one."""
    for node in nodes:
        page = node.get('page')
        if isinstance(page, int) and not isinstance(page, bool):
            return page
    return None


def _node_label(node: Mapping[str, Any]) -> str:
    identity = _text(node.get('id')) or '?'
    role = _text(node.get('role')) or '?'
    page = node.get('page')
    if isinstance(page, int) and not isinstance(page, bool):
        return f'{identity} ({role}, page {page})'
    return f'{identity} ({role})'


def _node_evidence(
    nodes: Sequence[Mapping[str, Any]],
    limit: int = MAX_EVIDENCE_NODES,
) -> str:
    """Bounded evidence naming the first few affected node ids/roles/pages."""
    labels = [_node_label(node) for node in nodes[:limit]]
    text = 'nodes=' + ', '.join(labels) if labels else 'nodes=0'
    if len(nodes) > limit:
        text += f'; +{len(nodes) - limit} more'
    return text[:MAX_TEXT]


def _node_finding(
    severity: str,
    title: str,
    detail: str,
    nodes: Sequence[Mapping[str, Any]],
    recommendation: Optional[str],
) -> dict[str, Any]:
    """One aggregate finding for every node matching a condition."""
    affected = list(nodes)
    label = 'node' if len(affected) == 1 else 'nodes'
    return _finding(
        'structure',
        severity,
        _first_page(affected),
        title,
        f'{detail.rstrip()} {len(affected)} {label} affected.',
        _node_evidence(affected),
        recommendation,
    )


def _not_tagged_finding(document: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """The single "not tagged" hint, softened for an unreadable StructTreeRoot.

    ``document['hasStructTreeRoot']`` stays true when the catalog key exists but
    cannot be resolved, while ``tagged`` is false in that case: the document is
    not usable as tagged, but claiming that no /StructTreeRoot exists would be
    wrong.  The title and the one-finding contract never change.
    """
    has_unreadable_root = isinstance(document, Mapping) and bool(
        document.get('hasStructTreeRoot')
    )
    if has_unreadable_root:
        detail = (
            'No readable /StructTreeRoot entry and no /MarkInfo /Marked true '
            'was found, so the document cannot be used as a tagged PDF. This '
            'is a diagnostic hint, not a PDF/A certification.'
        )
    else:
        detail = (
            'No /StructTreeRoot and no /MarkInfo /Marked true was found, so the '
            'document is not a tagged PDF. This is a diagnostic hint, not a '
            'PDF/A certification.'
        )
    return _finding(
        'structure',
        'info',
        None,
        'PDF is not tagged',
        detail,
        None,
        'Tag the document if it must be accessible or its reading order must '
        'be machine readable.',
    )


def _page_struct_parent_findings(
    document: Mapping[str, Any],
    truncation: Optional[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Pages that have content but cannot point into the ParentTree.

    The collector's ``pagesMissingStructParents`` fact is authoritative: it is
    emitted only for a tagged document with a ``/ParentTree``, lists the first
    content pages without ``/StructParents`` (bounded) and is absent when there
    is no such page.  The fact is therefore exactly what this check needs:

    * present list -- name those pages (filtered to the page range,
      de-duplicated and bounded by ``MAX_PAGE_FINDINGS``);
    * ``pagesMissingStructParentsTotal`` -- when present, the real number of
      affected pages, so the "Only the first 10 of N" suffix is correct even
      though the list itself is capped.  Older collector records without it fall
      back to ``len(pagesMissingStructParents)``;
    * present but unreadable -- treat as unknown and skip rather than guess;
    * absent -- no content page is missing an entry, so emit nothing.  Pages
      without content are intentionally ignored by the collector, so a
      document-level "every page is missing" claim would be wrong.

    When no collector record is supplied at all, the fact is unavailable and
    the check is skipped.
    """
    if not isinstance(truncation, Mapping):
        return []
    if 'pagesMissingStructParents' not in truncation:
        return []
    pages = document.get('pages')
    if not isinstance(pages, int) or isinstance(pages, bool) or pages <= 0:
        return []

    raw_missing = truncation.get('pagesMissingStructParents')
    if not isinstance(raw_missing, (list, tuple)):
        return []
    missing = sorted({
        page
        for page in raw_missing
        if isinstance(page, int)
        and not isinstance(page, bool)
        and 1 <= page <= pages
    })
    listed = missing[:MAX_PAGE_FINDINGS]

    # The total is only trusted when it is a sane bound: at least the pages
    # actually listed and no more than the document's page count.
    raw_total = truncation.get('pagesMissingStructParentsTotal')
    if (
        isinstance(raw_total, int)
        and not isinstance(raw_total, bool)
        and len(missing) <= raw_total <= pages
    ):
        total_affected = raw_total
        total_fact = f'; pagesMissingStructParentsTotal={raw_total}'
    else:
        total_affected = len(missing)
        total_fact = ''
    evidence = (
        f'pages={pages}; pagesMissingStructParents={len(missing)}'
        f'{total_fact}; listed={len(listed)}'
    )

    findings: list[dict[str, Any]] = []
    for page in listed:
        detail = (
            f'Page {page} has no /StructParents entry while the document has a '
            '/ParentTree, so its content items cannot be mapped to structure '
            'elements.'
        )
        if total_affected > len(listed):
            detail += (
                f' Only the first {len(listed)} of {total_affected} affected '
                'pages are listed.'
            )
        findings.append(
            _finding(
                'structure',
                'warning',
                page,
                f'Page {page} has no structure parent entry',
                detail,
                evidence,
                'Add a /StructParents entry to every page that has content.',
            )
        )
    return findings


def _heading_skip_findings(
    nodes: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """A heading level may go down freely but not up by more than one.

    A skip is only reported after a previous heading in tree order.  A document
    that starts at H2 is not flagged: the missing H1 may live in a part of the
    publication that is not in this tagged tree.
    """
    skips: list[tuple[int, int, Mapping[str, Any]]] = []
    previous: Optional[int] = None
    for node in nodes:
        level = HEADING_LEVELS.get(_text(node.get('role')))
        if level is None:
            continue
        if previous is not None and level > previous + 1:
            skips.append((previous, level, node))
        previous = level
    if not skips:
        return []

    parts = [
        f'H{previous} -> H{level} at {_node_label(node)}'
        for previous, level, node in skips[:MAX_EVIDENCE_NODES]
    ]
    evidence = '; '.join(parts)
    if len(skips) > MAX_EVIDENCE_NODES:
        evidence += f'; +{len(skips) - MAX_EVIDENCE_NODES} more'
    label = 'gap' if len(skips) == 1 else 'gaps'
    return [
        _finding(
            'structure',
            'warning',
            _first_page([node for _, _, node in skips]),
            'Heading levels are skipped',
            f'Heading levels jump by more than one in tree order '
            f'({len(skips)} {label}), so the outline has missing levels.',
            evidence[:MAX_TEXT],
            'Use consecutive heading levels (H1, H2, H3, ...) in reading order.',
        )
    ]


def _accessibility_truncation_findings(
    truncation: Optional[Mapping[str, Any]],
    document: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Explicit findings for capped structure parsing and skipped entries."""
    findings: list[dict[str, Any]] = []

    tree_counts = {
        key: _truncation_count(truncation, key) for key in _TREE_TRUNCATION_KEYS
    }
    list_counts = {
        key: _truncation_count(truncation, key) for key in _LIST_TRUNCATION_KEYS
    }
    tree_counts = {key: value for key, value in tree_counts.items() if value}
    list_counts = {key: value for key, value in list_counts.items() if value}

    if tree_counts or list_counts:
        parts = []
        for key, value in {**tree_counts, **list_counts}.items():
            limit = _STRUCTURE_LIMITS.get(key)
            parts.append(
                f'{key}={value}' + (f' (limit {limit})' if limit else '')
            )
        if tree_counts:
            detail = (
                'The structure tree hit a resource limit, so some elements are '
                'missing and the accessibility checks may be incomplete.'
            )
        else:
            detail = (
                'The RoleMap or ParentTree listing hit a limit, so some entries '
                'are missing and the accessibility checks may be incomplete.'
            )
        findings.append(
            _finding(
                'structure',
                'warning',
                None,
                'Structure tree truncated',
                detail,
                '; '.join(parts)[:MAX_TEXT],
                'Review the structure tree with another tool if every element '
                'must be inspected.',
            )
        )

    skipped = _truncation_count(truncation, 'skipped')
    if not skipped:
        # The document block carries the same counter when only it was passed.
        skipped = _truncation_count(document, 'skipped')
    if skipped:
        label = 'element' if skipped == 1 else 'elements'
        findings.append(
            _finding(
                'structure',
                'warning',
                None,
                f'Accessibility parse skipped {skipped} {label}',
                'Malformed or unreadable structure entries were skipped, so the '
                'structure tree may be incomplete.',
                f'skipped={skipped}',
                'Check the structure tree with another tool if every element '
                'must be inspectable.',
            )
        )

    return findings


def accessibility_findings(
    resources: Mapping[str, Any],
    truncation: Optional[Mapping[str, Any]] = None,
) -> list[dict[str, Any]]:
    """Turn the accessibility resources into ``structure`` findings.

    Every check is heuristic: the result says "this common PDF/UA requirement
    looks unmet", never that the document is or is not PDF/UA conformant.  The
    page-level ``/StructParents`` check consumes the collector's exact
    ``pagesMissingStructParents`` fact (see
    :func:`_page_struct_parent_findings`) and is skipped when that fact is
    unavailable instead of guessing.

    Findings are aggregated per condition: evidence names the first few node
    ids/roles/pages (bounded by ``MAX_EVIDENCE_NODES``) instead of one finding
    per node.  Distinct unknown role names are listed individually up to
    ``MAX_UNKNOWN_ROLE_FINDINGS``; the remainder becomes one summary finding.
    The single "PDF is not tagged" finding replaces the whole check set for an
    untagged document, so it is never duplicated.

    ``truncation`` carries the collector's internal record: truncation counters
    plus presence facts such as ``pagesMissingStructParents``.  Non-zero
    truncation counters become explicit findings so a capped parse can never
    look clean, while facts only refine a check's evidence.  ``roleMapCycles``
    is always consumed by the dedicated RoleMap finding and is never part of
    the generic truncation counters, whichever category the collector records
    it under.
    """
    if not isinstance(resources, Mapping):
        resources = {}
    document = resources.get('document')
    if not isinstance(document, Mapping):
        document = {}

    if not document.get('tagged'):
        return [_not_tagged_finding(document)]

    structure = resources.get('structure')
    if not isinstance(structure, (list, tuple)):
        structure = []
    nodes = list(_iter_structure_nodes(list(structure)))

    findings: list[dict[str, Any]] = []

    has_root = bool(document.get('hasStructTreeRoot'))
    has_parent_tree = bool(document.get('hasParentTree'))

    if has_root and not has_parent_tree:
        findings.append(
            _finding(
                'structure',
                'warning',
                None,
                'Structure tree has no ParentTree',
                'The catalog has a /StructTreeRoot but no /ParentTree, so '
                'assistive technology cannot map content items (MCIDs) back to '
                'their structure elements.',
                'hasStructTreeRoot=true; hasParentTree=false',
                'Add a /ParentTree number tree (and a /StructParents entry per '
                'page) when producing the PDF.',
            )
        )
    elif has_root and has_parent_tree:
        findings.extend(_page_struct_parent_findings(document, truncation))

    role_map = document.get('roleMap')
    if not isinstance(role_map, Mapping):
        role_map = {}

    missing_role = [
        node
        for node in nodes
        if node.get('kind') == 'element' and not _text(node.get('role'))
    ]
    if missing_role:
        findings.append(
            _node_finding(
                'warning',
                'Structure element has no role',
                'Structure elements have no readable /S role, so their '
                'semantics are unknown.',
                missing_role,
                'Assign a standard structure role (/S) to every structure '
                'element.',
            )
        )

    unknown: dict[str, list[Mapping[str, Any]]] = {}
    for node in nodes:
        if node.get('kind') != 'element':
            # MCID/OBJR content placeholders are roles in the tree shape, not
            # structure elements, and must never look like unknown roles.
            continue
        role = _text(node.get('role'))
        if not role:
            continue
        raw_role = _text(node.get('rawRole')) or role
        if raw_role in role_map or role in STANDARD_STRUCTURE_ROLES:
            continue
        unknown.setdefault(role, []).append(node)
    for role in sorted(unknown)[:MAX_UNKNOWN_ROLE_FINDINGS]:
        affected = unknown[role]
        findings.append(
            _finding(
                'structure',
                'warning',
                _first_page(affected),
                f'Unknown structure role: {role}',
                f'Role {role!r} is not a standard structure role and is not '
                'defined in the RoleMap.',
                _node_evidence(affected),
                'Map custom roles to a standard role in /RoleMap, or use a '
                'standard role.',
            )
        )
    extra_roles = sorted(unknown)[MAX_UNKNOWN_ROLE_FINDINGS:]
    if extra_roles:
        names = ', '.join(extra_roles[:MAX_EVIDENCE_NODES])
        findings.append(
            _finding(
                'structure',
                'warning',
                None,
                'Unknown structure roles',
                f'{len(extra_roles)} more role name(s) are not standard and are '
                f'not defined in the RoleMap: {names}.',
                f'roles={len(extra_roles)}; first={names}'[:MAX_TEXT],
                'Map custom roles to a standard role in /RoleMap, or use a '
                'standard role.',
            )
        )

    # Read from the collector's internal record.  O1 may report the cycle count
    # as a presence fact rather than a truncation counter; either way it only
    # feeds this dedicated finding and never the generic truncation finding.
    role_map_cycles = _truncation_count(truncation, 'roleMapCycles')
    if role_map_cycles:
        findings.append(
            _finding(
                'structure',
                'warning',
                None,
                'RoleMap cycle',
                'RoleMap entries resolve in a cycle, so some roles cannot be '
                'mapped to a standard role.',
                f'cycles={role_map_cycles}',
                'Fix the RoleMap so every custom role resolves to a standard '
                'role.',
            )
        )

    for role, title, detail, recommendation in (
        (
            'Figure',
            'Figure has no alternative text',
            'Figure elements have no /Alt text, so a screen reader cannot '
            'describe the image.',
            'Add /Alt text to every Figure element, or mark the image as an '
            'artifact.',
        ),
        (
            'Formula',
            'Formula has no alternative text',
            'Formula elements have no /Alt text, so a screen reader cannot '
            'describe the formula.',
            'Add /Alt text to every Formula element, or mark it as an artifact.',
        ),
    ):
        affected = [
            node
            for node in nodes
            if node.get('role') == role and not node.get('alt')
        ]
        if affected:
            findings.append(
                _node_finding('warning', title, detail, affected, recommendation)
            )

    links = [
        node
        for node in nodes
        if node.get('role') == 'Link'
        and not (node.get('alt') or node.get('actualText') or node.get('title'))
    ]
    if links:
        findings.append(
            _node_finding(
                'warning',
                'Link has no alternate description',
                'Link elements have no /Alt, /ActualText or /T description, so '
                'a screen reader cannot explain the link target.',
                links,
                'Add /Alt, /ActualText or /T to every Link element.',
            )
        )

    findings.extend(_heading_skip_findings(nodes))

    lists = [
        node
        for node in nodes
        if node.get('role') == 'L' and 'LI' not in _child_roles(node)
    ]
    if lists:
        findings.append(
            _node_finding(
                'warning',
                'List has no list items',
                'List (L) elements have no LI children, so the list has no '
                'readable items.',
                lists,
                'Add LI children (each with an LBody) to every L element.',
            )
        )

    list_items = [
        node
        for node in nodes
        if node.get('role') == 'LI' and 'LBody' not in _child_roles(node)
    ]
    if list_items:
        findings.append(
            _node_finding(
                'info',
                'List item has no LBody',
                'List item (LI) elements have no LBody child, so the item text '
                'is not grouped.',
                list_items,
                'Wrap the item text in an LBody inside every LI element.',
            )
        )

    tables = [
        node
        for node in nodes
        if node.get('role') == 'Table' and not _table_has_rows(node)
    ]
    if tables:
        findings.append(
            _node_finding(
                'warning',
                'Table has no rows',
                'Table elements have no TR children, so the table has no '
                'readable rows.',
                tables,
                'Add TR rows (with TH/TD cells) to every Table element.',
            )
        )

    def _has_scope(node: Mapping[str, Any]) -> bool:
        attributes = node.get('attributes')
        return (
            isinstance(attributes, Mapping)
            and attributes.get('Scope') is not None
        )

    header_cells = [
        node
        for node in nodes
        if node.get('role') == 'TH' and not _has_scope(node)
    ]
    if header_cells:
        findings.append(
            _node_finding(
                'info',
                'Table header cell has no scope',
                'Table header (TH) elements have no /Scope attribute, so the '
                'header/row relationship is ambiguous.',
                header_cells,
                'Set /Scope (Row, Column, Both) on every TH element.',
            )
        )

    findings.extend(_accessibility_truncation_findings(truncation, document))

    seen: set[tuple] = set()
    unique: list[dict[str, Any]] = []
    for finding in findings:
        key = _sort_key(finding)
        if key in seen:
            continue
        seen.add(key)
        unique.append(finding)
    return sort_findings(unique)


def accessibility_report(extractor: Any) -> dict[str, Any]:
    """The complete ``AccessibilityReport``: resources, findings and summary."""
    resources, truncation = collect_accessibility(extractor)
    findings = accessibility_findings(resources, truncation)
    return {
        'schemaVersion': SCHEMA_VERSION,
        'tool': tool(),
        'document': resources['document'],
        'structure': resources['structure'],
        'findings': findings,
        'summary': summarize_findings(findings),
    }


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
    security_resources: Optional[Mapping[str, Any]] = None,
    security_truncation: Optional[Mapping[str, Any]] = None,
    accessibility_resources: Optional[Mapping[str, Any]] = None,
    accessibility_truncation: Optional[Mapping[str, Any]] = None,
) -> list[dict[str, Any]]:
    if not isinstance(security_resources, Mapping):
        # Callers that only have the audit document block still get the single
        # encrypted warning; the full audit paths pass the collected resources.
        security_resources = {'document': {'encrypted': bool(document.get('encrypted'))}}
        security_truncation = None
    elif document.get('encrypted') and not (security_resources.get('document') or {}).get(
        'encrypted'
    ):
        # Never lose the warning when the cheap audit flag saw encryption that
        # the resource collector could not read.
        security_resources = {
            **security_resources,
            'document': {
                **(security_resources.get('document') or {}),
                'encrypted': True,
            },
        }

    if not isinstance(accessibility_resources, Mapping):
        # Callers that only have the audit document block still get the single
        # "PDF is not tagged" hint; the full audit paths pass the collected
        # resources so every accessibility check can run.
        accessibility_resources = {
            'document': {'tagged': bool(document.get('tagged'))},
            'structure': [],
        }
        accessibility_truncation = None
    else:
        accessibility_document = accessibility_resources.get('document')
        if not isinstance(accessibility_document, Mapping):
            accessibility_document = {}
        tagged = bool(document.get('tagged'))
        if bool(accessibility_document.get('tagged')) != tagged:
            # The audit's document block is the shared, already-resolved flag.
            # Keep both halves agreeing so an unreadable root cannot hide the
            # not-tagged hint or invent one.
            accessibility_resources = {
                **accessibility_resources,
                'document': {**accessibility_document, 'tagged': tagged},
            }

    findings: list[dict[str, Any]] = []
    findings.extend(_font_findings(metadata))
    findings.extend(_metadata_findings(document))
    findings.extend(security_findings(security_resources, security_truncation))
    findings.extend(
        accessibility_findings(accessibility_resources, accessibility_truncation)
    )
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

    Reads only the info dictionary, the catalog, the page dictionaries and the
    structure tree, so it is cheap enough to run before the page batches.  The
    security and accessibility resources are collected once and merged as
    ``security``/``structure`` findings; neither inventory is part of the audit
    report.
    """
    metadata = extractor.get_metadata() or {}
    if not isinstance(metadata, Mapping):
        metadata = {}
    document = _document_info(extractor, metadata)
    security_resources, security_truncation = collect_security_with_meta(extractor)
    accessibility_resources, accessibility_truncation = collect_accessibility(extractor)
    findings = _document_findings(
        extractor,
        metadata,
        document,
        security_resources,
        security_truncation,
        accessibility_resources,
        accessibility_truncation,
    )
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
        security_resources, security_truncation = collect_security_with_meta(extractor)
        accessibility_resources, accessibility_truncation = collect_accessibility(
            extractor
        )
        findings = list(
            _document_findings(
                extractor,
                metadata,
                document,
                security_resources,
                security_truncation,
                accessibility_resources,
                accessibility_truncation,
            )
        )

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
    'FINDING_OUTPUT_KEYS',
    'FINGERPRINT_KEY',
    'FINGERPRINT_LENGTH',
    'FINGERPRINT_VERSION',
    'MIN_IMAGE_DPI',
    'PAGE_BATCH_SIZE',
    'SCHEMA_VERSION',
    'STANDARD_STRUCTURE_ROLES',
    'accessibility_findings',
    'accessibility_report',
    'audit_document',
    'audit_file',
    'audit_pages',
    'finding_fingerprint',
    'security_findings',
    'security_report',
    'sort_findings',
    'summarize_findings',
    'tool',
]
