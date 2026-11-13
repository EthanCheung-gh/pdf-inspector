"""Plain-text and standalone HTML rendering for ``DiffResult`` dictionaries.

The renderers are pure string builders: no external assets, no JavaScript, no
timestamps.  Every user-controlled value passes through :func:`html.escape`, so
PDF text such as ``<script>`` can never become markup, and identical
``DiffResult`` input renders byte-identical output (CI artifact friendly).
"""

from __future__ import annotations

import html
import json
from typing import Any, Iterable, Mapping, Optional, Sequence

STATUS_LABELS = {
    'added': 'Page added',
    'removed': 'Page removed',
    'changed': 'Changed',
    'unchanged': 'Unchanged',
}

# Summary rows in a fixed order so the report never depends on dict iteration.
SUMMARY_ROWS = (
    ('pagesAdded', 'Pages added'),
    ('pagesRemoved', 'Pages removed'),
    ('pagesChanged', 'Pages changed'),
    ('pagesReordered', 'Pages reordered'),
    ('objectsAdded', 'Objects added'),
    ('objectsRemoved', 'Objects removed'),
    ('objectsMoved', 'Objects moved'),
    ('objectsModified', 'Objects modified'),
)

# Object-change kinds, in the order the diff engine reports them.
KIND_ORDER = ('added', 'removed', 'modified', 'moved')

# Page-level resource change types and their human labels. Metadata/page-label
# rows are document changes, but share the badge/label rendering.
RESOURCE_TYPE_LABELS = {
    'annotation': 'Annotation',
    'link': 'Link',
    'form': 'Form',
    'metadata': 'Metadata',
    'page-label': 'Page label',
}

# Summary counters of the resource/document-change block (all optional).
RESOURCE_SUMMARY_KEYS = (
    'resourcesAdded',
    'resourcesRemoved',
    'resourcesModified',
    'resourcesMoved',
    'documentChanges',
    'resourcesTruncated',
)
RESOURCE_SUMMARY_ROWS = (
    ('resourcesAdded', 'Resources added'),
    ('resourcesRemoved', 'Resources removed'),
    ('resourcesModified', 'Resources modified'),
    ('resourcesMoved', 'Resources moved'),
    ('documentChanges', 'Document changes'),
)

# Incompleteness flags: only rendered when true, so a complete run stays quiet.
TRUNCATION_SUMMARY_ROWS = (
    ('changesTruncated', 'Changes truncated'),
    ('resourcesTruncated', 'Resources truncated'),
)

NO_CHANGES_TEXT = 'changes: none - documents match'

# Cells rendered per table change before the remainder is summarised.
_MAX_CELL_ROWS = 100

# Ignore regions listed in the plain-text summary before the rest is counted.
_MAX_REGION_ROWS = 20

