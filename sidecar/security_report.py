"""Plain-text and standalone HTML rendering for ``SecurityReport`` dictionaries.

Both renderers are pure string builders: no external assets, no JavaScript, no
timestamps and no absolute paths of their own.  Every user-controlled value
(attachment names, script previews, action targets, signature fields) passes
through :func:`html.escape`, so PDF text such as ``<script>`` can never become
markup, and identical ``SecurityReport`` input renders byte-identical output
(CI artifact friendly).

``format_security_summary`` is the human text the CLI prints; it shows the
document facts, the resource counts, the severity summary and at most
``MAX_SUMMARY_FINDINGS`` findings ordered severity-first (error, warning, info)
before truncating, so errors/warnings are never hidden behind later ``info``
findings.  Report order is preserved inside each severity, so the summary stays
deterministic.  ``render_security_html`` is the single-file report written by
``--format html``; it lists every resource and finding in report order.

The optional source label is reduced to its final path component (and escaped)
so a report never embeds a local directory or an absolute path.
"""

from __future__ import annotations

import html
from pathlib import PurePath
from typing import Any, Mapping, Optional, Sequence

# Findings listed in the plain-text summary before the rest is counted.
MAX_SUMMARY_FINDINGS = 20

NO_FINDINGS_TEXT = 'findings: none - no security findings'

# Fixed severity order, so the summary never depends on dict iteration order.
SEVERITY_FIELDS = (
    ('errors', 'error'),
    ('warnings', 'warning'),
    ('info', 'info'),
)

# Summary truncation order: errors first, then warnings, then info.
# Unknown severities sort last; the sort is stable, so report order survives.
SEVERITY_ORDER = {'error': 0, 'warning': 1, 'info': 2}

