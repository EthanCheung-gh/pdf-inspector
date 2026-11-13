"""Diff performance work: trimmed extraction, unchanged-page fast path, caps.

These tests pin the mechanisms that keep a large pair of PDFs inside a request
budget:

* ``PdfExtractor.extract_page(include_types=...)`` only builds the object lists
  the diff actually compares, and the diff passes exactly that set;
* the change list stops at ``MAX_DIFF_CHANGES`` and reports the truncation.

The page signature / unchanged-page fast path has its own suite in
``test_diff_page_signature.py``.
"""

import sys
from pathlib import Path

import pytest
from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import diff as diff_module  # noqa: E402
from diff import DiffOptions, diff_files, diff_pages  # noqa: E402
from extractor import PdfExtractor  # noqa: E402


# --- fixture builders -------------------------------------------------------


def _multi_page(path: Path, texts) -> str:
    # invariant=1 keeps the info dictionary deterministic: metadata is compared
    # by default, so a creation timestamp must not create documentChanges.
    canvas = rl_canvas.Canvas(str(path), pagesize=letter, invariant=1)
    for text in texts:
        canvas.setFont('Helvetica', 12)
        canvas.drawString(100, 700, text)
        canvas.showPage()
    canvas.save()
    return str(path)


def _object_page(path: Path, image_path: str, header_right: str = 'Header B') -> str:
    """A page with text, a rect, a line, an image and a ruled table."""
    canvas = rl_canvas.Canvas(str(path), pagesize=letter, invariant=1)
    canvas.setFont('Helvetica', 10)
    canvas.drawString(60, 760, 'Body text')
    canvas.rect(50, 650, 300, 80)
    canvas.line(200, 650, 200, 730)
    canvas.line(50, 690, 350, 690)
    canvas.drawString(60, 700, 'Header A')
    canvas.drawString(210, 700, header_right)
    canvas.drawString(210, 660, 'Row B1')
    canvas.drawImage(image_path, 400, 300, width=50, height=50)
    canvas.showPage()
    canvas.save()
    return str(path)


def _png(path: Path, color) -> str:
    Image.new('RGB', (20, 20), color).save(path)
    return str(path)


def _table_page(path: Path, header_right: str) -> str:
    canvas = rl_canvas.Canvas(str(path), pagesize=letter, invariant=1)
    canvas.rect(50, 650, 300, 80)
    canvas.line(200, 650, 200, 730)
    canvas.line(50, 690, 350, 690)
    canvas.setFont('Helvetica', 10)
    canvas.drawString(60, 700, 'Header A')
    canvas.drawString(210, 700, header_right)
    canvas.drawString(210, 660, 'Row B1')
    canvas.showPage()
    canvas.save()
    return str(path)


# --- extract_page(include_types=...) ----------------------------------------


def test_include_types_only_builds_the_requested_lists(tmp_path):
    path = _object_page(tmp_path / 'page.pdf', _png(tmp_path / 'dot.png', (255, 0, 0)))

    extractor = PdfExtractor(path)
    try:
        everything = extractor.extract_page(1)
        words_only = extractor.extract_page(1, include_types={'word'})
        chars_only = extractor.extract_page(1, include_types=['char'])
        chars_and_images = extractor.extract_page(1, include_types={'char', 'image'})
    finally:
        extractor.close()

    # The default call is unchanged: every list is populated.
    for key in ('chars', 'words', 'rects', 'lines', 'images', 'tables'):
        assert everything[key], f'default extraction must fill {key}'
    assert everything['images'][0]['content_hash']

    # Only what was asked for survives; geometry always does.
    assert words_only['words'] and not words_only['chars']
    assert words_only['rects'] == [] and words_only['lines'] == []
    assert words_only['curves'] == [] and words_only['images'] == []
    assert words_only['tables'] == []
    assert words_only['width'] == everything['width']
    assert words_only['height'] == everything['height']
    assert words_only['rotation'] == everything['rotation']
    assert words_only['boxes'] == everything['boxes']

    assert chars_only['chars'] and not chars_only['words']
    assert chars_only['tables'] == [] and chars_only['images'] == []

    # Image content hashing only happens for a caller that compares images.
    assert chars_and_images['chars']
    assert chars_and_images['images'][0]['content_hash']
    assert chars_and_images['words'] == []
    assert chars_and_images['tables'] == []


