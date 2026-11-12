"""Accessibility report renderers: deterministic summary, counts and safe HTML.

The renderers are pure functions over an ``AccessibilityReport`` dict, so the
tests build contract-shaped reports directly.  Every user-controlled value
(document title/language, finding text/evidence) must stay escaped, and the
HTML output must stay self-contained: inline CSS only, no scripts, no external
assets and no absolute paths.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import accessibility_report  # noqa: E402
from accessibility_report import (  # noqa: E402
    format_accessibility_summary,
    prioritize_findings,
    render_accessibility_html,
    structure_counts,
)


# --- fixtures ---------------------------------------------------------------


def _finding(
    severity: str,
    title: str,
    *,
    category: str = 'structure',
    page=None,
    detail: str = 'detail',
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


def _node(
    role: str,
    *,
    kind: str = 'element',
    node_id: str = '0',
    page=1,
    alt=None,
    actual_text=None,
    attributes=None,
    children=(),
) -> dict:
    return {
        'id': node_id,
        'kind': kind,
        'role': role,
        'rawRole': role if kind == 'element' else None,
        'title': None,
        'alt': alt,
        'actualText': actual_text,
        'lang': None,
        'page': page,
        'mcid': None,
        'objectNumber': None,
        'attributes': dict(attributes or {}),
        'children': list(children),
        'truncated': False,
    }


def _document(**overrides) -> dict:
    document = {
        'pages': 1,
        'version': '1.7',
        'encrypted': False,
        'tagged': True,
        'hasStructTreeRoot': True,
        'hasParentTree': True,
        'language': 'en-US',
        'title': 'Accessibility sample',
        'roleMap': {},
        'truncated': False,
        'skipped': 0,
    }
    document.update(overrides)
    return document


def _report(findings=(), *, document=None, structure=(), version='0.2.0') -> dict:
    """A complete, contract-shaped ``AccessibilityReport``."""
    ordered = list(findings)
    counts = {
        field: sum(1 for item in ordered if item['severity'] == name)
        for field, name in accessibility_report.SEVERITY_FIELDS
    }
    counts['total'] = len(ordered)
    return {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': version},
        'document': _document() if document is None else document,
        'structure': list(structure),
        'findings': ordered,
        'summary': counts,
    }


def _tagged_tree() -> list[dict]:
    """Document -> H1, P, Figure(/Alt), Table -> TR -> TH+TD, L -> LI -> LBody."""
    return [
        _node(
            'Document',
            node_id='0',
            children=[
                _node('H1', node_id='0/0', children=[_node('MCID', kind='mcid')]),
                _node('P', node_id='0/1', children=[_node('MCID', kind='mcid')]),
                _node(
                    'Figure',
                    node_id='0/2',
                    alt='Revenue by quarter',
                    children=[_node('MCID', kind='mcid')],
                ),
                _node(
                    'Table',
                    node_id='0/3',
                    children=[
                        _node(
                            'TR',
                            node_id='0/3/0',
                            children=[
                                _node(
                                    'TH',
                                    node_id='0/3/0/0',
                                    attributes={'Scope': 'Column'},
                                ),
                                _node('TD', node_id='0/3/0/1'),
                            ],
                        )
                    ],
                ),
                _node(
                    'L',
                    node_id='0/4',
                    children=[
                        _node(
                            'LI',
                            node_id='0/4/0',
                            children=[_node('LBody', node_id='0/4/0/0')],
                        )
                    ],
                ),
            ],
        )
    ]


# --- plain-text summary -----------------------------------------------------


def test_summary_reports_document_facts_counts_and_severities():
    report = _report(
        findings=[
            _finding('warning', 'Figure has no alternative text', page=1),
            _finding('info', 'List item has no LBody', page=None),
        ],
        structure=_tagged_tree(),
    )

    text = format_accessibility_summary(report, 'sample.pdf')

    assert text.startswith('pdf-inspector 0.2.0 - PDF accessibility\n')
    assert 'file: sample.pdf\n' in text
    assert (
        'document: 1 page(s), version 1.7, encrypted: no, tagged: yes, '
        'language: en-US' in text
    )
    assert 'structure: elements 11, figures 1, tables 1, lists 1, headings 1' in text
    assert (
        'tree: StructTreeRoot yes, ParentTree yes, truncated no, skipped 0' in text
    )
    assert 'title: Accessibility sample' in text
    assert 'summary: 0 errors, 1 warnings, 1 info (2 total)' in text
    assert '  1. [warning] structure, page 1: Figure has no alternative text' in text
    assert '  2. [info] structure: List item has no LBody' in text


def test_summary_counts_mcid_and_objr_content_separately_from_elements():
    counts = structure_counts(_report(structure=_tagged_tree()))

    # Document, H1, P, Figure, Table, TR, TH, TD, L, LI, LBody = 11 elements
    # plus the three MCID nodes under H1/P/Figure.
    assert counts == {
        'elements': 11,
        'figures': 1,
        'tables': 1,
        'lists': 1,
        'headings': 1,
        'contents': 3,
    }


def test_summary_counts_untagged_and_empty_reports():
    report = _report(
        document=_document(
            pages=2,
            tagged=False,
            hasStructTreeRoot=False,
            hasParentTree=False,
            language=None,
            title=None,
        ),
        structure=[],
    )

    text = format_accessibility_summary(report)

    assert 'document: 2 page(s), version 1.7, encrypted: no, tagged: no, language: none' in text
    assert 'structure: elements 0, figures 0, tables 0, lists 0, headings 0' in text
    assert 'tree: StructTreeRoot no, ParentTree no, truncated no, skipped 0' in text
    assert 'title:' not in text
    assert accessibility_report.NO_FINDINGS_TEXT in text


def test_summary_orders_findings_severity_first_and_truncates():
    findings = [_finding('info', f'Info {index:02d}') for index in range(1, 23)]
    findings += [_finding('warning', f'Warn {index}') for index in range(1, 4)]
    findings += [_finding('error', f'Error {index}') for index in range(1, 3)]
    report = _report(findings)

    text = format_accessibility_summary(report)
    severities = re.findall(r'^\s+\d+\. \[([a-z]+)\]', text, re.MULTILINE)

    assert severities == ['error'] * 2 + ['warning'] * 3 + ['info'] * 15
    assert 'findings: 27 total, showing 20' in text
    assert '... 7 more finding(s)' in text
    assert 'Info 16' not in text
    assert prioritize_findings(findings)[0]['title'] == 'Error 1'


def test_summary_honours_a_custom_finding_limit():
    findings = [_finding('info', f'Info {index:02d}') for index in range(1, 6)]

    text = format_accessibility_summary(_report(findings), max_findings=2)

    assert 'findings: 5 total, showing 2' in text
    assert '... 3 more finding(s)' in text


def test_summary_is_deterministic_and_strips_control_characters():
    report = _report(
        findings=[_finding('warning', 'bad \x1b[31mred\nsecond line')],
        document=_document(title='Title\x1b[0m\nsplit'),
    )

    first = format_accessibility_summary(report, 'sample.pdf')
    second = format_accessibility_summary(report, 'sample.pdf')

    assert first == second
    assert '\x1b' not in first
    assert 'bad [31mred second line' in first
    assert 'title: Title[0m split' in first


def test_summary_never_embeds_an_absolute_path():
    report = _report(findings=[_finding('warning', 'Structure tree has no ParentTree')])

    posix = format_accessibility_summary(report, '/tmp/secret/report.pdf')
    windows = format_accessibility_summary(report, r'C:\Users\me\secret\report.pdf')

    assert 'file: report.pdf' in posix
    assert '/tmp/secret' not in posix
    assert 'file: report.pdf' in windows
    assert 'C:\\Users' not in windows
    assert 'secret' not in posix and 'secret' not in windows


# --- HTML report ------------------------------------------------------------


def test_html_is_standalone_and_has_no_active_content():
    report = _report(
        findings=[_finding('warning', 'Figure has no alternative text', page=1)],
        structure=_tagged_tree(),
    )

    html = render_accessibility_html(report)

    assert html.startswith('<!DOCTYPE html>')
    assert '<style>' in html
    assert '<title>PDF accessibility report - pdf-inspector 0.2.0</title>' in html
    for forbidden in ('<script', '<link', 'src=', '@import', 'href=', 'http://', 'https://'):
        assert forbidden not in html
    for section in (
        '<h2>Document</h2>',
        '<h2>Summary</h2>',
        '<h2>Accessibility findings</h2>',
        '<caption>Structure counts</caption>',
    ):
        assert section in html

    # Structure counts render the same numbers as the summary.
    assert '<th scope="row">Structure elements</th><td class="num">11</td>' in html
    assert '<th scope="row">Figures</th><td class="num">1</td>' in html
    assert '<th scope="row">Tables</th><td class="num">1</td>' in html
    assert '<th scope="row">Lists</th><td class="num">1</td>' in html
    assert '<th scope="row">Headings</th><td class="num">1</td>' in html
    assert '<th scope="row">MCID/OBJR content items</th><td class="num">3</td>' in html


def test_html_escapes_every_user_controlled_value():
    report = _report(
        findings=[
            _finding(
                'warning',
                '<script>alert("title")</script>',
                detail='<img src=x onerror=alert(1)>',
                evidence='"><svg onload=alert(2)>',
                recommendation='<b>fix</b>',
            )
        ],
        document=_document(
            title='<script>alert("title")</script>',
            language='"><img src=x>',
            roleMap={'<em>Custom</em>': '<b>P</b>'},
        ),
        structure=_tagged_tree(),
    )

    html = render_accessibility_html(report)

    assert '<script' not in html
    assert '<img' not in html
    assert '<svg' not in html
    assert '<b>' not in html
    assert '<em>' not in html
    assert '&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;' in html
    assert '&lt;img src=x onerror=alert(1)&gt;' in html
    assert '&quot;&gt;&lt;svg onload=alert(2)&gt;' in html
    assert '&lt;b&gt;fix&lt;/b&gt;' in html


def test_html_is_deterministic_and_has_no_paths_or_timestamps():
    report = _report(
        findings=[_finding('warning', 'Figure has no alternative text', page=1)],
        structure=_tagged_tree(),
    )

    first = render_accessibility_html(report, '/tmp/secret/report.pdf')
    second = render_accessibility_html(report, '/tmp/secret/report.pdf')

    assert first == second
    assert 'file report.pdf' in first
    assert '/tmp/secret' not in first
    assert not re.search(r'\d{4}-\d{2}-\d{2}', first)
    assert not re.search(r'\d{2}:\d{2}:\d{2}', first)


def test_html_reports_an_untagged_document_without_findings():
    report = _report(
        document=_document(
            tagged=False,
            hasStructTreeRoot=False,
            hasParentTree=False,
            language=None,
            title=None,
        ),
        structure=[],
    )

    html = render_accessibility_html(report)

    assert 'No accessibility findings.' in html
    assert '<th scope="row">Tagged</th><td><span>no</span></td>' in html
    assert '<th scope="row">Structure elements</th><td class="num">0</td>' in html
    assert '<p class="muted">0 finding(s)</p>' in html


def test_html_renders_finding_details_and_severity_badges():
    report = _report(
        findings=[
            _finding(
                'warning',
                'Structure tree has no ParentTree',
                detail='The catalog has a /StructTreeRoot but no /ParentTree.',
                evidence='hasStructTreeRoot=true; hasParentTree=false',
                recommendation='Add a /ParentTree number tree.',
            )
        ]
    )

    html = render_accessibility_html(report)

    assert '<span class="badge badge-warning">warning</span>' in html
    assert '<dt>Evidence</dt><dd class="mono">hasStructTreeRoot=true; hasParentTree=false</dd>' in html
    assert '<dt>Recommendation</dt><dd>Add a /ParentTree number tree.</dd>' in html
    assert 'The catalog has a /StructTreeRoot but no /ParentTree.' in html


def test_structure_counts_are_cycle_safe():
    node = _node('Document', children=[])
    node['children'].append(node)

    counts = structure_counts({'structure': [node]})

    assert counts['elements'] == 1
    assert counts['contents'] == 0