# Permission keys in the shared contract's order.
PERMISSION_FIELDS = (
    ('print', 'Print'),
    ('modify', 'Modify'),
    ('copy', 'Copy'),
    ('annotate', 'Annotate'),
    ('fillForms', 'Fill forms'),
    ('accessibility', 'Accessibility'),
    ('assemble', 'Assemble'),
    ('highQualityPrint', 'High-quality print'),
)

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
h2 { margin: 32px 0 12px; padding-bottom: 6px; font-size: 18px; border-bottom: 1px solid #e4e8ef; }
h3 { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0 0 6px; font-size: 15px; }
p, dl, table { margin: 0 0 12px; }
.meta, .muted { color: #5b6472; font-size: 13px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 8px; text-align: left; vertical-align: top; border: 1px solid #e1e5ec; }
th { background: #f2f4f8; font-weight: 600; }
td.num { text-align: right; white-space: nowrap; }
caption { padding-bottom: 6px; text-align: left; font-weight: 600; caption-side: top; }
code, .mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 12px; }
td.hash { overflow-wrap: anywhere; }
.badge { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.badge-error { background: #fde8e8; color: #a02121; }
.badge-warning { background: #fdeedd; color: #9a4b06; }
.badge-info { background: #e7effd; color: #1f4fa8; }
.badge-unknown { background: #eef0f4; color: #4a5261; }
.badge-allowed { background: #e6f5ea; color: #1d6b36; }
.badge-denied { background: #fdeedd; color: #9a4b06; }
article.script { margin: 0 0 16px; padding: 12px 14px; background: #fbfcfe; border: 1px solid #e1e5ec; border-radius: 8px; }
pre.script-source { margin: 8px 0 0; padding: 10px 12px; overflow-x: auto; white-space: pre; background: #f4f6fa; border: 1px solid #e1e5ec; border-radius: 6px; }
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


# --- small helpers ----------------------------------------------------------


_CONTROL_CHARS = {
    code: None for code in range(0x20) if code not in (0x09, 0x0A, 0x0D)
}
_CONTROL_CHARS.update({0x7F: None, 0x85: None})


def _text(value: Any) -> str:
    return '' if value is None else str(value)


def _plain(value: Any) -> str:
    """One line of plain text: no control characters, so no ANSI escapes.

    Attachment names, script locations and finding titles are user data; an
    embedded ESC byte must not reach the terminal, and a stray newline must not
    break the one-line-per-finding layout of the summary.
    """
    return ' '.join(_text(value).translate(_CONTROL_CHARS).split())


def _esc(value: Any) -> str:
    return html.escape(_text(value), quote=True)


def _fmt_int(value: Any) -> int:
    """Coerce a count to a non-negative int; unreadable values count as 0."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(number, 0)


def _yes_no(value: Any) -> str:
    return 'yes' if value else 'no'


def _source_label(value: Any) -> str:
    """The final path component of an optional label (never an absolute path)."""
    text = _plain(value)
    if not text:
        return ''
    # Accept POSIX and Windows separators without touching the filesystem.
    name = PurePath(text.replace('\\', '/')).name
    return name or text


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _entries(report: Mapping[str, Any], key: str) -> list[Mapping[str, Any]]:
    value = report.get(key)
    if not isinstance(value, (list, tuple)):
        return []
    return [entry for entry in value if isinstance(entry, Mapping)]


def _counts(report: Mapping[str, Any]) -> dict[str, int]:
    """Severity counts from ``summary``, recomputed when it is missing."""
    findings = _entries(report, 'findings')
    summary = report.get('summary')
    if isinstance(summary, Mapping):
        counts = {field: _fmt_int(summary.get(field)) for field, _ in SEVERITY_FIELDS}
        counts['total'] = _fmt_int(summary.get('total')) or sum(counts.values())
        return counts

    counts = {field: 0 for field, _ in SEVERITY_FIELDS}
    for finding in findings:
        severity = _plain(finding.get('severity'))
        for field, name in SEVERITY_FIELDS:
            if severity == name:
                counts[field] += 1
                break
    counts['total'] = len(findings)
    return counts


def _finding_location(finding: Mapping[str, Any]) -> str:
    """``security, page 2`` or just the category for document-level findings."""
    category = _plain(finding.get('category')) or 'unknown'
    page = finding.get('page')
    try:
        page_number = None if page is None else int(page)
    except (TypeError, ValueError):
        page_number = None
    return f'{category}, page {page_number}' if page_number is not None else category


def _document_facts(document: Mapping[str, Any]) -> str:
    version = _plain(document.get('version')) or 'unknown'
    return (
        f'{_fmt_int(document.get("pages"))} page(s), version {version}, '
        f'encrypted: {_yes_no(document.get("encrypted"))}, '
        f'XFA: {_yes_no(document.get("xfa"))}, '
        f'metadata: {_yes_no(document.get("hasMetadata"))}, '
        f'output intents: {_fmt_int(document.get("outputIntents"))}'
    )


def _severity_rank(finding: Mapping[str, Any]) -> int:
    return SEVERITY_ORDER.get(_plain(finding.get('severity')), len(SEVERITY_ORDER))


def prioritize_findings(
    findings: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Order findings for the summary: errors, then warnings, then info.

    The sort is stable and only re-orders whole severities, so the report's own
    order is preserved inside each severity and the result stays deterministic.
    """
    return sorted(findings, key=_severity_rank)


def _plural(count: int, singular: str) -> str:
    return singular if count == 1 else singular + 's'


def _tri_state(value: Any) -> str:
    if value is None:
        return 'unknown'
    return 'allowed' if value else 'denied'


def _encryption_lines(encryption: Optional[Mapping[str, Any]]) -> list[str]:
    if not isinstance(encryption, Mapping):
        return ['encryption: none']

    def number(key: str) -> str:
        value = encryption.get(key)
        try:
            return str(int(value))
        except (TypeError, ValueError):
            return 'unknown'

    key_length = encryption.get('keyLength')
    try:
        key_text = f'{int(key_length)}-bit key'
    except (TypeError, ValueError):
        key_text = 'key length unknown'

    lines = [
        f'encryption: filter {_plain(encryption.get("filter")) or "unknown"}, '
        f'V {number("version")}, R {number("revision")}, {key_text}'
    ]
    permissions = encryption.get('permissions')
    permissions = permissions if isinstance(permissions, Mapping) else {}
    pairs = ', '.join(
        f'{key}={_tri_state(permissions.get(key))}' for key, _ in PERMISSION_FIELDS
    )
    lines.append(f'permissions: {pairs}')
    return lines


# --- plain-text summary -----------------------------------------------------


def format_security_summary(
    report: Mapping[str, Any],
    source_label: Any = None,
    *,
    max_findings: int = MAX_SUMMARY_FINDINGS,
) -> str:
    """Render the human security summary printed by the CLI.

    The text is stable (report order within a severity, no timestamps, no ANSI
    escapes, no absolute paths) and always carries the document facts, the
    resource counts, the severity counts and the first ``max_findings`` findings
    after a severity-first sort; the remainder is reported as a count.
    """
    report = report if isinstance(report, Mapping) else {}
    tool = _mapping(report.get('tool'))
    version = _plain(tool.get('version')) or '0.0.0'
    document = _mapping(report.get('document'))
    attachments = _entries(report, 'attachments')
    javascript = _entries(report, 'javascript')
    actions = _entries(report, 'actions')
    signatures = _entries(report, 'signatures')
    encryption = report.get('encryption')
    findings = _entries(report, 'findings')
    counts = _counts(report)

    lines = [f'pdf-inspector {version} - PDF security']
    label = _source_label(source_label)
    if label:
        lines.append(f'file: {label}')
    lines.append(f'document: {_document_facts(document)}')
    lines.append(
        'resources: '
        f'{len(attachments)} {_plural(len(attachments), "attachment")}, '
        f'{len(javascript)} JavaScript, '
        f'{len(actions)} {_plural(len(actions), "action")}, '
        f'{len(signatures)} {_plural(len(signatures), "signature field")}'
    )
    lines.extend(_encryption_lines(encryption))
    lines.append(
        f'summary: {counts["errors"]} errors, {counts["warnings"]} warnings, '
        f'{counts["info"]} info ({counts["total"]} total)'
    )

    if not findings:
        lines.append(NO_FINDINGS_TEXT)
        return '\n'.join(lines) + '\n'

    try:
        limit = max(int(max_findings), 0)
    except (TypeError, ValueError):  # pragma: no cover - defensive
        limit = MAX_SUMMARY_FINDINGS
    ordered = prioritize_findings(findings)
    shown = ordered[:limit]
    lines.append(f'findings: {len(ordered)} total, showing {len(shown)}')
    for index, finding in enumerate(shown, start=1):
        severity = _plain(finding.get('severity')) or 'unknown'
        title = _plain(finding.get('title')) or '(untitled finding)'
        lines.append(f'  {index}. [{severity}] {_finding_location(finding)}: {title}')
    if len(ordered) > len(shown):
        lines.append(f'  ... {len(ordered) - len(shown)} more finding(s)')
    return '\n'.join(lines) + '\n'


# --- HTML report ------------------------------------------------------------


def _badge(value: Any, kind: Optional[str] = None) -> str:
    text = _text(value) or 'unknown'
    css_kind = kind or (
        text if text in ('error', 'warning', 'info', 'allowed', 'denied') else 'unknown'
    )
    return f'<span class="badge badge-{css_kind}">{_esc(text)}</span>'


def _cell(value: Any, *, mono: bool = False) -> str:
    if value is None or _text(value).strip() == '':
        return '<span class="muted">&mdash;</span>'
    css = ' class="mono"' if mono else ''
    return f'<span{css}>{_esc(value)}</span>'


def _risk_cell(risky: Any) -> str:
    if not risky:
        return _cell(None)
    return '<span class="badge badge-warning">risky</span>'


def _row(label: str, value: Any) -> str:
    return f'<tr><th scope="row">{_esc(label)}</th><td>{_cell(value)}</td></tr>'


def _fmt_size(value: Any) -> Optional[str]:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return f'{number} B' if number >= 0 else None


def _render_document_section(document: Mapping[str, Any]) -> str:
    rows = [
        _row('Pages', _fmt_int(document.get('pages'))),
        _row('PDF version', _plain(document.get('version')) or 'unknown'),
        _row('Encrypted', _yes_no(document.get('encrypted'))),
        _row('XFA form', 'Present' if document.get('xfa') else 'Absent'),
        _row('XMP metadata', _yes_no(document.get('hasMetadata'))),
        _row('Output intents', _fmt_int(document.get('outputIntents'))),
    ]
    return ''.join(
        [
            '<section id="document">',
            '<h2>Document</h2>',
            '<table class="info-table">',
            '<caption>Document information</caption>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
            '</section>',
        ]
    )


def _render_counts_section(report: Mapping[str, Any]) -> str:
    counts = _counts(report)
    rows = [
        _row('Attachments', len(_entries(report, 'attachments'))),
        _row('JavaScript', len(_entries(report, 'javascript'))),
        _row('Actions', len(_entries(report, 'actions'))),
        _row('Signature fields', len(_entries(report, 'signatures'))),
        _row('Encryption', 'Yes' if isinstance(report.get('encryption'), Mapping) else 'No'),
        _row('XFA form', 'Present' if _mapping(report.get('document')).get('xfa') else 'Absent'),
    ]
    severity_rows = [
        f'<tr><th scope="row">{_esc(label)}</th><td class="num">{counts[field]}</td></tr>'
        for field, label in (
            ('errors', 'Errors'),
            ('warnings', 'Warnings'),
            ('info', 'Info'),
            ('total', 'Total'),
        )
    ]
    return ''.join(
        [
            '<section id="summary">',
            '<h2>Summary</h2>',
            '<table class="count-table">',
            '<caption>Document resources</caption>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
            '<table class="summary-table">',
            '<caption>Findings by severity</caption>',
            '<thead><tr><th>Severity</th><th>Count</th></tr></thead>',
            '<tbody>',
            *severity_rows,
            '</tbody>',
            '</table>',
            '</section>',
        ]
    )


def _render_attachments_section(attachments: Sequence[Mapping[str, Any]]) -> str:
    parts = [
        '<section id="attachments">',
        '<h2>Attachments</h2>',
        '<p class="muted">Metadata only. No attachment is opened, extracted, '
        'decompressed or written.</p>',
    ]
    if not attachments:
        parts.append('<p class="empty">No embedded files.</p>')
    else:
        parts.extend(
            [
                '<div class="table-wrap">',
                '<table>',
                '<caption>Embedded files</caption>',
                '<thead><tr>'
                '<th scope="col">Name</th>'
                '<th scope="col">Description</th>'
                '<th scope="col">Size</th>'
                '<th scope="col">MIME type</th>'
                '<th scope="col">Modified</th>'
                '<th scope="col">SHA-256</th>'
                '<th scope="col">Risk</th>'
                '</tr></thead>',
                '<tbody>',
            ]
        )
        for attachment in attachments:
            parts.append(
                '<tr>'
                f'<td>{_cell(attachment.get("name") or "(unnamed)", mono=True)}</td>'
                f'<td>{_cell(attachment.get("description"))}</td>'
                f'<td class="num">{_cell(_fmt_size(attachment.get("size")))}</td>'
                f'<td>{_cell(attachment.get("mimeType"))}</td>'
                f'<td>{_cell(attachment.get("modified"))}</td>'
                f'<td class="hash">{_cell(attachment.get("sha256"), mono=True)}</td>'
                f'<td>{_risk_cell(attachment.get("risky"))}</td>'
                '</tr>'
            )
        parts.extend(['</tbody>', '</table>', '</div>'])
    parts.append('</section>')
    return ''.join(parts)


def _render_javascript_section(entries: Sequence[Mapping[str, Any]]) -> str:
    parts = [
        '<section id="javascript">',
        '<h2>JavaScript</h2>',
        '<p class="muted">Preview only &mdash; scripts are never executed. '
        'Sources are bounded to 4096 characters.</p>',
    ]
    if not entries:
        parts.append('<p class="empty">No JavaScript actions.</p>')
    else:
        for entry in entries:
            name = _plain(entry.get('name')) or 'JavaScript'
            location = _plain(entry.get('location')) or 'unknown location'
            page = entry.get('page')
            meta = f'location: {_esc(location)}'
            if page is not None:
                meta += f' &middot; page {_fmt_int(page)}'
            truncated = bool(entry.get('truncated'))
            source = _text(entry.get('source'))
            parts.extend(
                [
                    '<article class="script">',
                    f'<h3>{_esc(name)}'
                    + (' <span class="badge badge-warning">truncated</span>' if truncated else '')
                    + '</h3>',
                    f'<p class="meta">{meta}</p>',
                    f'<pre class="script-source">{_esc(source)}</pre>',
                    '</article>',
                ]
            )
    parts.append('</section>')
    return ''.join(parts)


def _render_actions_section(actions: Sequence[Mapping[str, Any]]) -> str:
    parts = [
        '<section id="actions">',
        '<h2>Actions</h2>',
        '<p class="muted">Targets are displayed as text. This tool never follows '
        'Launch, URI, SubmitForm or ImportData actions.</p>',
    ]
    if not actions:
        parts.append('<p class="empty">No actions.</p>')
    else:
        parts.extend(
            [
                '<div class="table-wrap">',
                '<table>',
                '<caption>Document actions</caption>',
                '<thead><tr>'
                '<th scope="col">Location</th>'
                '<th scope="col">Page</th>'
                '<th scope="col">Subtype</th>'
                '<th scope="col">Target</th>'
                '<th scope="col">Risk</th>'
                '</tr></thead>',
                '<tbody>',
            ]
        )
        for action in actions:
            page = action.get('page')
            parts.append(
                '<tr>'
                f'<td>{_cell(action.get("location"))}</td>'
                f'<td class="num">{_cell(_fmt_int(page) if page is not None else None)}</td>'
                f'<td class="mono">{_cell(action.get("subtype"), mono=True)}</td>'
                f'<td>{_cell(action.get("target"))}</td>'
                f'<td>{_risk_cell(action.get("risky"))}</td>'
                '</tr>'
            )
        parts.extend(['</tbody>', '</table>', '</div>'])
    parts.append('</section>')
    return ''.join(parts)


def _byte_range_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    return 'valid structure' if value else 'invalid structure'


def _render_signatures_section(signatures: Sequence[Mapping[str, Any]]) -> str:
    parts = [
        '<section id="signatures">',
        '<h2>Signatures</h2>',
        '<p class="muted">Signature fields are reported as present. This tool does '
        'not verify signatures cryptographically.</p>',
    ]
    if not signatures:
        parts.append('<p class="empty">No signature fields.</p>')
    else:
        parts.extend(
            [
                '<div class="table-wrap">',
                '<table>',
                '<caption>Signature fields</caption>',
                '<thead><tr>'
                '<th scope="col">Field</th>'
                '<th scope="col">Page</th>'
                '<th scope="col">Signer</th>'
                '<th scope="col">Signed at</th>'
                '<th scope="col">SubFilter</th>'
                '<th scope="col">ByteRange</th>'
                '<th scope="col">Verified</th>'
                '</tr></thead>',
                '<tbody>',
            ]
        )
        for signature in signatures:
            page = signature.get('page')
            parts.append(
                '<tr>'
                f'<td>{_cell(signature.get("fieldName"))}</td>'
                f'<td class="num">{_cell(_fmt_int(page) if page is not None else None)}</td>'
                f'<td>{_cell(signature.get("signer"))}</td>'
                f'<td>{_cell(signature.get("signedAt"))}</td>'
                f'<td class="mono">{_cell(signature.get("subFilter"), mono=True)}</td>'
                f'<td>{_cell(_byte_range_text(signature.get("byteRangeValid")))}</td>'
                '<td><span class="badge badge-warning">not verified</span></td>'
                '</tr>'
            )
        parts.extend(['</tbody>', '</table>', '</div>'])
    parts.append('</section>')
    return ''.join(parts)


def _render_encryption_section(encryption: Any) -> str:
    parts = ['<section id="encryption">', '<h2>Encryption and permissions</h2>']
    if not isinstance(encryption, Mapping):
        parts.append('<p class="empty">Not encrypted.</p>')
        parts.append('</section>')
        return ''.join(parts)

    key_length = encryption.get('keyLength')
    try:
        key_text = f'{int(key_length)} bits'
    except (TypeError, ValueError):
        key_text = None
    rows = [
        _row('Filter', encryption.get('filter')),
        _row('Version (/V)', encryption.get('version')),
        _row('Revision (/R)', encryption.get('revision')),
        _row('Key length', key_text),
    ]
    parts.extend(
        [
            '<table class="info-table">',
            '<caption>Encryption parameters</caption>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
        ]
    )

    permissions = encryption.get('permissions')
    permissions = permissions if isinstance(permissions, Mapping) else {}
    permission_rows = []
    for key, label in PERMISSION_FIELDS:
        value = permissions.get(key)
        state = _tri_state(value)
        css_kind = state if state in ('allowed', 'denied') else 'unknown'
        permission_rows.append(
            f'<tr><th scope="row">{_esc(label)}</th>'
            f'<td><span class="badge badge-{css_kind}">{_esc(state)}</span></td></tr>'
        )
    parts.extend(
        [
            '<table class="permission-table">',
            '<caption>Permissions (best-effort /P bit reading)</caption>',
            '<tbody>',
            *permission_rows,
            '</tbody>',
            '</table>',
            '<p class="muted">Permission bits are shown as read from the document. '
            'They are not a compliance verdict, and their meaning can vary with the '
            'encryption revision.</p>',
            '</section>',
        ]
    )
    return ''.join(parts)


def _render_detail_rows(finding: Mapping[str, Any]) -> str:
    rows = []
    evidence = finding.get('evidence')
    if evidence is not None and _text(evidence).strip():
        rows.append(f'<dt>Evidence</dt><dd class="mono">{_esc(evidence)}</dd>')
    recommendation = finding.get('recommendation')
    if recommendation is not None and _text(recommendation).strip():
        rows.append(f'<dt>Recommendation</dt><dd>{_esc(recommendation)}</dd>')
    if not rows:
        return ''
    return f'<dl class="details">{"".join(rows)}</dl>'


def _render_finding(finding: Mapping[str, Any], position: int) -> str:
    severity = _plain(finding.get('severity')) or 'unknown'
    css_kind = severity if severity in ('error', 'warning', 'info') else 'unknown'
    title = _plain(finding.get('title')) or '(untitled finding)'
    detail = finding.get('detail')

    parts = [
        f'<li class="finding finding-{css_kind}" id="finding-{position}">',
        f'<h3>{_esc(title)} {_badge(severity)}</h3>',
        f'<p class="meta">{_esc(_finding_location(finding))}</p>',
    ]
    if detail is not None and _text(detail).strip():
        parts.append(f'<p>{_esc(detail)}</p>')
    parts.append(_render_detail_rows(finding))
    parts.append('</li>')
    return ''.join(parts)


def _render_findings_section(findings: Sequence[Mapping[str, Any]]) -> str:
    parts = [
        '<section id="findings">',
        '<h2>Security findings</h2>',
        f'<p class="muted">{len(findings)} finding(s)</p>',
    ]
    if findings:
        parts.append('<ol class="findings">')
        for position, finding in enumerate(findings, start=1):
            parts.append(_render_finding(finding, position))
        parts.append('</ol>')
    else:
        parts.append('<p class="empty">No security findings.</p>')
    parts.append('</section>')
    return ''.join(parts)


def render_security_html(
    report: Mapping[str, Any],
    source_label: Any = None,
) -> str:
    """Render a full, self-contained HTML security report (inline CSS, no scripts)."""
    report = report if isinstance(report, Mapping) else {}
    tool = _mapping(report.get('tool'))
    version = _plain(tool.get('version')) or '0.0.0'
    schema_version = _plain(report.get('schemaVersion')) or '1'
    document = _mapping(report.get('document'))
    attachments = _entries(report, 'attachments')
    javascript = _entries(report, 'javascript')
    actions = _entries(report, 'actions')
    signatures = _entries(report, 'signatures')
    findings = _entries(report, 'findings')

    meta = f'pdf-inspector {_esc(version)} &middot; schema {_esc(schema_version)}'
    label = _source_label(source_label)
    if label:
        meta += f' &middot; file {_esc(label)}'

    lines = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f'<title>PDF security report - pdf-inspector {_esc(version)}</title>',
        '<style>',
        _CSS,
        '</style>',
        '</head>',
        '<body>',
        '<main>',
        '<header>',
        '<h1>PDF security report</h1>',
        f'<p class="meta">{meta}</p>',
        '</header>',
        _render_document_section(document),
        _render_counts_section(report),
        _render_attachments_section(attachments),
        _render_javascript_section(javascript),
        _render_actions_section(actions),
        _render_signatures_section(signatures),
        _render_encryption_section(report.get('encryption')),
        _render_findings_section(findings),
        '<footer>',
        f'Generated by pdf-inspector {_esc(version)}. '
        'Deterministic report: no timestamps, no absolute paths, no external '
        'assets. Scripts are previews only and are never executed.',
        '</footer>',
        '</main>',
        '</body>',
        '</html>',
    ]
    return '\n'.join(lines) + '\n'


__all__ = [
    'MAX_SUMMARY_FINDINGS',
    'NO_FINDINGS_TEXT',
    'PERMISSION_FIELDS',
    'SEVERITY_FIELDS',
    'SEVERITY_ORDER',
    'format_security_summary',
    'prioritize_findings',
    'render_security_html',
]
