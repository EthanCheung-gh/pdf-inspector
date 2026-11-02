"""HTML/text report rendering for the diff CLI: escaping, layout, determinism."""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

from reportlab.lib.pagesizes import A4, letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from diff import diff_files  # noqa: E402
from report import (  # noqa: E402
    NO_CHANGES_TEXT,
    change_title,
    format_summary,
    page_geometry_changed,
    render_html,
)


# --- fixture builders -------------------------------------------------------


def _draw_text(text: str, x: float = 100, y: float = 700):
    def draw(canvas) -> None:
        canvas.setFont('Helvetica', 12)
        canvas.drawString(x, y, text)

    return draw


def _draw_rect(x: float, y: float = 500):
    def draw(canvas) -> None:
        canvas.rect(x, y, 60, 40)

    return draw


def _page(*draws):
    def draw(canvas) -> None:
        for item in draws:
            item(canvas)

    return draw


def _pdf(path: Path, *pages, pagesize=letter) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas = rl_canvas.Canvas(str(path), pagesize=pagesize)
    for draw in pages:
        draw(canvas)
        canvas.showPage()
    canvas.save()
    return str(path)


def _diff(tmp_path, old_pages, new_pages, old_page_size=letter, new_page_size=letter):
    old = _pdf(tmp_path / 'old.pdf', *old_pages, pagesize=old_page_size)
    new = _pdf(tmp_path / 'new.pdf', *new_pages, pagesize=new_page_size)
    return diff_files(old, new)


def _minimal_result(changes, *, status='changed', old_pages=1, new_pages=1):
    """Contract-shaped DiffResult with hand-written changes for escaping tests."""
    summary = {
        'pagesAdded': 1 if status == 'added' else 0,
        'pagesRemoved': 1 if status == 'removed' else 0,
        'pagesChanged': 1 if status == 'changed' else 0,
        'objectsAdded': sum(change['kind'] == 'added' for change in changes),
        'objectsRemoved': sum(change['kind'] == 'removed' for change in changes),
        'objectsMoved': sum(change['kind'] == 'moved' for change in changes),
        'objectsModified': sum(change['kind'] == 'modified' for change in changes),
    }
    return {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': '9.9.9'},
        'options': {
            'positionTolerance': 1.0,
            'textTolerance': 'normalized',
            'ignoreTypes': [],
            'ignoreFonts': False,
            'ignoreColors': False,
            'ignoreImages': False,
        },
        'old': {'pages': old_pages, 'sha256': 'a' * 64},
        'new': {'pages': new_pages, 'sha256': 'b' * 64},
        'summary': summary,
        'pages': [
            {
                'oldIndex': 1,
                'newIndex': 1,
                'status': status,
                'oldSize': {'width': 612.0, 'height': 792.0},
                'newSize': {'width': 612.0, 'height': 792.0},
                'changes': changes,
            }
        ],
    }


def _change(**overrides):
    change = {
        'kind': 'modified',
        'type': 'word',
        'oldPage': 1,
        'newPage': 1,
        'oldBBox': {'x0': 100.0, 'y0': 697.5, 'x1': 140.0, 'y1': 709.5},
        'newBBox': {'x0': 100.0, 'y0': 697.5, 'x1': 150.0, 'y1': 709.5},
        'textOld': 'Old',
        'textNew': 'New',
        'details': {},
    }
    change.update(overrides)
    return change


# --- escaping ---------------------------------------------------------------


def test_render_html_escapes_pdf_text(tmp_path):
    result = _diff(
        tmp_path,
        [_page(_draw_text('<script>alert("old")</script>'))],
        [_page(_draw_text('<script>alert("new")</script>'))],
    )

    report = render_html(result)

    assert '<script' not in report
    assert '&lt;script&gt;' in report
    assert '&quot;old&quot;' in report
    assert '&lt;script&gt;alert(&quot;new&quot;)&lt;/script&gt;' in report


