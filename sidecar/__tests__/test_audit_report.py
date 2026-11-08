"""Audit report rendering: summary text, HTML escaping, determinism, counts."""

from __future__ import annotations

import re
import sys
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from audit import audit_file  # noqa: E402
from audit_report import (  # noqa: E402
    MAX_SUMMARY_FINDINGS,
    NO_FINDINGS_TEXT,
    format_audit_summary,
    prioritize_findings,
    render_audit_html,
)


# --- fixture builders -------------------------------------------------------


def _finding(
    *,
    category: str = 'metadata',
    severity: str = 'info',
    page=None,
    title: str = 'Missing document title',
    detail: str = 'The document information dictionary has no Title.',
    evidence=None,
    recommendation=None,
) -> dict:
    return {
        'category': category,
        'severity': severity,
        'page': page,
        'title': title,
        'detail': detail,
        'evidence': evidence,
        'recommendation': recommendation,
    }


def _document(**overrides) -> dict:
    document = {
        'pages': 3,
        'version': '1.4',
        'encrypted': False,
        'title': 'Quarterly report',
        'author': 'Example Author',
        'producer': 'ReportLab',
        'language': 'en-US',
        'tagged': True,
    }
    document.update(overrides)
    return document


def _report(findings, *, document=None, summary=None, version='0.2.0') -> dict:
    report = {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': version},
        'document': _document() if document is None else document,
        'findings': list(findings),
    }
    if summary is not None:
        report['summary'] = summary
    return report


def _section(html_text: str, section_id: str) -> str:
    start = html_text.index(f'<section id="{section_id}">')
    end = html_text.index('</section>', start)
    return html_text[start:end]


def _text_pdf(path: Path) -> str:
    canvas = rl_canvas.Canvas(str(path), pagesize=letter)
    canvas.setFont('Helvetica', 12)
    canvas.drawString(72, 720, 'hello')
    canvas.showPage()
    canvas.save()
    return str(path)


# --- plain-text summary -----------------------------------------------------


def test_summary_reports_tool_document_counts_and_findings():
    report = _report(
        [
            _finding(category='fonts', severity='warning', title='Font not embedded: X'),
            _finding(category='images', severity='warning', page=2,
                     title='Page 2 has images but no extractable text'),
            _finding(category='metadata', severity='info', title='Missing document title'),
        ],
        summary={'total': 3, 'errors': 0, 'warnings': 2, 'info': 1},
    )

    summary = format_audit_summary(report, source_label='sample.pdf')

    assert summary.startswith('pdf-inspector 0.2.0 - PDF audit\n')
    assert 'file: sample.pdf' in summary
    assert 'document: 3 page(s), version 1.4, encrypted: no, tagged: yes, language: en-US' in summary
    assert 'summary: 0 errors, 2 warnings, 1 info (3 total)' in summary
    assert 'findings: 3 total, showing 3' in summary
    assert '1. [warning] fonts: Font not embedded: X' in summary
    assert '2. [warning] images, page 2: Page 2 has images but no extractable text' in summary
    assert '3. [info] metadata: Missing document title' in summary
    assert summary.endswith('\n')


def test_summary_without_a_label_omits_the_file_line():
    summary = format_audit_summary(_report([_finding()]))

    assert 'file:' not in summary
    assert summary.splitlines()[0] == 'pdf-inspector 0.2.0 - PDF audit'


def test_summary_uses_document_placeholders_for_missing_values():
    document = _document(version=None, language=None, encrypted=True, tagged=False)

    summary = format_audit_summary(_report([], document=document))

    assert 'version unknown' in summary
    assert 'encrypted: yes' in summary
    assert 'tagged: no' in summary
    assert 'language: none' in summary


def test_summary_with_no_findings_says_so():
    summary = format_audit_summary(_report([], summary={'total': 0, 'errors': 0, 'warnings': 0, 'info': 0}))

    assert NO_FINDINGS_TEXT in summary
    assert 'summary: 0 errors, 0 warnings, 0 info (0 total)' in summary
    assert 'findings: 0 total' not in summary


def test_summary_is_bounded_and_states_the_remaining_count():
    findings = [
        _finding(title=f'Finding {index:02d}', page=index) for index in range(1, 26)
    ]
    report = _report(findings, summary={'total': 25, 'errors': 0, 'warnings': 0, 'info': 25})

    summary = format_audit_summary(report)

    assert f'findings: 25 total, showing {MAX_SUMMARY_FINDINGS}' in summary
    assert 'Finding 20' in summary
    assert 'Finding 21' not in summary
    assert '... 5 more finding(s)' in summary


def test_summary_max_findings_is_configurable():
    findings = [_finding(title=f'Finding {index}') for index in range(3)]

    summary = format_audit_summary(_report(findings), max_findings=1)

    assert 'showing 1' in summary
    assert '... 2 more finding(s)' in summary


