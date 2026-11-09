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
    ignored_region_count,
    page_geometry_changed,
    region_page_label,
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


def _minimal_result(changes, *, status='changed', old_pages=1, new_pages=1, reordered=False):
    """Contract-shaped DiffResult with hand-written changes for escaping tests."""
    paired = status not in ('added', 'removed')
    summary = {
        'pagesAdded': 1 if status == 'added' else 0,
        'pagesRemoved': 1 if status == 'removed' else 0,
        'pagesChanged': 1 if status == 'changed' else 0,
        'pagesReordered': 1 if (reordered and paired) else 0,
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
            'ignoreRegions': [],
        },
        'old': {'pages': old_pages, 'sha256': 'a' * 64},
        'new': {'pages': new_pages, 'sha256': 'b' * 64},
        'summary': summary,
        'pages': [
            {
                'oldIndex': None if status == 'added' else 1,
                'newIndex': None if status == 'removed' else (2 if reordered else 1),
                'status': status,
                'oldSize': None if status == 'added' else {'width': 612.0, 'height': 792.0},
                'newSize': None if status == 'removed' else {'width': 612.0, 'height': 792.0},
                'match': None if not paired else {'score': 0.75, 'reordered': reordered},
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
        'Pages reordered',
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


def test_render_html_page_table_shows_alignment_and_match(tmp_path):
    result = _diff(
        tmp_path,
        [_page(_draw_text('Page One')), _page(_draw_text('Page Two'))],
        [_page(_draw_text('Page Two')), _page(_draw_text('Page One'))],
    )

    report = render_html(result)

    assert '<table class="pages">' in report
    assert 'Page alignment' in report
    assert '<th>Old page</th>' in report and '<th>New page</th>' in report
    assert 'Match score' in report
    assert 'Reordered' in report
    assert '<span class="badge badge-moved">reordered</span>' in report
    # The paired page keeps its fingerprint score of 1.0 and is flagged.
    assert '1.000' in report
    assert 'Pages reordered' in report


def test_render_html_page_table_marks_one_sided_pages():
    report = render_html(_minimal_result([], status='added'))

    assert '<table class="pages">' in report
    # One-sided pages have no match: the score column shows a dash and the
    # reorder column stays empty instead of pretending they were paired.
    assert '<td class="mono">-</td>' in report
    assert 'reordered</span>' not in report


def test_format_summary_reports_reordered_pages(tmp_path):
    result = _diff(
        tmp_path,
        [_page(_draw_text('Page One')), _page(_draw_text('Page Two'))],
        [_page(_draw_text('Page Two')), _page(_draw_text('Page One'))],
    )

    summary = format_summary(result)

    assert 'pages reordered: 1' in summary
    assert 'pages reordered: 0' in format_summary(
        _diff(
            tmp_path / 'same',
            [_page(_draw_text('Page One'))],
            [_page(_draw_text('Page One'))],
        )
    )


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


# --- ignore regions ---------------------------------------------------------

IGNORE_REGION = {
    'oldPage': 1,
    'newPage': 2,
    'bbox': {'x0': 90.0, 'y0': 690.0, 'x1': 200.0, 'y1': 720.0},
}


def _with_regions(result, *regions):
    result['options']['ignoreRegions'] = list(regions)
    return result


def test_render_html_reports_ignored_regions():
    result = _with_regions(_minimal_result([_change()], reordered=True), IGNORE_REGION)

    report = render_html(result)

    assert 'Ignored regions' in report
    assert '<table class="regions">' in report
    assert '1 region(s) masked' in report
    # Summary row, page scope and MediaBox-relative box are all rendered.
    assert '<th scope="row">Ignored regions</th>' in report
    assert '(90, 690) - (200, 720)' in report
    assert '<th>Old page</th><th>New page</th><th>Bounding box</th>' in report


def test_render_html_without_ignore_regions_says_so():
    report = render_html(_minimal_result([_change()]))

    assert '0 region(s) masked' in report
    assert 'No ignore regions.' in report
    assert '<th scope="row">Ignored regions</th><td>0</td>' in report


def test_render_html_ignore_regions_stay_deterministic():
    result = _with_regions(
        _minimal_result([_change()], reordered=True),
        IGNORE_REGION,
        {'oldPage': None, 'newPage': 3, 'bbox': {'x0': 0, 'y0': 0, 'x1': 1, 'y1': 1}},
    )

    first = render_html(result)
    second = render_html(copy.deepcopy(result))

    assert first == second
    assert '2 region(s) masked' in first
    assert '<td>3</td>' in first


def test_format_summary_reports_ignored_regions():
    result = _with_regions(
        _minimal_result([_change()]),
        IGNORE_REGION,
        {'oldPage': 3, 'newPage': None, 'bbox': {'x0': 0.0, 'y0': 0.0, 'x1': 10.0, 'y1': 10.0}},
    )

    summary = format_summary(result)

    assert 'ignored regions: 2' in summary
    assert '  - old page 1 / new page 2: (90, 690) - (200, 720)' in summary
    assert '  - old page 3: (0, 0) - (10, 10)' in summary
    assert 'ignored regions: 0' in format_summary(_minimal_result([_change()]))


def test_format_summary_bounds_the_ignore_region_list():
    result = _minimal_result([_change()])
    result['options']['ignoreRegions'] = [
        dict(IGNORE_REGION, oldPage=index, newPage=index) for index in range(1, 24)
    ]

    summary = format_summary(result)

    assert 'ignored regions: 23' in summary
    assert summary.count('  - old page ') == 20
    assert '  ... 3 more region(s)' in summary


def test_ignored_region_helpers_tolerate_partial_results():
    assert ignored_region_count({}) == 0
    assert ignored_region_count({'options': {'ignoreRegions': 'nope'}}) == 0
    assert ignored_region_count({'options': {'ignoreRegions': [IGNORE_REGION, 'skip me']}}) == 1
    assert region_page_label(IGNORE_REGION) == 'old page 1 / new page 2'
    assert region_page_label({'oldPage': None, 'newPage': 4}) == 'new page 4'
    assert region_page_label({'oldPage': 4, 'newPage': None}) == 'old page 4'
    assert region_page_label({}) == 'page ?'


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