def test_render_html_escapes_details_and_cell_changes():
    change = _change(
        textOld='<img src=x onerror=alert(1)>',
        details={
            'fontName': {'old': '<b onmouseover="alert(1)">', 'new': 'Helvetica'},
            'cellChanges': [
                {
                    'row': 0,
                    'col': 1,
                    'old': '<script>danger</script>',
                    'new': 'safe & sound',
                }
            ],
        },
    )
    report = render_html(_minimal_result([change]))

    assert '<script' not in report
    assert '<b onmouseover' not in report
    assert '&lt;b onmouseover=&quot;alert(1)&quot;&gt;' in report
    assert '&lt;script&gt;danger&lt;/script&gt;' in report
    assert 'safe &amp; sound' in report
    assert '&lt;img src=x onerror=alert(1)&gt;' in report


def test_render_html_is_self_contained(tmp_path):
    result = _diff(
        tmp_path,
        [_page(_draw_text('Alpha'), _draw_rect(300))],
        [_page(_draw_text('Beta'), _draw_rect(320))],
    )

    report = render_html(result)

    assert report.startswith('<!DOCTYPE html>')
    assert '<style>' in report
    for forbidden in ('<script', '<link', ' src=', ' href=', '@import', 'url(', 'http://', 'https://'):
        assert forbidden not in report
    assert report.rstrip().endswith('</html>')


# --- summary, options, page sections ----------------------------------------


def test_render_html_contains_summary_options_and_change_tables(tmp_path):
    result = _diff(
        tmp_path,
        [_page(_draw_text('Alpha'))],
        [_page(_draw_text('Beta'))],
    )

    report = render_html(result)

    assert 'PDF diff report' in report
    assert f'pdf-inspector {result["tool"]["version"]}' in report
    assert 'Summary' in report
    for label in (
        'Pages added',
        'Pages removed',
        'Pages changed',
        'Objects added',
        'Objects removed',
        'Objects moved',
        'Objects modified',
        'Total object changes',
    ):
        assert label in report
    assert 'Diff options' in report
    assert 'Position tolerance' in report
    assert 'normalized' in report
    assert 'Object changes' in report
    assert '<table class="changes">' in report
    assert '<code>Alpha</code>' in report and '<code>Beta</code>' in report
    assert 'Changed' in report


def test_render_html_marks_added_and_removed_pages(tmp_path):
    added = _diff(
        tmp_path / 'added',
        [_page(_draw_text('Page One'))],
        [_page(_draw_text('Page One')), _page(_draw_text('Extra'))],
        new_page_size=letter,
    )
    report = render_html(added)
    assert 'Page added' in report
    assert 'only in new document' in report

    removed = _diff(
        tmp_path / 'removed',
        [_page(_draw_text('Page One')), _page(_draw_text('Extra'))],
        [_page(_draw_text('Page One'))],
    )
    report = render_html(removed)
    assert 'Page removed' in report
    assert 'only in old document' in report


def test_render_html_page_geometry_is_readable(tmp_path):
    result = _diff(
        tmp_path,
        [_page(_draw_text('Resized'))],
        [_page(_draw_text('Resized'))],
        old_page_size=letter,
        new_page_size=A4,
    )

    report = render_html(result)

    assert 'Page size:' in report
    assert '612 x 792 pt' in report
    assert '595.28 x 841.89 pt' in report

    rotated = _diff(
        tmp_path / 'rotated',
        [_page(_draw_text('Rotate'))],
        [_page(_draw_text('Rotate'))],
    )
    # diff_files can only see rotation if it is part of the extracted page, so
    # assert the renderer's rotation branch through a synthetic result instead.
    geometry_change = _change(
        type='rect',
        textOld=None,
        textNew=None,
        details={
            'pageGeometry': {
                'size': {
                    'old': {'width': 612.0, 'height': 792.0},
                    'new': {'width': 842.0, 'height': 595.0},
                },
                'rotation': {'old': 0, 'new': 90},
            }
        },
    )
    rotated_report = render_html(_minimal_result([geometry_change]))
    assert 'Rotation:' in rotated_report
    assert '90 deg' in rotated_report
    assert '842 x 595 pt' in rotated_report
    assert rotated['pages'][0]['status'] == 'unchanged'


