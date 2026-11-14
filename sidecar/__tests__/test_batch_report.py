"""Batch HTML rendering: structure, counts, escaping and determinism.

The fixtures are hand-written ``BatchReport`` dictionaries, not audited PDFs:
the renderer is a pure function of the payload, so a literal payload states
exactly which files, counts and findings must appear in the artifact.  The
assertions are about the contract the CI artifact relies on -- one standalone
document, no scripts or external assets, no timestamps or absolute paths, every
user value escaped and byte-identical output for identical input.
"""

from __future__ import annotations

import copy
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from batch_report import (  # noqa: E402
    NO_FILES_TEXT,
    NO_FINDINGS_TEXT,
    render_batch_html,
)

# A timestamp anywhere in the report would break byte-for-byte determinism.
TIMESTAMP = re.compile(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}')

# An absolute POSIX or Windows path in a rendered cell.
ABSOLUTE_PATH = re.compile(r'^(?:/|[A-Za-z]:[\\/]|file://)')


# --- fixtures ---------------------------------------------------------------


def _finding(
    severity: str = 'info',
    *,
    category: str = 'fonts',
    title: str = 'A finding',
    page=None,
    detail: str = 'Detail text',
    evidence=None,
    recommendation=None,
) -> dict:
    return {
        'severity': severity,
        'category': category,
        'page': page,
        'title': title,
        'detail': detail,
        'evidence': evidence,
        'recommendation': recommendation,
    }


def _counts(findings) -> dict:
    counts = {'total': len(findings), 'errors': 0, 'warnings': 0, 'info': 0}
    for finding in findings:
        severity = finding['severity']
        if severity in ('error', 'warning', 'info'):
            counts[f'{severity}s' if severity != 'info' else 'info'] += 1
    return counts


def _document(pages: int = 2) -> dict:
    return {
        'pages': pages,
        'version': '1.4',
        'encrypted': False,
        'tagged': False,
        'language': None,
        'title': None,
        'author': None,
        'producer': None,
    }


def _ok_entry(
    path: str = 'a.pdf',
    *,
    findings=(),
    pages: int = 2,
    size: int = 100,
    document=None,
) -> dict:
    findings = list(findings)
    return {
        'path': path,
        'status': 'ok',
        'bytes': size,
        'document': _document(pages) if document is None else document,
        'summary': _counts(findings),
        'findings': findings,
    }


def _error_entry(path: str = 'broken.pdf', error: str = 'Cannot open PDF') -> dict:
    return {'path': path, 'status': 'error', 'bytes': 10, 'error': error}


def _batch(entries, *, root_name: str = 'docs', version: str = '0.3.3') -> dict:
    """A ``BatchReport`` whose aggregate counts follow the engine's rules."""
    audited = [entry for entry in entries if entry['status'] == 'ok']
    failed = len(entries) - len(audited)
    errors = sum(entry['summary']['errors'] for entry in audited)
    warnings = sum(entry['summary']['warnings'] for entry in audited)
    info = sum(entry['summary']['info'] for entry in audited)
    return {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': version},
        'root': {
            'name': root_name,
            'files': len(entries),
            'bytes': sum(entry['bytes'] for entry in entries),
        },
        'summary': {
            'files': len(entries),
            'audited': len(audited),
            'failed': failed,
            'findings': errors + warnings + info,
            # A failed file is one error in the aggregate.
            'errors': errors + failed,
            'warnings': warnings,
            'info': info,
        },
        'files': entries,
    }


def _render(entries, **kwargs) -> str:
    return render_batch_html(_batch(entries, **kwargs))


# --- empty and single-file reports -----------------------------------------


def test_empty_directory_renders_an_explicit_message():
    text = _render([], root_name='empty')

    assert '<title>PDF audit report - 0 files</title>' in text
    assert '<td class="mono">empty</td>' in text
    assert NO_FILES_TEXT in text
    assert 'class="file' not in text
    assert '<ol class="findings">' not in text


def test_a_single_file_uses_the_singular_title():
    text = _render([_ok_entry()])

    assert '<title>PDF audit report - 1 file</title>' in text
    assert '1 files' not in text


