"""Plain-text and standalone HTML rendering for ``AuditReport`` dictionaries.

Both renderers are pure string builders: no external assets, no JavaScript, no
timestamps, no absolute paths of their own.  Every user-controlled value (PDF
metadata, finding titles/details/evidence) passes through :func:`html.escape`,
so PDF text such as ``<script>`` can never become markup, and identical
``AuditReport`` input renders byte-identical output (CI artifact friendly).

``format_audit_summary`` is the human text the CLI prints; ``render_audit_html``
is the single-file report written by ``--format html``.

The summary shows at most ``MAX_SUMMARY_FINDINGS`` findings and orders them
severity-first (error, then warning, then info) before truncating, so a long
report can never hide its errors or warnings behind trailing ``info`` findings.
Report order (category, page, title) is preserved inside each severity, so the
text stays deterministic.  The HTML report lists every finding in report order.
"""

from __future__ import annotations

import html
from typing import Any, Mapping, Sequence

# Findings listed in the plain-text summary before the rest is counted.
MAX_SUMMARY_FINDINGS = 20

NO_FINDINGS_TEXT = 'findings: none - no audit findings'

# Fixed severity order, so the summary never depends on dict iteration order.
SEVERITY_FIELDS = (
    ('errors', 'error'),
    ('warnings', 'warning'),
    ('info', 'info'),
)