_CSS = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px 20px;
  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #1f2430;
  background: #f6f7f9;
}
main {
  max-width: 1120px;
  margin: 0 auto;
  padding: 28px 32px 36px;
  background: #ffffff;
  border: 1px solid #dde1e8;
  border-radius: 10px;
}
h1 { margin: 0 0 4px; font-size: 24px; }
h2 { margin: 32px 0 12px; padding-bottom: 6px; font-size: 18px; border-bottom: 1px solid #e4e8ef; }
h3 { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 28px 0 8px; font-size: 15px; }
p, dl, table { margin: 0 0 12px; }
.meta, .muted { color: #5b6472; font-size: 13px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 8px; text-align: left; vertical-align: top; border: 1px solid #e1e5ec; }
th { background: #f2f4f8; font-weight: 600; }
caption { padding-bottom: 6px; text-align: left; font-weight: 600; caption-side: top; }
code, .mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 12px; }
.badge { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.badge-added { background: #e3f6e9; color: #17663a; }
.badge-removed { background: #fde8e8; color: #a02121; }
.badge-modified { background: #e7effd; color: #1f4fa8; }
.badge-moved { background: #fdeedd; color: #9a4b06; }
.badge-unchanged { background: #eef0f4; color: #4a5261; }
.badge-resource { background: #efe7fd; color: #5b2ca0; }
.geometry { margin: 0 0 6px; padding: 8px 12px; background: #f7f9fc; border: 1px solid #e1e5ec; border-radius: 6px; }
.geometry p { margin: 0 0 4px; }
.geometry p:last-child { margin-bottom: 0; }
dl.details { display: grid; grid-template-columns: minmax(110px, max-content) 1fr; gap: 4px 16px; margin: 0 0 6px; }
dl.details dt { font-weight: 600; color: #3b4351; }
dl.details dd { margin: 0; }
.empty { color: #5b6472; font-style: italic; }
footer { margin-top: 32px; padding-top: 12px; color: #6b7280; font-size: 12px; border-top: 1px solid #e4e8ef; }
""".strip()


# --- value formatting -------------------------------------------------------


def _text(value: Any) -> str:
    return '' if value is None else str(value)


def _esc(value: Any) -> str:
    return html.escape(_text(value), quote=True)


def _fmt_number(value: Any) -> str:
    """Format a number without float noise: ``612``, ``595.28``, ``0``."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return _text(value)
    if number != number or number in (float('inf'), float('-inf')):
        return _text(value)
    if number == int(number) and abs(number) < 1e12:
        return str(int(number))
    return f'{number:.2f}'.rstrip('0').rstrip('.')


def _fmt_int(value: Any) -> str:
    try:
        return str(int(value))
    except (TypeError, ValueError):
        return _text(value)


def _fmt_score(value: Any) -> str:
    """Fixed-width 3-decimal match score, or ``-`` when there is none."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return '-'
    if number != number or number in (float('inf'), float('-inf')):
        return '-'
    return f'{number:.3f}'


def _fmt_sha(value: Any, length: int = 16) -> str:
    text = _text(value)
    if not text:
        return '-'
    return text if len(text) <= length else text[:length] + '...'


def _shorten(value: Any, limit: int = 64) -> str:
    text = _text(value)
    if len(text) <= limit:
        return text
    return text[: max(limit - 3, 0)] + '...'


def _size_text(size: Optional[Mapping[str, Any]]) -> str:
    if not isinstance(size, Mapping):
        return '-'
    width = _fmt_number(size.get('width'))
    height = _fmt_number(size.get('height'))
    return f'{width} x {height} pt'


def _bbox_text(bbox: Optional[Mapping[str, Any]]) -> str:
    if not isinstance(bbox, Mapping):
        return '-'
    return (
        f'({_fmt_number(bbox.get("x0"))}, {_fmt_number(bbox.get("y0"))}) - '
        f'({_fmt_number(bbox.get("x1"))}, {_fmt_number(bbox.get("y1"))})'
    )


def _detail_scalar(value: Any) -> str:
    """Render one detail value as readable, deterministic text."""
    if isinstance(value, Mapping):
        old = value.get('old')
        new = value.get('new')
        if 'old' in value and 'new' in value:
            # A one-sided change pairs one value with null; spell that out so a
            # page-label detail never reads like a truncated arrow.
            old_text = '(none)' if old is None else _detail_scalar(old)
            new_text = '(none)' if new is None else _detail_scalar(new)
            return f'{old_text} -> {new_text}'
        if set(value) == {'width', 'height'}:
            return _size_text(value)
        return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    if isinstance(value, (list, tuple)):
        return json.dumps(list(value), sort_keys=True, ensure_ascii=False, default=str)
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, float):
        return _fmt_number(value)
    if value is None:
        return ''
    return str(value)


def _total_changes(result: Mapping[str, Any]) -> int:
    summary = result.get('summary') or {}
    return sum(
        int(summary.get(key) or 0)
        for key in ('objectsAdded', 'objectsRemoved', 'objectsMoved', 'objectsModified')
    )


def _iter_pages(result: Mapping[str, Any]) -> Iterable[Mapping[str, Any]]:
    pages = result.get('pages') or []
    return [page for page in pages if isinstance(page, Mapping)]


def _iter_ignore_regions(result: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Ignore regions echoed under ``options.ignoreRegions`` (camelCase)."""
    options = result.get('options') or {}
    regions = options.get('ignoreRegions') or ()
    if isinstance(regions, (str, bytes)) or not isinstance(regions, Sequence):
        return []
    return [region for region in regions if isinstance(region, Mapping)]


def ignored_region_count(result: Mapping[str, Any]) -> int:
    """Number of applied ignore regions (0 when the field is absent)."""
    return len(_iter_ignore_regions(result))


def region_page_label(region: Mapping[str, Any]) -> str:
    """Human label for an ignore region, e.g. ``old page 1 / new page 2``."""
    bits = []
    if region.get('oldPage') is not None:
        bits.append(f'old page {_fmt_int(region.get("oldPage"))}')
    if region.get('newPage') is not None:
        bits.append(f'new page {_fmt_int(region.get("newPage"))}')
    return ' / '.join(bits) if bits else 'page ?'


def _iter_page_changes(
    result: Mapping[str, Any],
) -> Iterable[tuple[Mapping[str, Any], Mapping[str, Any]]]:
    for page in _iter_pages(result):
        for change in page.get('changes') or ():
            if isinstance(change, Mapping):
                yield page, change


def _all_changes(result: Mapping[str, Any]) -> Iterable[Mapping[str, Any]]:
    for _, change in _iter_page_changes(result):
        yield change


def _iter_document_changes(result: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Metadata/page-label entries of ``documentChanges`` (empty when absent)."""
    changes = result.get('documentChanges') or ()
    if isinstance(changes, (str, bytes)) or not isinstance(changes, Sequence):
        return []
    return [change for change in changes if isinstance(change, Mapping)]


def _has_resource_summary(summary: Mapping[str, Any]) -> bool:
    """True when the payload carries the additive resource counters."""
    return any(summary.get(key) is not None for key in RESOURCE_SUMMARY_KEYS)


def _count_or_zero(summary: Mapping[str, Any], key: str) -> int:
    """Optional counter as an int; a missing/invalid value reads as 0."""
    try:
        return int(summary.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _resource_summary_text(summary: Mapping[str, Any]) -> str:
    """One-line resource/document-change counts for the plain-text summary."""
    return (
        'resources: '
        f'{_count_or_zero(summary, "resourcesAdded")} added, '
        f'{_count_or_zero(summary, "resourcesRemoved")} removed, '
        f'{_count_or_zero(summary, "resourcesModified")} modified, '
        f'{_count_or_zero(summary, "resourcesMoved")} moved'
    )


def _truncation_notes(summary: Mapping[str, Any]) -> list[str]:
    """Warning lines for an incomplete result (empty for a complete run)."""
    notes = []
    if summary.get('changesTruncated'):
        notes.append('note: change lists are incomplete (safety cap reached)')
    if summary.get('resourcesTruncated'):
        notes.append(
            'note: resource comparison is incomplete (collector cap or unreadable block)'
        )
    return notes


def page_geometry_changed(result: Mapping[str, Any]) -> bool:
    """True when any change carries page-level geometry details."""
    return any(
        'pageGeometry' in (change.get('details') or {}) for change in _all_changes(result)
    )


def page_label(page: Mapping[str, Any]) -> str:
    """Human label such as ``page 2``, ``new page 3`` or ``old page 1``."""
    old_index = page.get('oldIndex')
    new_index = page.get('newIndex')
    if old_index is not None and new_index is not None:
        if old_index == new_index:
            return f'page {old_index}'
        return f'page {old_index}/{new_index}'
    if new_index is not None:
        return f'new page {new_index}'
    if old_index is not None:
        return f'old page {old_index}'
    return 'page ?'


def page_reordered(page: Mapping[str, Any]) -> bool:
    """True when the paired page sits at a different ordinal position."""
    match = page.get('match')
    if not isinstance(match, Mapping):
        return False
    return bool(match.get('reordered'))


def change_title(change: Mapping[str, Any]) -> str:
    """One-line description, e.g. ``word modified "Alpha" -> "Beta"``."""
    kind = _text(change.get('kind'))
    type_ = _text(change.get('type'))
    text_old = change.get('textOld')
    text_new = change.get('textNew')

    title = f'{type_} {kind}'.strip()
    if kind == 'modified' and (text_old is not None or text_new is not None):
        if text_old != text_new:
            title += f' "{_shorten(text_old)}" -> "{_shorten(text_new)}"'
        else:
            title += f' "{_shorten(text_old)}"'
    elif kind == 'added' and text_new is not None:
        title += f' "{_shorten(text_new)}"'
    elif kind == 'removed' and text_old is not None:
        title += f' "{_shorten(text_old)}"'
    return title


def _document_change_title(change: Mapping[str, Any]) -> str:
    """One line for a metadata/page-label change.

    Example: ``metadata title modified "Old" -> "New"`` or
    ``page-label page-label modified "1" -> "5" (page 3)``.
    """
    type_ = _text(change.get('type'))
    kind = _text(change.get('kind'))
    field = _text(change.get('field'))
    old_value = change.get('oldValue')
    new_value = change.get('newValue')

    title = f'{type_} {field} {kind}'.strip()
    if kind == 'modified' and (old_value is not None or new_value is not None):
        if old_value != new_value:
            title += f' "{_shorten(old_value)}" -> "{_shorten(new_value)}"'
        else:
            title += f' "{_shorten(old_value)}"'
    elif kind == 'added' and new_value is not None:
        title += f' "{_shorten(new_value)}"'
    elif kind == 'removed' and old_value is not None:
        title += f' "{_shorten(old_value)}"'
    if type_ == 'page-label' and change.get('page') is not None:
        title += f' (page {_fmt_int(change.get("page"))})'
    return title


def _options_text(options: Mapping[str, Any]) -> str:
    ignored = options.get('ignoreTypes') or []
    ignore_text = ', '.join(str(item) for item in ignored) if ignored else 'none'
    return (
        f'positionTolerance={_fmt_number(options.get("positionTolerance"))}, '
        f'textTolerance={_text(options.get("textTolerance"))}, '
        f'ignoreTypes={ignore_text}, '
        f'ignoreFonts={_detail_scalar(bool(options.get("ignoreFonts")))}, '
        f'ignoreColors={_detail_scalar(bool(options.get("ignoreColors")))}, '
        f'ignoreImages={_detail_scalar(bool(options.get("ignoreImages")))}, '
        f'ignoreAnnotations={_detail_scalar(bool(options.get("ignoreAnnotations")))}, '
        f'ignoreLinks={_detail_scalar(bool(options.get("ignoreLinks")))}, '
        f'ignoreForms={_detail_scalar(bool(options.get("ignoreForms")))}, '
        f'ignoreMetadata={_detail_scalar(bool(options.get("ignoreMetadata")))}, '
        f'ignorePageLabels={_detail_scalar(bool(options.get("ignorePageLabels")))}'
    )


# --- plain-text summary -----------------------------------------------------


def format_summary(
    result: Mapping[str, Any],
    *,
    old_label: Optional[str] = None,
    new_label: Optional[str] = None,
    max_changes: int = 10,
) -> str:
    """Render the human summary printed by the CLI.

    The summary is stable (document order, no timestamps) and always includes
    page/object counts plus the first ``max_changes`` changes in page order.
    """
    tool = result.get('tool') or {}
    version = _text(tool.get('version')) or '0.0.0'
    summary = result.get('summary') or {}
    old = result.get('old') or {}
    new = result.get('new') or {}
    options = result.get('options') or {}

    lines = [f'pdf-inspector {version} - PDF diff']
    lines.append(
        'old: '
        + (f'{old_label} - ' if old_label else '')
        + f'{_fmt_int(old.get("pages"))} page(s), sha256 {_fmt_sha(old.get("sha256"))}'
    )
    lines.append(
        'new: '
        + (f'{new_label} - ' if new_label else '')
        + f'{_fmt_int(new.get("pages"))} page(s), sha256 {_fmt_sha(new.get("sha256"))}'
    )
    lines.append(f'options: {_options_text(options)}')
    regions = _iter_ignore_regions(result)
    lines.append(f'ignored regions: {len(regions)}')
    for region in regions[:_MAX_REGION_ROWS]:
        lines.append(f'  - {region_page_label(region)}: {_bbox_text(region.get("bbox"))}')
    if len(regions) > _MAX_REGION_ROWS:
        lines.append(f'  ... {len(regions) - _MAX_REGION_ROWS} more region(s)')
    lines.append('')

    pages_added = int(summary.get('pagesAdded') or 0)
    pages_removed = int(summary.get('pagesRemoved') or 0)
    pages_changed = int(summary.get('pagesChanged') or 0)
    pages_reordered = int(summary.get('pagesReordered') or 0)
    page_pairs = len(list(_iter_pages(result)))
    pages_unchanged = max(page_pairs - pages_added - pages_removed - pages_changed, 0)
    lines.append(
        f'pages: {_fmt_int(old.get("pages"))} -> {_fmt_int(new.get("pages"))} '
        f'({pages_added} added, {pages_removed} removed, {pages_changed} changed, '
        f'{pages_unchanged} unchanged)'
    )
    lines.append(f'pages reordered: {pages_reordered}')
    lines.append(
        'objects: '
        f'{_fmt_int(summary.get("objectsAdded"))} added, '
        f'{_fmt_int(summary.get("objectsRemoved"))} removed, '
        f'{_fmt_int(summary.get("objectsMoved"))} moved, '
        f'{_fmt_int(summary.get("objectsModified"))} modified'
    )
    # Resource counters are additive: an object-only payload keeps its
    # historical summary without empty resource lines.
    if _has_resource_summary(summary):
        lines.append(_resource_summary_text(summary))
        lines.append(f'document changes: {_fmt_int(summary.get("documentChanges"))}')
    lines.extend(_truncation_notes(summary))
    lines.append('')

    changes = list(_iter_page_changes(result))
    documents = _iter_document_changes(result)
    if not changes and not documents:
        lines.append(NO_CHANGES_TEXT)
        return '\n'.join(lines) + '\n'

    limit = max(int(max_changes), 0)
    if documents:
        shown_documents = documents[:limit]
        lines.append(
            f'document change details: {len(documents)} total, '
            f'showing {len(shown_documents)}'
        )
        for index, change in enumerate(shown_documents, start=1):
            lines.append(f'  {index}. {_document_change_title(change)}')
        remaining_documents = len(documents) - len(shown_documents)
        if remaining_documents:
            lines.append(f'  ... {remaining_documents} more document change(s)')
    if not changes:
        if not documents:
            lines.append(NO_CHANGES_TEXT)
        return '\n'.join(lines) + '\n'

    shown = changes[:limit] if limit else []
    lines.append(f'changes: {len(changes)} total, showing {len(shown)}')
    for index, (page, change) in enumerate(shown, start=1):
        lines.append(f'  {index}. {page_label(page)}: {change_title(change)}')
    if len(changes) > len(shown):
        lines.append(f'  ... {len(changes) - len(shown)} more change(s)')
    return '\n'.join(lines) + '\n'


# --- HTML report ------------------------------------------------------------


def _badge(kind: str) -> str:
    css_kind = kind if kind in KIND_ORDER or kind == 'unchanged' else 'modified'
    return f'<span class="badge badge-{_esc(css_kind)}">{_esc(kind)}</span>'


def _status_badge(status: str) -> str:
    """Page-level badge; added/removed say so explicitly for report readers."""
    label = STATUS_LABELS.get(status, status)
    css_kind = status if status in ('added', 'removed', 'unchanged') else 'modified'
    return f'<span class="badge badge-{_esc(css_kind)}">{_esc(label)}</span>'


def _type_badge(type_: Any) -> str:
    """Change-type cell: resource types get a labelled badge, objects stay plain."""
    text = _text(type_)
    label = RESOURCE_TYPE_LABELS.get(text)
    if label is None:
        return _esc(text)
    return f'<span class="badge badge-resource">{_esc(label)}</span>'


def _render_page_geometry(geometry: Mapping[str, Any]) -> str:
    parts = ['<div class="geometry">']
    size = geometry.get('size')
    if isinstance(size, Mapping):
        parts.append(
            '<p><strong>Page size:</strong> '
            f'{_esc(_size_text(size.get("old")))} &rarr; {_esc(_size_text(size.get("new")))}</p>'
        )
    rotation = geometry.get('rotation')
    if isinstance(rotation, Mapping):
        parts.append(
            '<p><strong>Rotation:</strong> '
            f'{_esc(_fmt_number(rotation.get("old")))} deg &rarr; '
            f'{_esc(_fmt_number(rotation.get("new")))} deg</p>'
        )
    if len(parts) == 1:
        parts.append(f'<p class="mono">{_esc(_detail_scalar(geometry))}</p>')
    parts.append('</div>')
    return ''.join(parts)


def _render_cell_changes(cell_changes: Sequence[Any]) -> str:
    rows = []
    total = 0
    for cell in cell_changes:
        if not isinstance(cell, Mapping):
            continue
        total += 1
        if total > _MAX_CELL_ROWS:
            continue
        rows.append(
            '<tr>'
            f'<td>{_esc(_fmt_int(cell.get("row")))}</td>'
            f'<td>{_esc(_fmt_int(cell.get("col")))}</td>'
            f'<td class="mono">{_esc(cell.get("old"))}</td>'
            f'<td class="mono">{_esc(cell.get("new"))}</td>'
            '</tr>'
        )
    if not rows:
        return ''
    parts = [
        '<table class="cells">',
        '<caption>Table cells (row/column are 0-based)</caption>',
        '<thead><tr><th>Row</th><th>Col</th><th>Old</th><th>New</th></tr></thead>',
        '<tbody>',
        *rows,
        '</tbody>',
        '</table>',
    ]
    if total > _MAX_CELL_ROWS:
        parts.append(f'<p class="muted">... {total - _MAX_CELL_ROWS} more cell(s)</p>')
    return ''.join(parts)


def _render_details(details: Mapping[str, Any]) -> str:
    """Readable rendering of a change's ``details`` map (all values escaped)."""
    if not details:
        return '<span class="muted">&mdash;</span>'

    parts = []
    geometry = details.get('pageGeometry')
    if isinstance(geometry, Mapping):
        parts.append(_render_page_geometry(geometry))

    cell_changes = details.get('cellChanges')
    if isinstance(cell_changes, Sequence) and not isinstance(cell_changes, (str, bytes)):
        parts.append(_render_cell_changes(cell_changes))

    rest = {
        key: value
        for key, value in details.items()
        if key not in ('pageGeometry', 'cellChanges')
    }
    if rest:
        rows = [
            f'<dt>{_esc(key)}</dt><dd class="mono">{_esc(_detail_scalar(rest[key]))}</dd>'
            for key in sorted(rest)
        ]
        parts.append(f'<dl class="details">{"".join(rows)}</dl>')
    return ''.join(parts) if parts else '<span class="muted">&mdash;</span>'


def _render_text_cell(change: Mapping[str, Any]) -> str:
    text_old = change.get('textOld')
    text_new = change.get('textNew')
    if text_old is not None and text_new is not None:
        if text_old == text_new:
            return f'<code>{_esc(text_old)}</code>'
        return f'<code>{_esc(text_old)}</code> &rarr; <code>{_esc(text_new)}</code>'
    if text_new is not None:
        return f'<code>{_esc(text_new)}</code>'
    if text_old is not None:
        return f'<code>{_esc(text_old)}</code>'
    return '<span class="muted">&mdash;</span>'


def _render_document_table(result: Mapping[str, Any]) -> str:
    old = result.get('old') or {}
    new = result.get('new') or {}
    return ''.join(
        [
            '<table class="documents">',
            '<caption>Documents</caption>',
            '<thead><tr><th>Document</th><th>Pages</th><th>SHA-256</th></tr></thead>',
            '<tbody>',
            '<tr><th scope="row">Old</th>'
            f'<td>{_esc(_fmt_int(old.get("pages")))}</td>'
            f'<td class="mono">{_esc(_fmt_sha(old.get("sha256"), 64))}</td></tr>',
            '<tr><th scope="row">New</th>'
            f'<td>{_esc(_fmt_int(new.get("pages")))}</td>'
            f'<td class="mono">{_esc(_fmt_sha(new.get("sha256"), 64))}</td></tr>',
            '</tbody>',
            '</table>',
        ]
    )


def _render_summary_table(result: Mapping[str, Any]) -> str:
    summary = result.get('summary') or {}
    rows = [
        f'<tr><th scope="row">{_esc(label)}</th>'
        f'<td>{_esc(_fmt_int(summary.get(key)))}</td></tr>'
        for key, label in SUMMARY_ROWS
    ]
    # The resource counters are additive: legacy/object-only payloads keep the
    # historical table without empty resource rows.
    if _has_resource_summary(summary):
        rows.extend(
            f'<tr><th scope="row">{_esc(label)}</th>'
            f'<td>{_esc(_fmt_int(_count_or_zero(summary, key)))}</td></tr>'
            for key, label in RESOURCE_SUMMARY_ROWS
        )
    rows.append(
        '<tr><th scope="row">Total object changes</th>'
        f'<td>{_esc(_fmt_int(_total_changes(result)))}</td></tr>'
    )
    # An incomplete run must not read like a clean one; complete runs keep the
    # historical table.
    for key, label in TRUNCATION_SUMMARY_ROWS:
        if summary.get(key):
            rows.append(
                f'<tr><th scope="row">{_esc(label)}</th><td>true</td></tr>'
            )
    rows.append(
        '<tr><th scope="row">Ignored regions</th>'
        f'<td>{_esc(_fmt_int(ignored_region_count(result)))}</td></tr>'
    )
    return ''.join(
        [
            '<table class="summary-table">',
            '<caption>Changes</caption>',
            '<thead><tr><th>Metric</th><th>Count</th></tr></thead>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
        ]
    )


def _render_options_table(result: Mapping[str, Any]) -> str:
    options = result.get('options') or {}
    ignored = options.get('ignoreTypes') or []
    ignore_text = ', '.join(str(item) for item in ignored) if ignored else 'none'
    rows = (
        ('Position tolerance (pt)', _fmt_number(options.get('positionTolerance'))),
        ('Text tolerance', _text(options.get('textTolerance'))),
        ('Ignored types', ignore_text),
        ('Ignore fonts', _detail_scalar(bool(options.get('ignoreFonts')))),
        ('Ignore colors', _detail_scalar(bool(options.get('ignoreColors')))),
        ('Ignore images', _detail_scalar(bool(options.get('ignoreImages')))),
        ('Ignore annotations', _detail_scalar(bool(options.get('ignoreAnnotations')))),
        ('Ignore links', _detail_scalar(bool(options.get('ignoreLinks')))),
        ('Ignore forms', _detail_scalar(bool(options.get('ignoreForms')))),
        ('Ignore metadata', _detail_scalar(bool(options.get('ignoreMetadata')))),
        ('Ignore page labels', _detail_scalar(bool(options.get('ignorePageLabels')))),
    )
    body = [
        f'<tr><th scope="row">{_esc(label)}</th><td class="mono">{_esc(value)}</td></tr>'
        for label, value in rows
    ]
    return ''.join(
        [
            '<table class="options">',
            '<caption>Diff options</caption>',
            '<thead><tr><th>Option</th><th>Value</th></tr></thead>',
            '<tbody>',
            *body,
            '</tbody>',
            '</table>',
        ]
    )


def _render_ignore_region_table(result: Mapping[str, Any]) -> str:
    """Applied ignore regions: page scope and MediaBox-relative box."""
    regions = _iter_ignore_regions(result)
    rows = [
        '<tr>'
        f'<td>{index}</td>'
        f'<td>{_esc(_page_index_text(region.get("oldPage")))}</td>'
        f'<td>{_esc(_page_index_text(region.get("newPage")))}</td>'
        f'<td class="mono">{_esc(_bbox_text(region.get("bbox")))}</td>'
        '</tr>'
        for index, region in enumerate(regions, start=1)
    ]
    if not rows:
        rows.append('<tr><td colspan="4" class="empty">No ignore regions.</td></tr>')
    return ''.join(
        [
            '<div class="table-wrap">',
            '<table class="regions">',
            '<caption>Ignore regions (1-based pages; bounding box in MediaBox-relative '
            'PDF points)</caption>',
            '<thead><tr>'
            '<th>#</th><th>Old page</th><th>New page</th><th>Bounding box</th>'
            '</tr></thead>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
            '</div>',
        ]
    )


def _render_change_rows(changes: Sequence[Mapping[str, Any]]) -> str:
    rows = []
    for index, change in enumerate(changes, start=1):
        rows.append(
            '<tr>'
            f'<td>{index}</td>'
            f'<td>{_badge(_text(change.get("kind")))}</td>'
            f'<td>{_type_badge(change.get("type"))}</td>'
            f'<td>{_esc(change.get("oldPage"))}</td>'
            f'<td>{_esc(change.get("newPage"))}</td>'
            f'<td>{_render_text_cell(change)}</td>'
            f'<td class="mono">{_esc(_bbox_text(change.get("oldBBox")))}</td>'
            f'<td class="mono">{_esc(_bbox_text(change.get("newBBox")))}</td>'
            f'<td>{_render_details(change.get("details") or {})}</td>'
            '</tr>'
        )
    return ''.join(rows)


def _page_index_text(value: Any) -> str:
    return '-' if value is None else _fmt_int(value)


def _render_document_value_cell(change: Mapping[str, Any]) -> str:
    """Old/new value cell of a metadata/page-label row (escaped)."""
    old_value = change.get('oldValue')
    new_value = change.get('newValue')
    if old_value is not None and new_value is not None:
        if old_value == new_value:
            return f'<code>{_esc(old_value)}</code>'
        return f'<code>{_esc(old_value)}</code> &rarr; <code>{_esc(new_value)}</code>'
    if new_value is not None:
        return f'<code>{_esc(new_value)}</code>'
    if old_value is not None:
        return f'<code>{_esc(old_value)}</code>'
    return '<span class="muted">&mdash;</span>'


def _render_document_changes(result: Mapping[str, Any]) -> str:
    """The ``Document changes`` section (metadata and page labels).

    Returns an empty string when the payload has no ``documentChanges`` field,
    so an object-only report renders exactly as it did before resources existed.
    """
    if 'documentChanges' not in result:
        return ''
    changes = _iter_document_changes(result)
    parts = [
        '<h2 id="document-changes">Document changes</h2>',
        f'<p class="muted">{len(changes)} metadata/page-label change(s). These carry '
        'no page box, so ignore regions never mask them.</p>',
    ]
    if not changes:
        parts.append('<p class="empty">No document changes.</p>')
        return ''.join(parts)

    rows = []
    for index, change in enumerate(changes, start=1):
        page = change.get('page')
        page_cell = '<span class="muted">&mdash;</span>' if page is None else _esc(
            f'page {_fmt_int(page)}'
        )
        rows.append(
            '<tr>'
            f'<td>{index}</td>'
            f'<td>{_badge(_text(change.get("kind")))}</td>'
            f'<td>{_type_badge(change.get("type"))}</td>'
            f'<td>{page_cell}</td>'
            f'<td class="mono">{_esc(change.get("field"))}</td>'
            f'<td>{_render_document_value_cell(change)}</td>'
            f'<td>{_render_details(change.get("details") or {})}</td>'
            '</tr>'
        )
    parts.extend(
        [
            '<div class="table-wrap">',
            '<table class="document-changes">',
            '<caption>Document changes</caption>',
            '<thead><tr>'
            '<th>#</th><th>Kind</th><th>Type</th><th>Page</th><th>Field</th>'
            '<th>Old &rarr; new</th><th>Details</th>'
            '</tr></thead>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
            '</div>',
        ]
    )
    return ''.join(parts)


def _render_page_table(pages: Sequence[Mapping[str, Any]]) -> str:
    """Aligned old/new page numbers with the fingerprint match metadata."""
    if not pages:
        return ''
    rows = []
    for position, page in enumerate(pages, start=1):
        status = _text(page.get('status')) or 'unchanged'
        match = page.get('match') if isinstance(page.get('match'), Mapping) else None
        score = _fmt_score(match.get('score')) if match else '-'
        if match is None:
            reordered = '<span class="muted">&mdash;</span>'
        elif page_reordered(page):
            reordered = '<span class="badge badge-moved">reordered</span>'
        else:
            reordered = 'no'
        changes = [change for change in page.get('changes') or () if isinstance(change, Mapping)]
        rows.append(
            '<tr>'
            f'<td>{position}</td>'
            f'<td>{_esc(_page_index_text(page.get("oldIndex")))}</td>'
            f'<td>{_esc(_page_index_text(page.get("newIndex")))}</td>'
            f'<td>{_status_badge(status)}</td>'
            f'<td class="mono">{_esc(score)}</td>'
            f'<td>{reordered}</td>'
            f'<td>{len(changes)}</td>'
            '</tr>'
        )
    return ''.join(
        [
            '<div class="table-wrap">',
            '<table class="pages">',
            '<caption>Page alignment (1-based page numbers; match is the page '
            'fingerprint similarity)</caption>',
            '<thead><tr>'
            '<th>#</th><th>Old page</th><th>New page</th><th>Status</th>'
            '<th>Match score</th><th>Reordered</th><th>Changes</th>'
            '</tr></thead>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
            '</div>',
        ]
    )


def _render_page_section(page: Mapping[str, Any], position: int) -> str:
    status = _text(page.get('status')) or 'unchanged'
    changes = [change for change in page.get('changes') or () if isinstance(change, Mapping)]
    heading = f'<h3 id="page-{position}">{_esc(page_label(page).capitalize())} {_status_badge(status)}'
    if status == 'added':
        heading += ' <span class="muted">only in new document</span>'
    elif status == 'removed':
        heading += ' <span class="muted">only in old document</span>'
    if changes:
        noun = 'change' if len(changes) == 1 else 'changes'
        heading += f' <span class="muted">{len(changes)} {noun}</span>'
    heading += '</h3>'

    size_bits = []
    if page.get('oldSize') is not None:
        size_bits.append(f'Old size: {_esc(_size_text(page.get("oldSize")))}')
    if page.get('newSize') is not None:
        size_bits.append(f'New size: {_esc(_size_text(page.get("newSize")))}')
    size_line = f'<p class="muted">{" &middot; ".join(size_bits)}</p>' if size_bits else ''

    parts = [f'<section class="page page-{_esc(status)}">', heading, size_line]
    if changes:
        has_resources = any(
            _text(change.get('type')) in RESOURCE_TYPE_LABELS for change in changes
        )
        caption = 'Changes' if has_resources else 'Object changes'
        parts.extend(
            [
                '<div class="table-wrap">',
                '<table class="changes">',
                f'<caption>{caption}</caption>',
                '<thead><tr>'
                '<th>#</th><th>Kind</th><th>Type</th><th>Old page</th><th>New page</th>'
                '<th>Text</th><th>Old bounding box</th><th>New bounding box</th>'
                '<th>Details</th>'
                '</tr></thead>',
                '<tbody>',
                _render_change_rows(changes),
                '</tbody>',
                '</table>',
                '</div>',
            ]
        )
    else:
        parts.append('<p class="empty">No object changes.</p>')
    parts.append('</section>')
    return ''.join(parts)


def render_html(result: Mapping[str, Any]) -> str:
    """Render a full, self-contained HTML report (inline CSS, no scripts)."""
    tool = result.get('tool') or {}
    version = _text(tool.get('version')) or '0.0.0'
    schema_version = _fmt_int(result.get('schemaVersion'))
    pages = list(_iter_pages(result))
    document_changes_html = _render_document_changes(result)

    lines = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f'<title>PDF diff report - pdf-inspector {_esc(version)}</title>',
        '<style>',
        _CSS,
        '</style>',
        '</head>',
        '<body>',
        '<main>',
        '<header>',
        '<h1>PDF diff report</h1>',
        f'<p class="meta">pdf-inspector {_esc(version)} &middot; schema {_esc(schema_version)}</p>',
        '</header>',
        '<h2 id="summary">Summary</h2>',
        _render_document_table(result),
        _render_summary_table(result),
        '<h2 id="options">Diff options</h2>',
        _render_options_table(result),
        '<h2 id="ignored-regions">Ignored regions</h2>',
        f'<p class="muted">{ignored_region_count(result)} region(s) masked; changes '
        'intersecting them are omitted from this report.</p>',
        _render_ignore_region_table(result),
    ]
    # Document-level changes sit between the ignore-region block and the page
    # sections: they belong to the document, not to any one page.
    if document_changes_html:
        lines.append(document_changes_html)
    lines.extend(
        [
            '<h2 id="pages">Pages</h2>',
            f'<p class="muted">{len(pages)} page section(s)</p>',
            _render_page_table(pages),
        ]
    )
    for position, page in enumerate(pages, start=1):
        lines.append(_render_page_section(page, position))
    lines.extend(
        [
            '<footer>',
            f'Generated by pdf-inspector {_esc(version)}. '
            'Deterministic report: no timestamps, no external assets, no scripts.',
            '</footer>',
            '</main>',
            '</body>',
            '</html>',
        ]
    )
    return '\n'.join(lines) + '\n'


__all__ = [
    'NO_CHANGES_TEXT',
    'STATUS_LABELS',
    'SUMMARY_ROWS',
    'change_title',
    'format_summary',
    'ignored_region_count',
    'page_geometry_changed',
    'page_label',
    'page_reordered',
    'region_page_label',
    'render_html',
]