def test_one_clean_file_renders_document_facts_and_no_findings():
    text = _render([_ok_entry('reports/clean.pdf', pages=4)])

    # Title, root and the aggregate table.
    assert '<title>PDF audit report - 1 file</title>' in text
    assert '<td>4</td>' in text
    assert '<tr><th scope="row">Audited</th><td>1</td></tr>' in text
    assert '<tr><th scope="row">Failed</th><td>0</td></tr>' in text

    # The file table row and the per-file section.
    assert '<td class="mono">reports/clean.pdf</td>' in text
    assert '<span class="badge badge-ok">ok</span>' in text
    assert '<tr><th scope="row">Pages</th><td>4</td></tr>' in text
    assert '<tr><th scope="row">PDF version</th><td>1.4</td></tr>' in text
    assert '<tr><th scope="row">Encrypted</th><td>no</td></tr>' in text
    assert NO_FINDINGS_TEXT in text
    assert '<ol class="findings">' not in text


def test_missing_optional_document_values_render_as_a_dash():
    text = _render([_ok_entry('a.pdf')])

    assert '<tr><th scope="row">Language</th><td class="muted">&mdash;</td></tr>' in text
    assert '<tr><th scope="row">Title</th><td class="muted">&mdash;</td></tr>' in text
    assert 'None' not in text


# --- ok + error -------------------------------------------------------------


def test_ok_and_error_files_are_both_rendered_with_one_error_block():
    entries = [
        _ok_entry('a.pdf', findings=[_finding('warning', title='A warning')]),
        _error_entry('reports/broken.pdf', error='Cannot open PDF: no /Root'),
    ]

    text = _render(entries)

    assert text.count('<section id="file-') == 2
    assert text.count('<div class="error-block">') == 1
    assert '<td class="mono">reports/broken.pdf</td>' in text
    assert '<span class="badge badge-error">error</span>' in text
    assert '<p class="error">Cannot open PDF: no /Root</p>' in text
    # The error file has no document/summary/findings section.
    assert text.count('<caption>Document</caption>') == 1
    assert text.count('<caption>Findings by severity</caption>') == 1

    # Aggregate: one audited warning plus one failed file, which counts as an
    # error in both the engine and the summary's total.
    assert '<tr><th scope="row">Files</th><td>2</td></tr>' in text
    assert '<tr><th scope="row">Audited</th><td>1</td></tr>' in text
    assert '<tr><th scope="row">Failed</th><td>1</td></tr>' in text
    assert '<tr><th scope="row">Errors</th><td>1</td></tr>' in text
    assert '<tr><th scope="row">Warnings</th><td>1</td></tr>' in text
    assert '<tr><th scope="row">Total</th><td>2</td></tr>' in text


def test_file_table_lists_every_file_in_payload_order():
    entries = [
        _ok_entry('a.pdf'),
        _error_entry('b.pdf'),
        _ok_entry('c.pdf'),
    ]

    text = _render(entries)

    rows = re.findall(r'<td class="mono">([^<]+)</td>', text)
    # One row per file plus the root name in the summary table.
    assert rows == ['docs', 'a.pdf', 'b.pdf', 'c.pdf']


# --- findings ---------------------------------------------------------------


def test_findings_render_severity_page_and_all_detail_fields():
    findings = [
        _finding(
            'error',
            category='pages',
            title='Page is broken',
            page=3,
            detail='The page has no content stream.',
            evidence='obj 12 0 R',
            recommendation='Repair the page tree.',
        ),
        _finding('warning', category='fonts', title='Font is not embedded', page=1),
        _finding('info', category='metadata', title='Title is missing'),
    ]

    text = _render([_ok_entry('a.pdf', findings=findings)])

    for kind in ('error', 'warning', 'info'):
        assert f'<li class="finding finding-{kind}"' in text
        assert f'<span class="badge badge-{kind}">{kind}</span>' in text

    assert '<h4>Page is broken <span class="badge badge-error">error</span></h4>' in text
    assert '<p class="meta">pages, page 3</p>' in text
    assert '<p>The page has no content stream.</p>' in text
    assert '<dt>Evidence</dt><dd class="mono">obj 12 0 R</dd>' in text
    assert '<dt>Recommendation</dt><dd>Repair the page tree.</dd>' in text
    # A document-level finding has no page suffix.
    assert '<p class="meta">metadata</p>' in text
    assert text.count('<ol class="findings">') == 1
    assert text.count('<li class="finding ') == 3


