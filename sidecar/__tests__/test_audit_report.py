"""Audit report rendering: summary text, HTML escaping, determinism, counts."""

from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from audit import audit_file, finding_fingerprint  # noqa: E402
from audit_report import (  # noqa: E402
    MAX_SUMMARY_FINDINGS,
    NO_FINDINGS_TEXT,
    format_audit_summary,
    prioritize_findings,
    render_audit_html,
)
from waivers import Waiver, WaiverApplication, apply_waivers  # noqa: E402


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


BASELINE_STATUSES = ('new', 'existing', 'moved', 'escalated', 'fixed', 'waived')


def _entry(status: str, *, current=None, baseline=None) -> dict:
    return {
        'status': status,
        'fingerprint': '0' * 32,
        'current': current,
        'baseline': baseline,
    }


def _comparison(entries) -> dict:
    counts = {status: 0 for status in BASELINE_STATUSES}
    for entry in entries:
        counts[entry['status']] += 1
    return {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': '0.2.0'},
        'current': {
            'pages': 3,
            'findings': sum(1 for entry in entries if entry['current'] is not None),
        },
        'baseline': {
            'pages': 3,
            'findings': sum(1 for entry in entries if entry['baseline'] is not None),
        },
        'summary': counts,
        'findings': list(entries),
    }


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


# --- plain-text summary: baseline -------------------------------------------


def test_summary_without_a_baseline_has_no_baseline_line():
    summary = format_audit_summary(_report([_finding()]))

    assert 'baseline:' not in summary


def test_summary_with_a_baseline_appends_exactly_one_counts_line():
    comparison = _comparison([])
    comparison['summary'] = {
        'new': 2,
        'existing': 5,
        'moved': 1,
        'escalated': 1,
        'fixed': 3,
        'waived': 0,
    }

    summary = format_audit_summary(
        _report([_finding()]), source_label='sample.pdf', baseline=comparison
    )

    lines = summary.splitlines()
    summary_index = next(
        index for index, line in enumerate(lines) if line.startswith('summary: ')
    )
    assert lines[summary_index + 1] == (
        'baseline: 2 new, 5 existing, 1 moved, 1 escalated, 3 fixed, 0 waived'
    )
    assert sum(1 for line in lines if line.startswith('baseline: ')) == 1


def test_summary_baseline_counts_fall_back_to_the_comparison_findings():
    comparison = _comparison(
        [
            _entry('new', current=_finding(page=1)),
            _entry('fixed', baseline=_finding(page=2)),
        ]
    )
    del comparison['summary']

    summary = format_audit_summary(_report([]), baseline=comparison)

    assert 'baseline: 1 new, 0 existing, 0 moved, 0 escalated, 1 fixed, 0 waived' in summary
    assert NO_FINDINGS_TEXT in summary


def test_summary_baseline_counts_are_not_truncated_by_max_findings():
    comparison = _comparison([])

    summary = format_audit_summary(
        _report([_finding(title=f'Finding {index}') for index in range(5)]),
        baseline=comparison,
        max_findings=1,
    )

    assert 'baseline: 0 new, 0 existing, 0 moved, 0 escalated, 0 fixed, 0 waived' in summary


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


# --- HTML report: baseline --------------------------------------------------


def test_html_without_a_baseline_has_no_baseline_section_or_styles():
    page = render_audit_html(_report([_finding()]))

    assert 'id="baseline"' not in page
    assert 'badge-baseline' not in page


def test_html_with_a_baseline_renders_counts_and_status_badges():
    current = _finding(
        category='images', page=5, title='Current title',
        detail='Moved detail.', evidence='evidence',
    )
    previous = _finding(category='images', page=3, title='Old title')
    comparison = _comparison(
        [
            _entry('moved', current=current, baseline=previous),
            _entry('fixed', baseline=_finding(title='Fixed title', page=2)),
            _entry('new', current=_finding(title='New title', page=6)),
            _entry('escalated', current=_finding(severity='error', page=7)),
        ]
    )

    section = _section(render_audit_html(_report([current]), baseline=comparison), 'baseline')

    assert '<h2>Baseline</h2>' in section
    assert '<th scope="row">New</th><td>1</td>' in section
    assert '<th scope="row">Existing</th><td>0</td>' in section
    assert '<th scope="row">Moved</th><td>1</td>' in section
    assert '<th scope="row">Escalated</th><td>1</td>' in section
    assert '<th scope="row">Fixed</th><td>1</td>' in section
    assert '<th scope="row">Waived</th><td>0</td>' in section
    assert 'badge-baseline-moved' in section
    assert 'badge-baseline-fixed' in section
    assert 'badge-baseline-new' in section
    assert 'badge-baseline-escalated' in section
    assert 'p.3 &rarr; p.5' in section
    assert 'Current title' in section
    assert 'Fixed title' in section
    assert 'New title' in section
    assert section.count('<li class="baseline-finding">') == 4