def test_render_html_unchanged_page_shows_empty_state(tmp_path):
    result = _diff(
        tmp_path,
        [_page(_draw_text('Same'))],
        [_page(_draw_text('Same'))],
    )

    report = render_html(result)

    assert 'Unchanged' in report
    assert 'No object changes.' in report
    assert 'Pages changed' in report
    assert 'Total object changes' in report


# --- determinism ------------------------------------------------------------


def test_render_html_is_deterministic(tmp_path):
    old = _pdf(tmp_path / 'old.pdf', _page(_draw_text('Alpha'), _draw_rect(300)))
    new = _pdf(tmp_path / 'new.pdf', _page(_draw_text('Beta'), _draw_rect(320)))

    first = diff_files(old, new)
    second = diff_files(old, new)

    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    assert render_html(first) == render_html(second)
    assert render_html(first) == render_html(copy.deepcopy(first))


def test_render_html_has_no_timestamp_noise(tmp_path):
    result = _diff(
        tmp_path,
        [_page(_draw_text('Alpha'))],
        [_page(_draw_text('Beta'))],
    )
    report = render_html(result)

    assert not re.search(r'\d{4}-\d{2}-\d{2}', report)
    assert not re.search(r'\d{2}:\d{2}:\d{2}', report)
    assert 'Generated' in report


# --- plain-text summary -----------------------------------------------------


def test_format_summary_includes_counts_and_top_changes(tmp_path):
    result = _diff(
        tmp_path,
        [_page(_draw_text('Alpha'))],
        [_page(_draw_text('Beta'))],
    )

    summary = format_summary(result, old_label='old.pdf', new_label='new.pdf')

    assert summary.startswith('pdf-inspector ')
    assert 'old: old.pdf - 1 page(s), sha256 ' in summary
    assert 'new: new.pdf - 1 page(s), sha256 ' in summary
    assert 'pages: 1 -> 1 (0 added, 0 removed, 1 changed, 0 unchanged)' in summary
    assert 'objects: ' in summary
    assert 'word modified "Alpha" -> "Beta"' in summary
    assert 'changes: ' in summary
    assert summary.endswith('\n')


def test_format_summary_no_changes(tmp_path):
    result = _diff(
        tmp_path,
        [_page(_draw_text('Same'))],
        [_page(_draw_text('Same'))],
    )

    summary = format_summary(result)

    assert NO_CHANGES_TEXT in summary
    assert 'documents match' in summary
    assert '0 added, 0 removed, 0 moved, 0 modified' in summary


def test_format_summary_truncates_top_changes():
    # The page entry has no "changes" ordering guarantee of its own; the summary
    # reports them in the (already deterministic) list order.
    changes = [
        _change(textOld='a', textNew='b'),
        _change(textOld='c', textNew='d'),
        _change(textOld='e', textNew='f'),
    ]
    result = _minimal_result(changes, old_pages=1, new_pages=1)

    summary = format_summary(result, max_changes=2)

    assert 'changes: 3 total, showing 2' in summary
    assert '1 more change(s)' in summary
    assert summary.count('word modified') == 2
    assert format_summary(result, max_changes=0).count('word modified') == 0


def test_change_title_variants():
    assert change_title(_change()) == 'word modified "Old" -> "New"'
    assert (
        change_title(_change(kind='added', oldPage=None, textOld=None, textNew='Fresh'))
        == 'word added "Fresh"'
    )
    assert (
        change_title(_change(kind='removed', newPage=None, textNew=None, textOld='Gone'))
        == 'word removed "Gone"'
    )
    assert (
        change_title(
            _change(kind='moved', textOld=None, textNew=None, type='rect')
        )
        == 'rect moved'
    )


def test_page_geometry_changed_helper(tmp_path):
    geometry = _diff(
        tmp_path / 'geometry',
        [_page(_draw_text('Resized'))],
        [_page(_draw_text('Resized'))],
        old_page_size=letter,
        new_page_size=A4,
    )
    text_change = _diff(
        tmp_path / 'text',
        [_page(_draw_text('Alpha'))],
        [_page(_draw_text('Beta'))],
    )

    assert page_geometry_changed(geometry) is True
    assert page_geometry_changed(text_change) is False