def test_a_file_summary_is_rendered_from_the_payload_counts():
    findings = [_finding('error'), _finding('warning'), _finding('info')]

    text = _render([_ok_entry('a.pdf', findings=findings)])

    for label, count in (('Errors', 1), ('Warnings', 1), ('Info', 1), ('Total', 3)):
        assert f'<tr><th scope="row">{label}</th><td>{count}</td></tr>' in text


# --- escaping ---------------------------------------------------------------


def test_user_text_is_escaped_in_every_position():
    hostile = '<script>alert(1)</script>'
    entries = [
        _ok_entry(
            f'reports/{hostile}.pdf',
            document={
                'pages': 1,
                'version': '1.7',
                'encrypted': False,
                'tagged': True,
                'language': 'en-US',
                'title': '<b>Title & "quotes"</b>',
                'author': "O'Brien",
                'producer': '<producer>',
            },
            findings=[
                _finding(
                    'error',
                    category='<cat>',
                    title=f'{hostile} & more',
                    page=1,
                    detail='Tom & Jerry\'s "notes" <here>',
                    evidence='<img src=x onerror=alert(1)>',
                    recommendation='Do <this>',
                )
            ],
        ),
        _error_entry(f'{hostile}.pdf', error=f'damaged: {hostile} & co'),
    ]

    text = _render(entries)

    assert '<script' not in text
    assert '&lt;script&gt;alert(1)&lt;/script&gt;' in text
    assert '&lt;b&gt;Title &amp; &quot;quotes&quot;&lt;/b&gt;' in text
    assert 'Tom &amp; Jerry&#x27;s &quot;notes&quot; &lt;here&gt;' in text
    assert '&lt;img src=x onerror=alert(1)&gt;' in text
    assert 'Do &lt;this&gt;' in text
    assert 'damaged: &lt;script&gt;alert(1)&lt;/script&gt; &amp; co' in text
    assert '&lt;cat&gt;' in text


def test_control_characters_never_reach_the_document():
    entries = [
        _ok_entry('reports/\x1b[31mred.pdf', findings=[_finding('warning', title='a\nb')])
    ]

    text = _render(entries)

    assert '\x1b' not in text
    assert 'reports/[31mred.pdf' in text
    # The finding title is flattened to one line before escaping.
    assert '<h4>a b <span class="badge badge-warning">warning</span></h4>' in text


# --- standalone, deterministic artifact -------------------------------------


def test_report_is_one_standalone_script_free_document():
    text = _render([_ok_entry('a.pdf', findings=[_finding('info')]), _error_entry()])

    assert text.startswith('<!DOCTYPE html>')
    assert text.endswith('</html>\n')
    assert text.count('<html ') == 1
    assert text.count('<title>') == 1
    assert '<style>' in text and '</style>' in text
    assert text.count('<style>') == 1

    for forbidden in (
        '<script',
        '</script',
        '<link',
        '<iframe',
        'src=',
        'http://',
        'https://',
        'javascript:',
        '@import',
        'url(',
    ):
        assert forbidden not in text, forbidden


def test_report_has_no_absolute_paths_or_timestamps():
    text = _render(
        [_ok_entry('reports/a.pdf'), _error_entry('reports/b.pdf')],
        root_name='docs',
    )

    assert not TIMESTAMP.search(text)
    assert '/tmp/' not in text
    assert 'file://' not in text
    for value in re.findall(r'<td class="mono">([^<]+)</td>', text):
        assert not ABSOLUTE_PATH.match(value), value


def test_same_payload_renders_byte_identically():
    payload = _batch(
        [
            _ok_entry('a.pdf', findings=[_finding('warning', page=2)]),
            _error_entry('b.pdf'),
        ]
    )
    # A deep copy proves the renderer does not depend on object identity or on
    # the iteration order of anything it mutates.
    clone = copy.deepcopy(payload)

    assert render_batch_html(payload) == render_batch_html(payload)
    assert render_batch_html(payload) == render_batch_html(clone)


def test_a_malformed_payload_renders_an_empty_batch():
    text = render_batch_html({})

    assert '<title>PDF audit report - 0 files</title>' in text
    assert '<td class="mono">.</td>' in text  # missing root name
    assert text.count('<section id="summary">') == 1
    assert text.count('<section id="files">') == 1
    assert NO_FILES_TEXT in text
    assert 'None' not in text