def test_html_baseline_section_escapes_every_value():
    current = _finding(
        title='<script>alert("title")</script>',
        detail='<img src=x onerror="alert(1)">',
    )
    comparison = _comparison(
        [
            _entry('new', current=current),
            _entry('fixed', baseline=_finding(title='"><script>x</script>')),
        ]
    )

    page = render_audit_html(_report([current]), baseline=comparison)

    assert '<script' not in page
    assert '<img' not in page
    assert '&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;' in page
    assert '&quot;&gt;&lt;script&gt;x&lt;/script&gt;' in page


def test_html_with_a_baseline_stays_script_free_and_deterministic():
    comparison = _comparison(
        [
            _entry('new', current=_finding(page=1)),
            _entry('fixed', baseline=_finding(page=2)),
        ]
    )
    report = _report([_finding(severity='warning', page=1)])

    first = render_audit_html(report, baseline=comparison)
    second = render_audit_html(report, baseline=comparison)

    assert first == second
    assert '\r' not in first
    lowered = first.lower()
    for marker in ('<script', '<iframe', '<link', 'javascript:', '@import'):
        assert marker not in lowered


# --- waivers ----------------------------------------------------------------

TODAY = date(2026, 6, 1)


def _waiver(
    fingerprint: str = '0' * 32,
    *,
    page=None,
    reason: str = 'Legacy template; tracked in DOC-1234',
    expires: date = date(2026, 12, 31),
) -> Waiver:
    return Waiver(fingerprint=fingerprint, page=page, reason=reason, expires=expires)


def _application(findings, *waivers) -> WaiverApplication:
    return apply_waivers(list(findings), list(waivers), today=TODAY)


def test_summary_without_waivers_has_no_waivers_line():
    summary = format_audit_summary(_report([_finding()]))

    assert 'waivers:' not in summary


def test_summary_with_waivers_appends_exactly_one_counts_line():
    finding = _finding(page=2)
    application = WaiverApplication(
        applied={0: _waiver(reason='Tracked in DOC-1234')},
        expired=(_waiver(reason='Old policy', expires=date(2000, 1, 1)),),
        unused=(_waiver(reason='Stale one'), _waiver(reason='Stale two')),
    )

    summary = format_audit_summary(_report([finding]), waivers=application)

    lines = summary.splitlines()
    summary_index = next(
        index for index, line in enumerate(lines) if line.startswith('summary: ')
    )
    assert lines[summary_index + 1] == 'waivers: 1 applied, 1 expired, 2 unused'
    assert summary.count('waivers: ') == 1
    # The waiver file path is never printed, only policy facts.
    assert 'waivers.json' not in summary


def test_summary_waiver_line_follows_the_baseline_line():
    comparison = _comparison([_entry('new', current=_finding(page=1))])
    application = WaiverApplication(applied={}, expired=(), unused=())

    summary = format_audit_summary(
        _report([_finding()]), baseline=comparison, waivers=application
    )

    lines = summary.splitlines()
    baseline_index = next(
        index for index, line in enumerate(lines) if line.startswith('baseline: ')
    )
    assert lines[baseline_index + 1] == 'waivers: 0 applied, 0 expired, 0 unused'


def test_summary_waiver_line_accepts_a_plain_mapping():
    summary = format_audit_summary(
        _report([_finding()]),
        waivers={
            'applied': {0: {'reason': 'why', 'expires': '2026-12-31'}},
            'expired': [],
            'unused': [{'reason': 'stale', 'expires': '2026-12-31'}],
        },
    )

    assert 'waivers: 1 applied, 0 expired, 1 unused' in summary


def test_html_without_waivers_has_no_waivers_section_or_styles():
    report = _report([_finding()])

    page = render_audit_html(report)

    assert 'id="waivers"' not in page
    assert 'badge-waived' not in page
    assert 'waiver-table' not in page
    # Passing ``waivers=None`` explicitly must be byte-identical to omitting it.
    assert render_audit_html(report, waivers=None) == page