def test_summary_puts_errors_before_warnings_before_info():
    findings = [
        _finding(severity='info', title='Info finding'),
        _finding(severity='warning', title='Warning finding'),
        _finding(severity='error', title='Error finding'),
    ]

    summary = format_audit_summary(
        _report(findings, summary={'total': 3, 'errors': 1, 'warnings': 1, 'info': 1})
    )

    assert re.findall(r'^\s+\d+\. \[(\w+)\]', summary, re.MULTILINE) == [
        'error',
        'warning',
        'info',
    ]


def test_summary_shows_warnings_before_later_info_findings_when_truncated():
    """A long report must not hide warnings behind trailing info findings."""
    findings = [
        _finding(severity='info', title=f'Info {index:02d}', page=index)
        for index in range(1, 23)
    ]
    findings += [
        _finding(severity='warning', title=f'Warning {index}', page=100 + index)
        for index in range(1, 4)
    ]
    report = _report(
        findings, summary={'total': 25, 'errors': 0, 'warnings': 3, 'info': 22}
    )

    summary = format_audit_summary(report)

    assert re.findall(r'^\s+\d+\. \[(\w+)\]', summary, re.MULTILINE) == [
        'warning',
        'warning',
        'warning',
    ] + ['info'] * (MAX_SUMMARY_FINDINGS - 3)
    assert '  1. [warning] metadata, page 101: Warning 1' in summary
    assert '  4. [info] metadata, page 1: Info 01' in summary
    assert 'Info 17' in summary
    assert 'Info 18' not in summary
    assert '... 5 more finding(s)' in summary


def test_summary_keeps_report_order_inside_a_severity():
    findings = [
        _finding(severity='warning', title='warning first'),
        _finding(severity='info', title='info first'),
        _finding(severity='warning', title='warning second'),
        _finding(severity='info', title='info second'),
    ]

    summary = format_audit_summary(
        _report(findings, summary={'total': 4, 'errors': 0, 'warnings': 2, 'info': 2})
    )

    titles = re.findall(r': (warning first|warning second|info first|info second)$', summary, re.MULTILINE)
    assert titles == ['warning first', 'warning second', 'info first', 'info second']


def test_prioritize_findings_is_stable_and_puts_unknown_severities_last():
    findings = [
        _finding(severity='info', title='info a'),
        _finding(severity='warning', title='warning a'),
        _finding(severity='mystery', title='unknown'),
        _finding(severity='info', title='info b'),
        _finding(severity='error', title='error a'),
        _finding(severity='warning', title='warning b'),
    ]

    ordered = prioritize_findings(findings)

    assert [finding['title'] for finding in ordered] == [
        'error a',
        'warning a',
        'warning b',
        'info a',
        'info b',
        'unknown',
    ]
    assert ordered is not findings


def test_summary_counts_fall_back_to_the_findings_when_summary_is_absent():
    report = _report(
        [
            _finding(severity='error'),
            _finding(severity='warning'),
            _finding(severity='info'),
        ]
    )

    summary = format_audit_summary(report)

    assert 'summary: 1 errors, 1 warnings, 1 info (3 total)' in summary


def test_summary_has_no_ansi_escapes_or_carriage_returns():
    report = _report(
        [_finding(severity='error', page=1, title='Bad \x1b[31mred\x1b[0m title')]
    )

    summary = format_audit_summary(report)

    assert '\x1b' not in summary
    assert '\r' not in summary


def test_summary_is_deterministic():
    report = _report(
        [_finding(severity='warning', page=1), _finding(severity='info', page=2)],
        summary={'total': 2, 'errors': 0, 'warnings': 1, 'info': 1},
    )

    assert format_audit_summary(report) == format_audit_summary(report)


def test_summary_keeps_user_text_verbatim_as_plain_text():
    report = _report([_finding(title='<script>alert("x")</script>')])

    summary = format_audit_summary(report)

    assert '<script>alert("x")</script>' in summary
    assert '&lt;script&gt;' not in summary


# --- HTML report ------------------------------------------------------------


def test_html_is_a_standalone_document_with_a_report_title():
    page = render_audit_html(_report([_finding()]))

    assert page.startswith('<!DOCTYPE html>\n')
    assert '<html lang="en">' in page
    assert '<title>PDF audit report - pdf-inspector 0.2.0</title>' in page
    assert '<style>' in page and '</style>' in page
    assert page.endswith('</html>\n')


def test_html_has_semantic_sections_for_document_summary_and_findings():
    page = render_audit_html(_report([_finding(page=2)]))

    for section_id, heading in (
        ('document', 'Document'),
        ('summary', 'Summary'),
        ('findings', 'Findings'),
    ):
        section = _section(page, section_id)
        assert f'<h2>{heading}</h2>' in section

    assert 'Document information' in _section(page, 'document')
    assert 'Findings by severity' in _section(page, 'summary')