def test_include_types_skips_table_detection_and_word_grouping(tmp_path):
    path = _object_page(tmp_path / 'page.pdf', _png(tmp_path / 'dot.png', (0, 0, 255)))

    extractor = PdfExtractor(path)
    calls = {'find_tables': 0, 'extract_words': 0}
    page = extractor._pdf.pages[0]
    original_find_tables = page.find_tables
    original_extract_words = page.extract_words

    def find_tables(*args, **kwargs):
        calls['find_tables'] += 1
        return original_find_tables(*args, **kwargs)

    def extract_words(*args, **kwargs):
        calls['extract_words'] += 1
        return original_extract_words(*args, **kwargs)

    page.find_tables = find_tables
    page.extract_words = extract_words
    try:
        extractor.extract_page(1, include_types={'rect', 'line'})
    finally:
        page.find_tables = original_find_tables
        page.extract_words = original_extract_words
        extractor.close()

    assert calls == {'find_tables': 0, 'extract_words': 0}


def test_diff_passes_only_the_compared_types_to_the_extractor(tmp_path, monkeypatch):
    old = _object_page(
        tmp_path / 'old.pdf', _png(tmp_path / 'dot.png', (255, 0, 0)), 'Header B'
    )
    new = _object_page(
        tmp_path / 'new.pdf', _png(tmp_path / 'dot.png', (255, 0, 0)), 'Header C'
    )

    seen = []
    original = PdfExtractor.extract_page

    def spy(self, page_num, include_types=None):
        seen.append(None if include_types is None else set(include_types))
        return original(self, page_num, include_types=include_types)

    monkeypatch.setattr(PdfExtractor, 'extract_page', spy)

    result = diff_files(
        old, new, DiffOptions(ignore_types={'char'}, ignore_images=True)
    )

    # Every diff-pass extraction asked for exactly the compared types.
    assert seen and all(types is not None for types in seen)
    expected = {'word', 'rect', 'line', 'curve', 'table'}
    assert all(types == expected for types in seen)

    # Ignoring chars and images still reports the table and word changes.
    types_reported = {
        change['type'] for page in result['pages'] for change in page['changes']
    }
    assert 'table' in types_reported
    assert 'char' not in types_reported
    assert 'image' not in types_reported


def test_ignore_types_char_and_table_keep_the_rest_correct(tmp_path):
    old = _table_page(tmp_path / 'old.pdf', 'Header B')
    new = _table_page(tmp_path / 'new.pdf', 'Header C')

    everything = diff_files(old, new)
    without_char_table = diff_files(old, new, DiffOptions(ignore_types={'char', 'table'}))

    assert any(
        change['type'] == 'table'
        for page in everything['pages']
        for change in page['changes']
    )
    assert not any(
        change['type'] in {'char', 'table'}
        for page in without_char_table['pages']
        for change in page['changes']
    )
    # The word-level change is still reported, and the page is still changed.
    assert any(
        change['type'] == 'word' and change['kind'] == 'modified'
        for page in without_char_table['pages']
        for change in page['changes']
    )
    assert without_char_table['summary']['pagesChanged'] == 1
    assert without_char_table['summary']['changesTruncated'] is False


# --- page pairing ----------------------------------------------------------


def test_inserted_page_keeps_later_pages_paired_by_content(tmp_path):
    old = _multi_page(tmp_path / 'old.pdf', ['Page One', 'Page Two', 'Page Three'])
    new = _multi_page(
        tmp_path / 'new.pdf', ['Page One', 'Inserted', 'Page Two', 'Page Three']
    )

    result = diff_files(old, new)
    pages = result['pages']

    assert [(page['oldIndex'], page['newIndex'], page['status']) for page in pages] == [
        (1, 1, 'unchanged'),
        (None, 2, 'added'),
        (2, 3, 'unchanged'),
        (3, 4, 'unchanged'),
    ]
    # Content pairing survived the insert: each pair is the same page, so the
    # fingerprint score is exactly 1.0, and the shifted pairs are reordered.
    for page in pages:
        if page['match'] is None:
            continue
        assert page['match']['score'] == 1.0
        assert page['match']['reordered'] == (page['oldIndex'] != page['newIndex'])
        assert page['changes'] == []
    assert [page['match']['reordered'] for page in pages if page['match']] == [
        False,
        True,
        True,
    ]
    assert result['summary']['pagesAdded'] == 1
    assert result['summary']['pagesRemoved'] == 0
    assert result['summary']['pagesReordered'] == 2
    assert result['summary']['changesTruncated'] is False