def test_html_with_waivers_renders_counts_reason_and_expiry():
    finding = _finding(
        category='fonts', severity='warning', page=3, title='Waived title'
    )
    waiver = _waiver(
        finding_fingerprint(finding), page=3, reason='Legacy template', expires=date(2027, 1, 31)
    )
    application = _application([finding], waiver)
    report = _report([{**finding, 'fingerprint': finding_fingerprint(finding)}])

    page = render_audit_html(report, waivers=application)
    section = _section(page, 'waivers')

    assert '<h2>Waivers</h2>' in section
    assert '<th scope="row">Applied</th><td>1</td>' in section
    assert '<th scope="row">Expired</th><td>0</td>' in section
    assert '<th scope="row">Unused</th><td>0</td>' in section
    assert 'Legacy template' in section
    assert '2027-01-31' in section
    assert finding_fingerprint(finding) in section
    assert section.count('<li class="waiver waiver-applied">') == 1
    assert 'badge-waived' in section


def test_html_waived_finding_gets_a_waived_badge():
    finding = _finding(severity='warning', title='Waived title', page=3)
    report = _report([{**finding, 'fingerprint': finding_fingerprint(finding)}])
    application = _application([report['findings'][0]], _waiver(finding_fingerprint(finding)))

    page = render_audit_html(report, waivers=application)
    findings_section = _section(page, 'findings')

    assert (
        '<span class="badge badge-warning">warning</span> '
        '<span class="badge badge-waived">waived</span>'
    ) in findings_section


def test_html_waived_badge_uses_the_raw_finding_index():
    finding = _finding(severity='warning', title='Waived title', page=3)
    fingerprint = finding_fingerprint(finding)
    # A non-Mapping entry must not shift the id or the waived badge of the
    # finding after it: waivers index the raw findings array.
    report = _report([None, {**finding, 'fingerprint': fingerprint}])
    application = WaiverApplication(applied={1: _waiver(fingerprint)})

    page = render_audit_html(report, waivers=application)
    findings_section = _section(page, 'findings')

    assert '<p class="muted">1 finding(s)</p>' in findings_section
    assert 'id="finding-2"' in findings_section
    assert 'id="finding-1"' not in findings_section
    assert '<span class="badge badge-waived">waived</span>' in findings_section


def test_html_waivers_section_escapes_the_reason():
    reason = '<script>alert("reason")</script>'
    waiver = _waiver(reason=reason)
    page = render_audit_html(
        _report([_finding()]),
        waivers=WaiverApplication(applied={}, expired=(waiver,), unused=()),
    )

    assert '<script' not in page
    assert '&lt;script&gt;alert(&quot;reason&quot;)&lt;/script&gt;' in page


def test_html_expired_waivers_are_listed_and_badged():
    expired = _waiver(reason='Expired policy', expires=date(2000, 1, 1))
    page = render_audit_html(
        _report([_finding()]),
        waivers=WaiverApplication(applied={}, expired=(expired,), unused=()),
    )

    section = _section(page, 'waivers')
    assert '<li class="waiver waiver-expired">' in section
    assert 'badge-waiver-expired' in section
    assert 'Expired policy' in section
    assert '2000-01-01' in section


def test_html_with_a_baseline_shows_the_waiver_in_the_baseline_section():
    finding = _finding(title='Waived title', page=3)
    comparison = _comparison(
        [
            {
                'status': 'waived',
                'fingerprint': '0' * 32,
                'current': finding,
                'baseline': None,
                'waiver': {'reason': 'Tracked in DOC-1234', 'expires': '2026-12-31'},
            }
        ]
    )

    page = render_audit_html(_report([finding]), baseline=comparison)
    section = _section(page, 'baseline')

    assert 'badge-baseline-waived' in section
    assert 'waiver: Tracked in DOC-1234 (expires 2026-12-31)' in section
    assert 'id="waivers"' not in page  # a comparison alone carries no policy


def test_html_waivers_and_baseline_together_stay_script_free_and_deterministic():
    finding = _finding(title='Waived title', page=3)
    report = _report([findings := {**finding, 'fingerprint': finding_fingerprint(finding)}])
    application = _application([findings], _waiver(findings['fingerprint'], page=3))
    comparison = _comparison([_entry('waived', current=findings)])

    first = render_audit_html(report, baseline=comparison, waivers=application)
    second = render_audit_html(report, baseline=comparison, waivers=application)

    assert first == second
    assert '\r' not in first
    lowered = first.lower()
    for marker in ('<script', '<iframe', '<link', 'javascript:', '@import'):
        assert marker not in lowered
    assert '/tmp/' not in first and '/home/' not in first
    assert 'id="waivers"' in first and 'id="baseline"' in first


def test_html_with_waivers_only_adds_the_waiver_styles():
    report = _report([_finding()])

    page = render_audit_html(
        report, waivers=WaiverApplication(applied={}, expired=(), unused=())
    )

    assert 'badge-waived' in page  # the stylesheet, not a badge
    assert 'badge-baseline' not in page
    assert 'id="waivers"' in page


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