def test_html_renders_document_information():
    page = render_audit_html(_report([], document=_document()))

    section = _section(page, 'document')

    assert '<td>3</td>' in section  # pages
    assert '>1.4<' in section
    assert '>no<' in section  # encrypted
    assert '>yes<' in section  # tagged
    assert '>en-US<' in section
    assert 'Quarterly report' in section


def test_html_uses_placeholders_for_absent_document_values():
    document = _document(language=None, title=None, author=None, producer=None)

    section = _section(render_audit_html(_report([], document=document)), 'document')

    assert '&mdash;' in section
    assert 'None' not in section


def test_html_summary_counts_match_the_report():
    report = _report(
        [
            _finding(severity='error'),
            _finding(severity='warning'),
            _finding(severity='warning'),
            _finding(severity='info'),
        ],
        summary={'total': 4, 'errors': 1, 'warnings': 2, 'info': 1},
    )

    section = _section(render_audit_html(report), 'summary')

    assert '<th scope="row">Errors</th><td>1</td>' in section
    assert '<th scope="row">Warnings</th><td>2</td>' in section
    assert '<th scope="row">Info</th><td>1</td>' in section
    assert '<th scope="row">Total</th><td>4</td>' in section


def test_html_renders_each_finding_with_severity_page_and_details():
    report = _report(
        [
            _finding(
                category='images',
                severity='warning',
                page=4,
                title='Page 4 has a low-resolution image',
                detail='Image 0 on page 4 is drawn at 48 dpi.',
                evidence='pixels 8 x 8, box 200 x 200 pt, effective 2.88 dpi',
                recommendation='Use a higher-resolution image.',
            )
        ],
        summary={'total': 1, 'errors': 0, 'warnings': 1, 'info': 0},
    )

    section = _section(render_audit_html(report), 'findings')

    assert '<li class="finding finding-warning" id="finding-1">' in section
    assert '<span class="badge badge-warning">warning</span>' in section
    assert 'images, page 4' in section
    assert 'Page 4 has a low-resolution image' in section
    assert 'Image 0 on page 4 is drawn at 48 dpi.' in section
    assert 'pixels 8 x 8, box 200 x 200 pt, effective 2.88 dpi' in section
    assert 'Use a higher-resolution image.' in section


def test_html_with_no_findings_says_there_are_none():
    section = _section(
        render_audit_html(
            _report([], summary={'total': 0, 'errors': 0, 'warnings': 0, 'info': 0})
        ),
        'findings',
    )

    assert '0 finding(s)' in section
    assert 'No audit findings.' in section
    assert '<ol class="findings">' not in section


def test_html_escapes_every_user_value():
    report = _report(
        [
            _finding(
                title='<script>alert("title")</script>',
                detail='<script>alert("detail")</script>',
                evidence='<script>alert("evidence")</script>',
                recommendation='<script>alert("recommendation")</script>',
            )
        ],
        document=_document(title='<img src=x onerror="alert(1)">', author='"><script>x</script>'),
    )

    page = render_audit_html(report)

    assert '<script' not in page
    assert '<img' not in page
    assert '&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;' in page
    assert '&lt;script&gt;alert(&quot;detail&quot;)&lt;/script&gt;' in page
    assert '&lt;script&gt;alert(&quot;evidence&quot;)&lt;/script&gt;' in page
    assert '&lt;script&gt;alert(&quot;recommendation&quot;)&lt;/script&gt;' in page
    assert '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;' in page
    assert '&quot;&gt;&lt;script&gt;x&lt;/script&gt;' in page


def test_html_has_no_external_assets_or_interactive_content():
    page = render_audit_html(_report([_finding(page=1)]))

    lowered = page.lower()
    for marker in (
        '<script',
        '<iframe',
        '<link',
        '<object',
        '<embed',
        'javascript:',
        '@import',
        'http://',
        'https://',
    ):
        assert marker not in lowered
    assert ' src=' not in lowered


def test_html_is_deterministic_and_uses_lf_only():
    report = _report(
        [_finding(severity='warning', page=1), _finding(severity='info', page=2)],
        summary={'total': 2, 'errors': 0, 'warnings': 1, 'info': 1},
    )

    first = render_audit_html(report)
    second = render_audit_html(report)

    assert first == second
    assert '\r' not in first


def test_html_does_not_embed_absolute_paths_or_timestamps():
    page = render_audit_html(_report([_finding()]))

    assert not re.search(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', page)
    assert '/tmp/' not in page
    assert '/home/' not in page


# --- integration with the real audit engine --------------------------------


def test_real_audit_report_renders_summary_and_html(tmp_path):
    path = _text_pdf(tmp_path / 'text.pdf')
    report = audit_file(path)

    summary = format_audit_summary(report, source_label='text.pdf')
    page = render_audit_html(report)

    assert 'pdf-inspector' in summary
    assert '1 page(s)' in summary
    assert f'summary: 0 errors, 0 warnings, {report["summary"]["info"]} info' in summary
    assert '<title>PDF audit report' in page
    assert f'{len(report["findings"])} finding(s)' in page
    assert str(tmp_path) not in page