def test_reordered_pages_are_paired_and_marked_reordered(tmp_path):
    # A page inserted in front shifts every later page: the pairing must follow
    # the content, not the ordinal, even though the indices no longer line up.
    old = _multi_page(tmp_path / 'old.pdf', ['Alpha', 'Bravo'])
    new = _multi_page(tmp_path / 'new.pdf', ['Bravo', 'Alpha', 'Bravo'])

    result = diff_files(old, new)

    paired = [
        (page['oldIndex'], page['newIndex'], page['match'])
        for page in result['pages']
        if page['match'] is not None
    ]
    assert paired == [
        (1, 2, {'score': 1.0, 'reordered': True}),
        (2, 3, {'score': 1.0, 'reordered': True}),
    ]
    assert result['summary']['pagesAdded'] == 1
    assert result['summary']['pagesRemoved'] == 0
    assert result['summary']['pagesChanged'] == 0


# --- change budget ----------------------------------------------------------


def test_diff_files_stops_at_the_change_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(diff_module, 'MAX_DIFF_CHANGES', 5)

    old = _multi_page(tmp_path / 'old.pdf', ['Alpha Bravo Charlie'] * 3)
    new = _multi_page(tmp_path / 'new.pdf', ['Delta Echo Foxtrot'] * 3)

    result = diff_files(old, new, DiffOptions(ignore_types={'char'}))
    changes = [change for page in result['pages'] for change in page['changes']]

    assert len(changes) == 5
    assert result['truncated'] is True
    assert result['summary']['changesTruncated'] is True
    # The first pages carry the budget, so the report is not silently empty.
    assert result['summary']['pagesChanged'] >= 1
    # Counts in the summary describe the changes that were kept.
    for kind in ('added', 'removed', 'moved', 'modified'):
        assert result['summary'][f'objects{kind.capitalize()}'] == sum(
            change['kind'] == kind for change in changes
        )


def test_normal_runs_are_not_marked_truncated(tmp_path):
    old = _multi_page(tmp_path / 'old.pdf', ['Same text'])
    new = _multi_page(tmp_path / 'new.pdf', ['Same text'])

    result = diff_files(old, new)

    assert result['truncated'] is False
    assert result['summary']['changesTruncated'] is False


def test_one_sided_pages_respect_the_budget(tmp_path, monkeypatch):
    monkeypatch.setattr(diff_module, 'MAX_DIFF_CHANGES', 2)

    old = _multi_page(
        tmp_path / 'old.pdf', ['Alpha Bravo Charlie Delta Echo', 'Only on the old side']
    )
    new = _multi_page(tmp_path / 'new.pdf', ['Alpha Bravo Charlie Delta Echo'])

    result = diff_files(old, new, DiffOptions(ignore_types={'char'}))
    removed_page = result['pages'][1]
    changes = [change for page in result['pages'] for change in page['changes']]

    assert removed_page['status'] == 'removed'
    assert removed_page['changes']
    assert len(changes) == 2
    assert all(change['kind'] == 'removed' for change in changes)
    assert result['truncated'] is True
    assert result['summary']['changesTruncated'] is True


def test_diff_pages_caps_and_still_reports_matching():
    old_page = {
        'width': 612.0,
        'height': 792.0,
        'rotation': 0,
        'words': [{'text': f'word{index}', 'x0': index * 20.0, 'y0': 700.0,
                   'x1': index * 20.0 + 15.0, 'y1': 710.0} for index in range(10)],
        'chars': [],
        'rects': [],
        'lines': [],
        'curves': [],
        'images': [],
        'tables': [],
    }
    new_page = {
        **old_page,
        'words': [{'text': f'other{index}', 'x0': index * 20.0, 'y0': 700.0,
                   'x1': index * 20.0 + 15.0, 'y1': 710.0} for index in range(10)],
    }

    uncapped = diff_pages(old_page, new_page)
    capped = diff_pages(old_page, new_page, max_changes=3)

    assert len(uncapped) == 10
    assert len(capped) == 3
    # The kept changes are the head of the uncapped, sorted list.
    assert capped == uncapped[:3]


@pytest.mark.parametrize('max_changes', [0, 1])
def test_small_budgets_report_truncation(max_changes):
    old_page = {
        'width': 612.0,
        'height': 792.0,
        'rotation': 0,
        'words': [
            {'text': 'Alpha', 'x0': 10.0, 'y0': 700.0, 'x1': 40.0, 'y1': 710.0},
            {'text': 'Bravo', 'x0': 60.0, 'y0': 700.0, 'x1': 90.0, 'y1': 710.0},
        ],
        'chars': [],
        'rects': [],
        'lines': [],
        'curves': [],
        'images': [],
        'tables': [],
    }
    new_page = {**old_page, 'words': []}

    changes, truncated = diff_module._diff_pair_changes(
        old_page, new_page, DiffOptions(), 1, 1, max_changes=max_changes
    )

    assert len(changes) == max_changes
    assert truncated is True