# ``format_audit_summary`` truncation order: errors first, then warnings, info.
# Unknown severities sort last; the sort is stable, so report order survives.
SEVERITY_ORDER = {'error': 0, 'warning': 1, 'info': 2}

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
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 8px; text-align: left; vertical-align: top; border: 1px solid #e1e5ec; }
th { background: #f2f4f8; font-weight: 600; }
table.info-table th { width: 180px; }
caption { padding-bottom: 6px; text-align: left; font-weight: 600; caption-side: top; }
code, .mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 12px; }
.badge { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.badge-error { background: #fde8e8; color: #a02121; }
.badge-warning { background: #fdeedd; color: #9a4b06; }
.badge-info { background: #e7effd; color: #1f4fa8; }
.badge-unknown { background: #eef0f4; color: #4a5261; }
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

    PDF metadata and finding titles are user data; an embedded ESC byte must not
    reach the terminal, and a stray newline must not break the one-line-per-
    finding layout of the summary.
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


def _counts(report: Mapping[str, Any]) -> dict[str, int]:
    """Severity counts from ``summary``, recomputed when it is missing."""
    findings = [item for item in report.get('findings') or () if isinstance(item, Mapping)]
    summary = report.get('summary')
    if isinstance(summary, Mapping):
        counts = {field: _fmt_int(summary.get(field)) for field, _ in SEVERITY_FIELDS}
        counts['total'] = _fmt_int(summary.get('total')) or sum(counts.values())
        return counts

    counts = {field: 0 for field, _ in SEVERITY_FIELDS}
    for finding in findings:
        severity = _text(finding.get('severity'))
        for field, name in SEVERITY_FIELDS:
            if severity == name:
                counts[field] += 1
                break
    counts['total'] = len(findings)
    return counts


def _finding_location(finding: Mapping[str, Any]) -> str:
    """``metadata, page 2`` or just the category for document-level findings."""
    category = _plain(finding.get('category')) or 'unknown'
    page = finding.get('page')
    try:
        page_number = None if page is None else int(page)
    except (TypeError, ValueError):
        page_number = None
    return f'{category}, page {page_number}' if page_number is not None else category


def _document_facts(document: Mapping[str, Any]) -> str:
    language = _plain(document.get('language')) or 'none'
    version = _plain(document.get('version')) or 'unknown'
    return (
        f'{_fmt_int(document.get("pages"))} page(s), version {version}, '
        f'encrypted: {_yes_no(document.get("encrypted"))}, '
        f'tagged: {_yes_no(document.get("tagged"))}, language: {language}'
    )


def _severity_rank(finding: Mapping[str, Any]) -> int:
    return SEVERITY_ORDER.get(_plain(finding.get('severity')), len(SEVERITY_ORDER))


def prioritize_findings(
    findings: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Order findings for the summary: errors, then warnings, then info.

    The sort is stable and only re-orders whole severities, so the report's own
    order (category, page, title) is preserved inside each severity and the
    result stays deterministic.
    """
    return sorted(findings, key=_severity_rank)


# --- plain-text summary -----------------------------------------------------


def format_audit_summary(
    report: Mapping[str, Any],
    source_label: Any = None,
    *,
    max_findings: int = MAX_SUMMARY_FINDINGS,
) -> str:
    """Render the human audit summary printed by the CLI.

    The text is stable (report order within a severity, no timestamps, no ANSI
    escapes) and always carries the tool/version, the document facts, the
    severity counts and the first ``max_findings`` findings after a severity-first
    sort, so errors and warnings are never hidden behind earlier ``info``
    findings; the remainder is reported as a count.
    """
    tool = report.get('tool') or {}
    version = _plain(tool.get('version')) or '0.0.0'
    document = report.get('document') or {}
    if not isinstance(document, Mapping):
        document = {}
    findings = [
        item for item in report.get('findings') or () if isinstance(item, Mapping)
    ]
    counts = _counts(report)

    lines = [f'pdf-inspector {version} - PDF audit']
    label = _plain(source_label) if source_label is not None else ''
    if label:
        lines.append(f'file: {label}')
    lines.append(f'document: {_document_facts(document)}')
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


def _badge(severity: Any) -> str:
    value = _text(severity) or 'unknown'
    css_kind = value if value in ('error', 'warning', 'info') else 'unknown'
    return f'<span class="badge badge-{css_kind}">{_esc(value)}</span>'


def _info_row(label: str, value: Any) -> str:
    if value is None or _text(value).strip() == '':
        return f'<tr><th scope="row">{_esc(label)}</th><td class="muted">&mdash;</td></tr>'
    return f'<tr><th scope="row">{_esc(label)}</th><td>{_esc(value)}</td></tr>'


def _render_document_section(document: Mapping[str, Any]) -> str:
    rows = [
        _info_row('Pages', _fmt_int(document.get('pages'))),
        _info_row('PDF version', _text(document.get('version')) or 'unknown'),
        _info_row('Encrypted', _yes_no(document.get('encrypted'))),
        _info_row('Tagged', _yes_no(document.get('tagged'))),
        _info_row('Language', document.get('language')),
        _info_row('Title', document.get('title')),
        _info_row('Author', document.get('author')),
        _info_row('Producer', document.get('producer')),
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


def _render_summary_section(report: Mapping[str, Any]) -> str:
    counts = _counts(report)
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
            '<section id="summary">',
            '<h2>Summary</h2>',
            '<table class="summary-table">',
            '<caption>Findings by severity</caption>',
            '<thead><tr><th>Severity</th><th>Count</th></tr></thead>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
            '</section>',
        ]
    )


def _render_detail_rows(finding: Mapping[str, Any]) -> str:
    rows = []
    evidence = finding.get('evidence')
    if evidence is not None and _text(evidence).strip():
        rows.append(
            f'<dt>Evidence</dt><dd class="mono">{_esc(evidence)}</dd>'
        )
    recommendation = finding.get('recommendation')
    if recommendation is not None and _text(recommendation).strip():
        rows.append(f'<dt>Recommendation</dt><dd>{_esc(recommendation)}</dd>')
    if not rows:
        return ''
    return f'<dl class="details">{"".join(rows)}</dl>'


def _render_finding(finding: Mapping[str, Any], position: int) -> str:
    severity = _text(finding.get('severity')) or 'unknown'
    css_kind = severity if severity in ('error', 'warning', 'info') else 'unknown'
    title = _text(finding.get('title')) or '(untitled finding)'
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


def _render_findings_section(report: Mapping[str, Any]) -> str:
    findings = [
        item for item in report.get('findings') or () if isinstance(item, Mapping)
    ]
    parts = [
        '<section id="findings">',
        '<h2>Findings</h2>',
        f'<p class="muted">{len(findings)} finding(s)</p>',
    ]
    if findings:
        parts.append('<ol class="findings">')
        for position, finding in enumerate(findings, start=1):
            parts.append(_render_finding(finding, position))
        parts.append('</ol>')
    else:
        parts.append('<p class="empty">No audit findings.</p>')
    parts.append('</section>')
    return ''.join(parts)


def render_audit_html(report: Mapping[str, Any]) -> str:
    """Render a full, self-contained HTML audit report (inline CSS, no scripts)."""
    tool = report.get('tool') or {}
    version = _text(tool.get('version')) or '0.0.0'
    schema_version = _text(report.get('schemaVersion')) or '1'
    document = report.get('document') or {}
    if not isinstance(document, Mapping):
        document = {}

    lines = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f'<title>PDF audit report - pdf-inspector {_esc(version)}</title>',
        '<style>',
        _CSS,
        '</style>',
        '</head>',
        '<body>',
        '<main>',
        '<header>',
        '<h1>PDF audit report</h1>',
        f'<p class="meta">pdf-inspector {_esc(version)} &middot; schema {_esc(schema_version)}</p>',
        '</header>',
        _render_document_section(document),
        _render_summary_section(report),
        _render_findings_section(report),
        '<footer>',
        f'Generated by pdf-inspector {_esc(version)}. '
        'Deterministic report: no timestamps, no external assets, no scripts.',
        '</footer>',
        '</main>',
        '</body>',
        '</html>',
    ]
    return '\n'.join(lines) + '\n'


__all__ = [
    'MAX_SUMMARY_FINDINGS',
    'NO_FINDINGS_TEXT',
    'SEVERITY_FIELDS',
    'SEVERITY_ORDER',
    'format_audit_summary',
    'prioritize_findings',
    'render_audit_html',
]
