"""Standalone HTML rendering for a batch audit payload.

:func:`sidecar.batch_audit.audit_directory` returns a ``BatchReport`` (root name,
aggregate counts and one entry per file).  :func:`render_batch_html` turns that
payload into one self-contained HTML document for CI artifacts: inline CSS, no
scripts, no external assets, no thumbnails and no PDF previews.

Two properties matter for an artifact and are enforced by construction:

* **Determinism.**  The payload already carries relative POSIX paths and a fixed
  key order; this module only walks it in that order and never renders a
  timestamp, a host name or an absolute path of its own.  The same payload
  renders byte-identically.
* **Escaping.**  Paths, document metadata, finding titles/details/evidence and
  per-file error text all originate in a PDF, so every one of them passes
  through :func:`html.escape`.  A file called ``<script>.pdf`` can never become
  markup.

The renderer deliberately re-implements the few helpers it needs instead of
importing the private ones from :mod:`sidecar.audit_report`: the two payloads
(one report vs. one aggregate) evolve separately, and the batch report must not
start rendering a field just because the single-file report did.
"""

from __future__ import annotations

import html
from typing import Any, Mapping, Sequence

# Empty/none messages, shared with the tests so the wording lives in one place.
NO_FILES_TEXT = 'No PDF files found in this directory.'
NO_FINDINGS_TEXT = 'No audit findings.'
NO_FILES_HINT = 'Run audit-dir over a directory that contains PDF files.'

# Fixed severity order of the per-file summary table, so the rendering never
# depends on dict iteration order.
SEVERITY_FIELDS = (
    ('errors', 'error'),
    ('warnings', 'warning'),
    ('info', 'info'),
)

# CSS kinds that get their own badge/finding colour; anything else is unknown.
SEVERITY_KINDS = ('error', 'warning', 'info')

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
  max-width: 1040px;
  margin: 0 auto;
  padding: 28px 32px 36px;
  background: #ffffff;
  border: 1px solid #dde1e8;
  border-radius: 10px;
}
h1 { margin: 0 0 4px; font-size: 24px; }
h2 { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 32px 0 12px; padding-bottom: 6px; font-size: 18px; border-bottom: 1px solid #e4e8ef; }
h3 { margin: 20px 0 10px; font-size: 15px; }
h4 { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0 0 6px; font-size: 14px; }
p, dl, table { margin: 0 0 12px; }
.meta, .muted { color: #5b6472; font-size: 13px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 8px; text-align: left; vertical-align: top; border: 1px solid #e1e5ec; }
th { background: #f2f4f8; font-weight: 600; }
table.info-table th, table.summary-table th[scope="row"] { width: 180px; }
caption { padding-bottom: 6px; text-align: left; font-weight: 600; caption-side: top; }
code, .mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 12px; }
.badge { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.badge-error { background: #fde8e8; color: #a02121; }
.badge-warning { background: #fdeedd; color: #9a4b06; }
.badge-info { background: #e7effd; color: #1f4fa8; }
.badge-ok { background: #e7f5ea; color: #1f6b34; }
.badge-unknown { background: #eef0f4; color: #4a5261; }
td.file-error { color: #a02121; }
div.error-block { margin: 0 0 12px; padding: 12px 14px; background: #fdf3f3; border: 1px solid #f0c9c9; border-left: 4px solid #a02121; border-radius: 8px; }
p.error { margin: 0; color: #7a1a1a; }
ol.findings { list-style: none; margin: 0; padding: 0; }
li.finding { margin: 0 0 16px; padding: 14px 16px; background: #fbfcfe; border: 1px solid #e1e5ec; border-left-width: 4px; border-radius: 8px; }
li.finding-error { border-left-color: #a02121; }
li.finding-warning { border-left-color: #c2710d; }
li.finding-info { border-left-color: #1f4fa8; }
li.finding-unknown { border-left-color: #8a92a1; }
li.finding dl { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 4px 16px; margin: 0; }
li.finding dt { font-weight: 600; color: #3b4351; }
li.finding dd { margin: 0; }
.empty { color: #5b6472; font-style: italic; }
footer { margin-top: 32px; padding-top: 12px; color: #6b7280; font-size: 12px; border-top: 1px solid #e4e8ef; }
""".strip()

# Control bytes never belong in rendered user text; PDF metadata and error
# messages may legally contain them.
_CONTROL_CHARS = {
    code: None for code in range(0x20) if code not in (0x09, 0x0A, 0x0D)
}
_CONTROL_CHARS.update({0x7F: None, 0x85: None})


# --- small helpers ----------------------------------------------------------


def _text(value: Any) -> str:
    return '' if value is None else str(value)


def _plain(value: Any) -> str:
    """One line of plain text without control characters.

    Used for table cells, so an embedded newline or ESC byte from a PDF cannot
    break the row layout or inject a terminal escape into a rendered cell.
    """
    return ' '.join(_text(value).translate(_CONTROL_CHARS).split())


def _esc(value: Any) -> str:
    return html.escape(_text(value), quote=True)


def _esc_plain(value: Any) -> str:
    """Escape after flattening to one line (table cells and badges)."""
    return html.escape(_plain(value), quote=True)


def _int(value: Any, default: int = 0) -> int:
    """Coerce a count to a non-negative int; unreadable values use ``default``."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(number, 0)


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _entries(result: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """The file entries of a batch payload, skipping malformed list items."""
    files = result.get('files')
    if not isinstance(files, Sequence) or isinstance(files, (str, bytes)):
        return []
    return [item for item in files if isinstance(item, Mapping)]


def _findings(entry: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    findings = entry.get('findings')
    if not isinstance(findings, Sequence) or isinstance(findings, (str, bytes)):
        return []
    return [item for item in findings if isinstance(item, Mapping)]


def _file_counts(entry: Mapping[str, Any]) -> dict[str, int]:
    """Severity counts of one file, recomputed from its findings if necessary."""
    findings = _findings(entry)
    summary = _mapping(entry.get('summary'))
    if summary:
        errors = _int(summary.get('errors'))
        warnings = _int(summary.get('warnings'))
        info = _int(summary.get('info'))
        total = summary.get('total')
        total = errors + warnings + info if total is None else _int(total)
        return {'errors': errors, 'warnings': warnings, 'info': info, 'total': total}

    counts = {'errors': 0, 'warnings': 0, 'info': 0}
    for finding in findings:
        severity = _plain(finding.get('severity'))
        if severity in counts:
            counts[severity] += 1
    counts['total'] = len(findings)
    return counts


def _title(count: int) -> str:
    suffix = '1 file' if count == 1 else f'{count} files'
    return f'PDF audit report - {_esc(suffix)}'


def _badge(value: Any, kinds: Sequence[str]) -> str:
    """A badge whose CSS class is chosen from an allow-list of known kinds."""
    text = _plain(value) or 'unknown'
    css_kind = text if text in kinds else 'unknown'
    return f'<span class="badge badge-{css_kind}">{_esc(text)}</span>'


def _severity_badge(value: Any) -> str:
    return _badge(value, SEVERITY_KINDS)


def _status_badge(value: Any) -> str:
    return _badge(value, ('ok', 'error'))


def _info_row(label: str, value: Any, *, mono: bool = False) -> str:
    """One ``th``/``td`` row; an empty value renders as an em dash."""
    if value is None or _text(value).strip() == '':
        return (
            f'<tr><th scope="row">{_esc(label)}</th>'
            '<td class="muted">&mdash;</td></tr>'
        )
    css = ' class="mono"' if mono else ''
    return f'<tr><th scope="row">{_esc(label)}</th><td{css}>{_esc_plain(value)}</td></tr>'


def _yes_no(value: Any) -> str:
    return 'yes' if value else 'no'


def _finding_location(finding: Mapping[str, Any]) -> str:
    """``metadata, page 2`` or just the category for document-level findings."""
    category = _plain(finding.get('category')) or 'unknown'
    page = finding.get('page')
    if page is None:
        return category
    try:
        number = int(page)
    except (TypeError, ValueError):
        return category
    return f'{category}, page {number}'


# --- sections ---------------------------------------------------------------


def _render_summary_section(
    root: Mapping[str, Any], summary: Mapping[str, Any]
) -> str:
    """The aggregate table: root name, files/bytes, audited/failed and counts."""
    errors = _int(summary.get('errors'))
    warnings = _int(summary.get('warnings'))
    info = _int(summary.get('info'))
    rows = [
        _info_row('Root', _plain(root.get('name')) or '.', mono=True),
        _info_row('Files', _int(summary.get('files'))),
        _info_row('Bytes', _int(root.get('bytes'))),
        _info_row('Audited', _int(summary.get('audited'))),
        _info_row('Failed', _int(summary.get('failed'))),
        _info_row('Errors', errors),
        _info_row('Warnings', warnings),
        _info_row('Info', info),
        # ``errors`` already includes the failed files, so the sum is exactly
        # the ``(N total)`` line the CLI summary prints.
        _info_row('Total', errors + warnings + info),
    ]
    return ''.join(
        [
            '<section id="summary">',
            '<h2>Directory summary</h2>',
            '<table class="info-table">',
            '<caption>Directory audit</caption>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
            '</section>',
        ]
    )


def _render_file_row(entry: Mapping[str, Any]) -> str:
    """One row of the file table: path, status, pages, counts and error text."""
    path = _plain(entry.get('path')) or '(unknown file)'
    status = _plain(entry.get('status')) or 'unknown'
    document = _mapping(entry.get('document'))
    if status == 'ok':
        pages = document.get('pages')
        pages_cell = str(_int(pages)) if pages is not None else '&mdash;'
        counts = _file_counts(entry)
        detail = '<td class="muted">&mdash;</td>'
        count_cells = ''.join(
            f'<td>{counts[field]}</td>' for field, _ in SEVERITY_FIELDS
        )
    else:
        pages_cell = '&mdash;'
        count_cells = '<td>&mdash;</td>' * len(SEVERITY_FIELDS)
        error = _plain(entry.get('error')) or 'unknown error'
        detail = f'<td class="file-error">{html.escape(error, quote=True)}</td>'
    return ''.join(
        [
            '<tr>',
            f'<td class="mono">{html.escape(path, quote=True)}</td>',
            f'<td>{_status_badge(status)}</td>',
            f'<td>{pages_cell}</td>',
            count_cells,
            detail,
            '</tr>',
        ]
    )


def _render_files_section(entries: Sequence[Mapping[str, Any]]) -> str:
    """The file table, or an explicit empty-directory message."""
    parts = ['<section id="files">', '<h2>Files</h2>']
    if not entries:
        parts.append(f'<p class="empty">{_esc(NO_FILES_TEXT)}</p>')
        parts.append(f'<p class="muted">{_esc(NO_FILES_HINT)}</p>')
        parts.append('</section>')
        return ''.join(parts)

    parts.extend(
        [
            '<table class="files-table">',
            '<caption>Files in discovery order</caption>',
            '<thead>',
            '<tr><th>Path</th><th>Status</th><th>Pages</th>'
            '<th>Errors</th><th>Warnings</th><th>Info</th><th>Details</th></tr>',
            '</thead>',
            '<tbody>',
            *[_render_file_row(entry) for entry in entries],
            '</tbody>',
            '</table>',
            '</section>',
        ]
    )
    return ''.join(parts)


def _render_document_table(document: Mapping[str, Any]) -> str:
    rows = [
        _info_row('Pages', _int(document.get('pages'))),
        _info_row('PDF version', _plain(document.get('version')) or 'unknown'),
        _info_row('Encrypted', _yes_no(document.get('encrypted'))),
        _info_row('Tagged', _yes_no(document.get('tagged'))),
        _info_row('Language', document.get('language')),
        _info_row('Title', document.get('title')),
        _info_row('Author', document.get('author')),
        _info_row('Producer', document.get('producer')),
    ]
    return ''.join(
        [
            '<table class="info-table">',
            '<caption>Document</caption>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
        ]
    )


def _render_file_summary_table(entry: Mapping[str, Any]) -> str:
    counts = _file_counts(entry)
    rows = [
        f'<tr><th scope="row">{_esc(label)}</th><td>{counts[field]}</td></tr>'
        for field, label in (
            ('errors', 'Errors'),
            ('warnings', 'Warnings'),
            ('info', 'Info'),
            ('total', 'Total'),
        )
    ]
    return ''.join(
        [
            '<table class="summary-table">',
            '<caption>Findings by severity</caption>',
            '<thead><tr><th>Severity</th><th>Count</th></tr></thead>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
        ]
    )


def _render_finding(
    finding: Mapping[str, Any], file_index: int, position: int
) -> str:
    """One finding: severity badge, title, page, detail, evidence, advice."""
    severity = _plain(finding.get('severity')) or 'unknown'
    css_kind = severity if severity in SEVERITY_KINDS else 'unknown'
    title = _plain(finding.get('title')) or '(untitled finding)'
    detail = finding.get('detail')

    parts = [
        f'<li class="finding finding-{css_kind}" '
        f'id="finding-{file_index}-{position}">',
        f'<h4>{html.escape(title, quote=True)} {_severity_badge(severity)}</h4>',
        f'<p class="meta">{_esc_plain(_finding_location(finding))}</p>',
    ]
    if detail is not None and _text(detail).strip():
        parts.append(f'<p>{_esc(detail)}</p>')

    rows = []
    evidence = finding.get('evidence')
    if evidence is not None and _text(evidence).strip():
        rows.append(f'<dt>Evidence</dt><dd class="mono">{_esc(evidence)}</dd>')
    recommendation = finding.get('recommendation')
    if recommendation is not None and _text(recommendation).strip():
        rows.append(f'<dt>Recommendation</dt><dd>{_esc(recommendation)}</dd>')
    if rows:
        parts.append(f'<dl class="details">{"".join(rows)}</dl>')
    parts.append('</li>')
    return ''.join(parts)


def _render_findings(entry: Mapping[str, Any], file_index: int) -> str:
    findings = _findings(entry)
    if not findings:
        return f'<p class="empty">{_esc(NO_FINDINGS_TEXT)}</p>'
    items = ''.join(
        _render_finding(finding, file_index, position)
        for position, finding in enumerate(findings, start=1)
    )
    return f'<ol class="findings">{items}</ol>'


def _render_error_section(
    entry: Mapping[str, Any], file_index: int, status: str
) -> str:
    """A failed file: one error block and nothing else."""
    path = _plain(entry.get('path')) or '(unknown file)'
    error = _plain(entry.get('error')) or 'unknown error'
    bytes_cell = _int(entry.get('bytes'))
    return ''.join(
        [
            f'<section id="file-{file_index}" class="file file-error">',
            f'<h2><span class="mono">{html.escape(path, quote=True)}</span> '
            f'{_status_badge(status)}</h2>',
            f'<p class="meta">bytes: {bytes_cell}</p>',
            '<div class="error-block">',
            f'<p class="error">{html.escape(error, quote=True)}</p>',
            '</div>',
            '</section>',
        ]
    )


def _render_ok_section(entry: Mapping[str, Any], file_index: int) -> str:
    """A successful file: document facts, its summary and all its findings."""
    path = _plain(entry.get('path')) or '(unknown file)'
    return ''.join(
        [
            f'<section id="file-{file_index}" class="file">',
            f'<h2><span class="mono">{html.escape(path, quote=True)}</span> '
            f'{_status_badge("ok")}</h2>',
            f'<p class="meta">bytes: {_int(entry.get("bytes"))}</p>',
            _render_document_table(_mapping(entry.get('document'))),
            _render_file_summary_table(entry),
            '<h3>Findings</h3>',
            _render_findings(entry, file_index),
            '</section>',
        ]
    )


def _render_file_section(entry: Mapping[str, Any], file_index: int) -> str:
    status = _plain(entry.get('status')) or 'unknown'
    if status == 'ok':
        return _render_ok_section(entry, file_index)
    return _render_error_section(entry, file_index, status)


# --- entry point ------------------------------------------------------------


def render_batch_html(result: Mapping[str, Any]) -> str:
    """Render a ``BatchReport`` as one self-contained HTML document.

    The document has a title with the file count, the directory summary, a file
    table (relative path, status, pages, severity counts, error text) and one
    section per file: document facts plus every finding for an audited file, a
    single error block for a file that could not be read.  An empty directory
    and a file without findings each get an explicit message.

    The rendering is deterministic (no timestamps, no absolute paths, fixed key
    order) and every user-controlled value is escaped, so the same payload
    always produces byte-identical HTML and no PDF text can inject markup.
    A malformed payload renders as an empty batch instead of raising, because
    the report is an artifact and a missing field must not lose the file rows.
    """
    payload = _mapping(result)
    tool = _mapping(payload.get('tool'))
    root = _mapping(payload.get('root'))
    summary = _mapping(payload.get('summary'))
    entries = _entries(payload)
    version = _plain(tool.get('version')) or '0.0.0'
    schema_version = _plain(payload.get('schemaVersion')) or '1'
    file_count = _int(summary.get('files'), len(entries))

    parts = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f'<title>{_title(file_count)}</title>',
        '<style>',
        _CSS,
        '</style>',
        '</head>',
        '<body>',
        '<main>',
        '<header>',
        '<h1>PDF audit report</h1>',
        f'<p class="meta">pdf-inspector {_esc(version)} &middot; '
        f'schema {_esc(schema_version)}</p>',
        '</header>',
        _render_summary_section(root, summary),
        _render_files_section(entries),
        *[
            _render_file_section(entry, index)
            for index, entry in enumerate(entries, start=1)
        ],
        '<footer>',
        f'Generated by pdf-inspector {_esc(version)}. '
        'Deterministic report: no timestamps, no external assets, no scripts.',
        '</footer>',
        '</main>',
        '</body>',
        '</html>',
    ]
    return '\n'.join(parts) + '\n'


__all__ = [
    'NO_FILES_HINT',
    'NO_FILES_TEXT',
    'NO_FINDINGS_TEXT',
    'SEVERITY_FIELDS',
    'SEVERITY_KINDS',
    'render_batch_html',
]
