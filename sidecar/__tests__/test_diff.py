"""Object-level PDF diff engine behaviour."""

import hashlib
import json
import sys
from pathlib import Path

import pytest
from PIL import Image
from reportlab.lib.colors import Color
from reportlab.lib.pagesizes import A4, letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import diff as diff_module  # noqa: E402
from diff import (  # noqa: E402
    DIFF_TYPES,
    DiffError,
    DiffOptions,
    diff_files,
    diff_pages,
    normalize_text,
)
from extractor import PdfExtractor  # noqa: E402

CHANGE_KEYS = {
    'kind',
    'type',
    'oldPage',
    'newPage',
    'oldBBox',
    'newBBox',
    'textOld',
    'textNew',
    'details',
}


# --- fixture builders -------------------------------------------------------


def _single_page(path: Path, draw, pagesize=letter, rotation=None) -> str:
    canvas = rl_canvas.Canvas(str(path), pagesize=pagesize)
    draw(canvas)
    if rotation is not None:
        canvas.setPageRotation(rotation)
    canvas.showPage()
    canvas.save()
    return str(path)


def _multi_page(path: Path, draws, pagesize=letter) -> str:
    canvas = rl_canvas.Canvas(str(path), pagesize=pagesize)
    for draw in draws:
        draw(canvas)
        canvas.showPage()
    canvas.save()
    return str(path)


def _text(text: str, x: float = 100, y: float = 700, size: float = 12, color=None):
    def draw(canvas) -> None:
        if color is not None:
            canvas.setStrokeColor(color)
        canvas.setFont('Helvetica', size)
        canvas.drawString(x, y, text)

    return draw


def _rect(x: float, y: float, width: float = 60, height: float = 40, color=None):
    def draw(canvas) -> None:
        if color is not None:
            canvas.setStrokeColor(color)
        canvas.rect(x, y, width, height)

    return draw


def _text_pdf(path: Path, text: str, **kwargs) -> str:
    return _single_page(path, _text(text, **kwargs))


def _rectangle_pdf(path: Path, x: float, color=None) -> str:
    return _single_page(path, _rect(x, 600, color=color))


def _png(path: Path, color: tuple[int, int, int]) -> str:
    Image.new('RGB', (20, 20), color).save(path)
    return str(path)


def _image_pdf(path: Path, image_path: str, y: float = 300) -> str:
    def draw(canvas) -> None:
        canvas.drawImage(image_path, 400, y, width=50, height=50)

    return _single_page(path, draw)


def _table_pdf(path: Path, header_right: str) -> str:
    def draw(canvas) -> None:
        canvas.rect(50, 650, 300, 80)
        canvas.line(200, 650, 200, 730)
        canvas.line(50, 690, 350, 690)
        canvas.setFont('Helvetica', 10)
        canvas.drawString(60, 700, 'Header A')
        canvas.drawString(210, 700, header_right)
        canvas.drawString(210, 660, 'Row B1')

    return _single_page(path, draw)


def _page_label(text: str):
    return _text(text, y=700)


# --- assertion helpers ------------------------------------------------------


def _assert_summary_matches_pages(result):
    pages = result['pages']
    summary = result['summary']
    changes = [change for page in pages for change in page['changes']]

    assert summary['pagesAdded'] == sum(page['status'] == 'added' for page in pages)
    assert summary['pagesRemoved'] == sum(page['status'] == 'removed' for page in pages)
    assert summary['pagesChanged'] == sum(page['status'] == 'changed' for page in pages)
    for kind in ('added', 'removed', 'moved', 'modified'):
        assert summary[f'objects{kind.capitalize()}'] == sum(
            change['kind'] == kind for change in changes
        )

    for page in pages:
        if page['status'] == 'unchanged':
            assert page['changes'] == []
        if page['status'] == 'added':
            assert page['oldIndex'] is None and page['oldSize'] is None
        if page['status'] == 'removed':
            assert page['newIndex'] is None and page['newSize'] is None


def _assert_change_shape(change):
    assert set(change) == CHANGE_KEYS
    assert change['type'] in DIFF_TYPES
    assert change['kind'] in ('added', 'removed', 'moved', 'modified')
    for key in ('oldBBox', 'newBBox'):
        bbox = change[key]
        if bbox is not None:
            assert set(bbox) == {'x0', 'y0', 'x1', 'y1'}


def _changes_of(result, page_index, type_):
    return [
        change
        for change in result['pages'][page_index]['changes']
        if change['type'] == type_
    ]


# --- identical documents / schema -------------------------------------------


def test_identical_documents_report_no_changes(tmp_path):
    old = _single_page(
        tmp_path / 'old.pdf',
        lambda c: (_text('Hello World', y=700)(c), _rect(300, 500)(c)),
    )
    new = _single_page(
        tmp_path / 'new.pdf',
        lambda c: (_text('Hello World', y=700)(c), _rect(300, 500)(c)),
    )

    result = diff_files(old, new)

    assert result['schemaVersion'] == 1
    assert result['tool']['name'] == 'pdf-inspector'
    assert isinstance(result['tool']['version'], str) and result['tool']['version']
    assert result['old']['pages'] == 1 and result['new']['pages'] == 1
    assert result['old']['sha256'] == hashlib.sha256(Path(old).read_bytes()).hexdigest()
    assert result['new']['sha256'] == hashlib.sha256(Path(new).read_bytes()).hexdigest()
    assert result['summary'] == {
        'pagesAdded': 0,
        'pagesRemoved': 0,
        'pagesChanged': 0,
        'objectsAdded': 0,
        'objectsRemoved': 0,
        'objectsMoved': 0,
        'objectsModified': 0,
    }
    assert [page['status'] for page in result['pages']] == ['unchanged']
    assert result['pages'][0]['oldIndex'] == 1
    assert result['pages'][0]['newIndex'] == 1
    assert result['pages'][0]['oldSize'] == {'width': 612.0, 'height': 792.0}
    assert result['pages'][0]['changes'] == []
    _assert_summary_matches_pages(result)


def test_options_are_serialised_with_contract_keys(tmp_path):
    old = _text_pdf(tmp_path / 'old.pdf', 'Same')
    new = _text_pdf(tmp_path / 'new.pdf', 'Same')

    result = diff_files(old, new)

    assert result['options'] == {
        'positionTolerance': 1.0,
        'textTolerance': 'normalized',
        'ignoreTypes': [],
        'ignoreFonts': False,
        'ignoreColors': False,
        'ignoreImages': False,
    }


# --- text objects -----------------------------------------------------------


def test_changed_word_text_is_modified(tmp_path):
    old = _text_pdf(tmp_path / 'old.pdf', 'Alpha')
    new = _text_pdf(tmp_path / 'new.pdf', 'Beta')

    result = diff_files(old, new)
    word_changes = _changes_of(result, 0, 'word')

    assert len(word_changes) == 1
    change = word_changes[0]
    assert change['kind'] == 'modified'
    assert change['oldPage'] == 1 and change['newPage'] == 1
    assert change['textOld'] == 'Alpha'
    assert change['textNew'] == 'Beta'
    assert change['oldBBox'] is not None and change['newBBox'] is not None
    _assert_change_shape(change)
    _assert_summary_matches_pages(result)


def test_moved_word_beyond_tolerance_is_moved(tmp_path):
    old = _text_pdf(tmp_path / 'old.pdf', 'Widget', x=100)
    new = _text_pdf(tmp_path / 'new.pdf', 'Widget', x=300)

    result = diff_files(old, new)
    word_changes = _changes_of(result, 0, 'word')

    assert [change['kind'] for change in word_changes] == ['moved']
    assert word_changes[0]['textOld'] == word_changes[0]['textNew'] == 'Widget'
    assert word_changes[0]['oldBBox']['x0'] != word_changes[0]['newBBox']['x0']
    _assert_summary_matches_pages(result)


def test_position_tolerance_controls_moved_detection(tmp_path):
    old = _text_pdf(tmp_path / 'old.pdf', 'Widget', x=100)
    new = _text_pdf(tmp_path / 'new.pdf', 'Widget', x=102)

    default_result = diff_files(old, new)
    assert [change['kind'] for change in _changes_of(default_result, 0, 'word')] == ['moved']

    relaxed = diff_files(old, new, DiffOptions(position_tolerance=5.0))
    assert relaxed['summary']['pagesChanged'] == 0
    assert relaxed['pages'][0]['status'] == 'unchanged'
    assert relaxed['pages'][0]['changes'] == []


def test_word_font_size_change_is_modified(tmp_path):
    old = _text_pdf(tmp_path / 'old.pdf', 'Sized', size=12)
    new = _text_pdf(tmp_path / 'new.pdf', 'Sized', size=20)

    result = diff_files(old, new)
    word_changes = _changes_of(result, 0, 'word')

    assert len(word_changes) == 1
    change = word_changes[0]
    assert change['kind'] == 'modified'
    assert change['details']['fontSize'] == {'old': 12.0, 'new': 20.0}
    _assert_summary_matches_pages(result)


def test_char_colour_change_is_modified(tmp_path):
    old = _text_pdf(tmp_path / 'old.pdf', 'Colour')
    new = _text_pdf(tmp_path / 'new.pdf', 'Colour', color=Color(1, 0, 0))

    result = diff_files(old, new)
    char_changes = _changes_of(result, 0, 'char')

    assert char_changes
    assert all(change['kind'] == 'modified' for change in char_changes)
    assert all('color' in change['details'] for change in char_changes)
    assert char_changes[0]['details']['color']['old'] == '(0,)'
    assert char_changes[0]['details']['color']['new'] == '(1.0, 0.0, 0.0)'


def test_word_font_name_change_is_modified(tmp_path):
    old = _single_page(tmp_path / 'old.pdf', _text('Fonted', size=12))
    new = _single_page(
        tmp_path / 'new.pdf',
        lambda c: (c.setFont('Courier', 12), c.drawString(100, 700, 'Fonted')),
    )

    result = diff_files(old, new)
    word_changes = _changes_of(result, 0, 'word')

    assert [change['kind'] for change in word_changes] == ['modified']
    assert word_changes[0]['details']['fontName'] == {
        'old': 'Helvetica',
        'new': 'Courier',
    }


def test_rect_stroke_width_change_is_modified(tmp_path):
    def draw(width):
        def inner(canvas):
            canvas.setLineWidth(width)
            canvas.rect(100, 600, 60, 40)

        return inner

    old = _single_page(tmp_path / 'old.pdf', draw(1))
    new = _single_page(tmp_path / 'new.pdf', draw(4))

    result = diff_files(old, new)
    rect_changes = _changes_of(result, 0, 'rect')

    assert [change['kind'] for change in rect_changes] == ['modified']
    assert rect_changes[0]['details']['strokeWidth'] == {'old': 1.0, 'new': 4.0}


def test_curve_point_change_is_modified(tmp_path):
    def curve(end_x):
        def draw(canvas):
            canvas.bezier(100, 100, 150, 200, 200, 100, end_x, 100)

        return draw

    # pdfplumber exposes a curve's endpoint path as ``points`` (not its Bézier
    # control points), so the endpoint is what the diff can compare; the
    # tolerance keeps the two bboxes paired as one modified object.
    old = _single_page(tmp_path / 'old.pdf', curve(250))
    new = _single_page(tmp_path / 'new.pdf', curve(254))

    result = diff_files(old, new, DiffOptions(position_tolerance=3.0))
    curve_changes = _changes_of(result, 0, 'curve')

    assert [change['kind'] for change in curve_changes] == ['modified']
    assert 'points' in curve_changes[0]['details']


def test_case_insensitive_tolerance_ignores_case_only_changes(tmp_path):
    old = _text_pdf(tmp_path / 'old.pdf', 'Hello')
    new = _text_pdf(tmp_path / 'new.pdf', 'HELLO')

    default_result = diff_files(old, new)
    assert [change['kind'] for change in _changes_of(default_result, 0, 'word')] == [
        'modified'
    ]

    insensitive = diff_files(old, new, DiffOptions(text_tolerance='case-insensitive'))
    assert insensitive['summary']['pagesChanged'] == 0
    assert insensitive['pages'][0]['changes'] == []


@pytest.mark.parametrize(
    'raw, mode, expected',
    [
        ('  Hello \n  World ', 'exact', '  Hello \n  World '),
        ('  Hello \n  World ', 'normalized', 'Hello World'),
        ('  Hello \n  World ', 'case-insensitive', 'hello world'),
        ('', 'normalized', ''),
    ],
)
def test_normalize_text_modes(raw, mode, expected):
    assert normalize_text(raw, mode) == expected


# --- rectangles, added/removed objects --------------------------------------


def test_moved_rect_is_moved(tmp_path):
    old = _rectangle_pdf(tmp_path / 'old.pdf', 100)
    new = _rectangle_pdf(tmp_path / 'new.pdf', 300)

    result = diff_files(old, new)
    rect_changes = _changes_of(result, 0, 'rect')

    assert [change['kind'] for change in rect_changes] == ['moved']
    assert rect_changes[0]['textOld'] is None and rect_changes[0]['textNew'] is None
    assert rect_changes[0]['oldBBox']['x0'] == 100
    assert rect_changes[0]['newBBox']['x0'] == 300
    _assert_summary_matches_pages(result)


def test_rect_colour_change_is_modified_and_honours_ignore_colors(tmp_path):
    old = _rectangle_pdf(tmp_path / 'old.pdf', 100, color=Color(1, 0, 0))
    new = _rectangle_pdf(tmp_path / 'new.pdf', 100, color=Color(0, 1, 0))

    result = diff_files(old, new)
    rect_changes = _changes_of(result, 0, 'rect')
    assert [change['kind'] for change in rect_changes] == ['modified']
    assert 'color' in rect_changes[0]['details']

    ignored = diff_files(old, new, DiffOptions(ignore_colors=True))
    assert ignored['pages'][0]['changes'] == []
    assert ignored['summary']['pagesChanged'] == 0


def test_added_and_removed_objects(tmp_path):
    old = _text_pdf(tmp_path / 'old.pdf', 'Gone', x=100)
    new = _text_pdf(tmp_path / 'new.pdf', 'Fresh', x=400)

    result = diff_files(old, new)
    word_changes = _changes_of(result, 0, 'word')
    kinds = sorted(change['kind'] for change in word_changes)

    assert kinds == ['added', 'removed']
    removed = next(change for change in word_changes if change['kind'] == 'removed')
    added = next(change for change in word_changes if change['kind'] == 'added')
    assert removed['textOld'] == 'Gone' and removed['oldPage'] == 1
    assert removed['newPage'] is None and removed['newBBox'] is None
    assert added['textNew'] == 'Fresh' and added['newPage'] == 1
    assert added['oldPage'] is None and added['oldBBox'] is None
    _assert_summary_matches_pages(result)


# --- images -----------------------------------------------------------------


def test_extracted_images_carry_content_hash(tmp_path):
    image = _png(tmp_path / 'red.png', (255, 0, 0))
    path = _image_pdf(tmp_path / 'image.pdf', image)

    extractor = PdfExtractor(path)
    try:
        page = extractor.extract_page(1)
    finally:
        extractor.close()

    content_hash = page['images'][0]['content_hash']
    assert isinstance(content_hash, str) and len(content_hash) == 64
    assert all(character in '0123456789abcdef' for character in content_hash)


def test_changed_image_content_is_modified(tmp_path):
    red = _png(tmp_path / 'red.png', (255, 0, 0))
    blue = _png(tmp_path / 'blue.png', (0, 0, 255))
    old = _image_pdf(tmp_path / 'old.pdf', red)
    new = _image_pdf(tmp_path / 'new.pdf', blue)

    result = diff_files(old, new)
    image_changes = _changes_of(result, 0, 'image')

    assert [change['kind'] for change in image_changes] == ['modified']
    hashes = image_changes[0]['details']['contentHash']
    assert hashes['old'] != hashes['new']
    assert len(hashes['old']) == 64 and len(hashes['new']) == 64
    _assert_summary_matches_pages(result)


def test_moved_image_is_moved(tmp_path):
    red = _png(tmp_path / 'red.png', (255, 0, 0))
    old = _image_pdf(tmp_path / 'old.pdf', red, y=300)
    new = _image_pdf(tmp_path / 'new.pdf', red, y=500)

    result = diff_files(old, new)
    image_changes = _changes_of(result, 0, 'image')

    assert [change['kind'] for change in image_changes] == ['moved']


# --- tables -----------------------------------------------------------------


def test_table_cell_change_reports_cell_changes(tmp_path):
    old = _table_pdf(tmp_path / 'old.pdf', 'Header B')
    new = _table_pdf(tmp_path / 'new.pdf', 'Header C')

    result = diff_files(old, new)
    table_changes = _changes_of(result, 0, 'table')

    assert [change['kind'] for change in table_changes] == ['modified']
    assert table_changes[0]['details']['cellChanges'] == [
        {'row': 0, 'col': 1, 'old': 'Header B', 'new': 'Header C'}
    ]
    _assert_summary_matches_pages(result)


# --- page pairing -----------------------------------------------------------


def test_pair_pages_aligns_inserts_deletes_and_replaces():
    assert diff_module.pair_pages(['a', 'b'], ['x', 'a', 'b']) == [
        (None, 1),
        (1, 2),
        (2, 3),
    ]
    assert diff_module.pair_pages(['a', 'b'], ['a']) == [(1, 1), (2, None)]
    assert diff_module.pair_pages(['a', 'b'], ['c', 'd']) == [(1, 1), (2, 2)]
    assert diff_module.pair_pages(['a'], ['a', 'b', 'c']) == [
        (1, 1),
        (None, 2),
        (None, 3),
    ]


def test_inserted_page_is_added_without_shifting_later_pairs(tmp_path):
    old = _multi_page(
        tmp_path / 'old.pdf', [_page_label('Page One'), _page_label('Page Two')]
    )
    new = _multi_page(
        tmp_path / 'new.pdf',
        [_page_label('Inserted'), _page_label('Page One'), _page_label('Page Two')],
    )

    result = diff_files(old, new)

    assert result['old']['pages'] == 2
    assert result['new']['pages'] == 3
    assert result['summary']['pagesAdded'] == 1
    assert result['summary']['pagesRemoved'] == 0
    assert [(page['oldIndex'], page['newIndex'], page['status']) for page in result['pages']] == [
        (None, 1, 'added'),
        (1, 2, 'unchanged'),
        (2, 3, 'unchanged'),
    ]
    _assert_summary_matches_pages(result)


def test_removed_page_is_reported_removed(tmp_path):
    old = _multi_page(
        tmp_path / 'old.pdf', [_page_label('Page One'), _page_label('Page Two')]
    )
    new = _multi_page(tmp_path / 'new.pdf', [_page_label('Page One')])

    result = diff_files(old, new)

    assert result['summary']['pagesRemoved'] == 1
    assert [(page['oldIndex'], page['newIndex'], page['status']) for page in result['pages']] == [
        (1, 1, 'unchanged'),
        (2, None, 'removed'),
    ]
    _assert_summary_matches_pages(result)


def test_page_size_change_marks_page_changed(tmp_path):
    old = _single_page(tmp_path / 'old.pdf', _text('Resize'), pagesize=letter)
    new = _single_page(tmp_path / 'new.pdf', _text('Resize'), pagesize=A4)

    result = diff_files(old, new)
    page = result['pages'][0]

    assert page['status'] == 'changed'
    geometry = [change for change in page['changes'] if 'pageGeometry' in change['details']]
    assert len(geometry) == 1
    assert geometry[0]['details']['pageGeometry']['size']['old'] == {
        'width': 612.0,
        'height': 792.0,
    }
    assert geometry[0]['details']['pageGeometry']['size']['new'] == {
        'width': 595.2756,
        'height': 841.8898,
    }
    _assert_summary_matches_pages(result)


def test_page_rotation_change_marks_page_changed(tmp_path):
    old = _single_page(tmp_path / 'old.pdf', _text('Rotate'))
    new = _single_page(tmp_path / 'new.pdf', _text('Rotate'), rotation=90)

    result = diff_files(old, new)
    geometry = [
        change
        for change in result['pages'][0]['changes']
        if 'pageGeometry' in change['details']
    ]

    assert result['pages'][0]['status'] == 'changed'
    assert len(geometry) == 1
    assert geometry[0]['details']['pageGeometry']['rotation'] == {'old': 0, 'new': 90}


# --- ignore options ---------------------------------------------------------


def test_ignore_types_skips_that_object_type(tmp_path):
    old = _text_pdf(tmp_path / 'old.pdf', 'Alpha')
    new = _text_pdf(tmp_path / 'new.pdf', 'Beta')

    result = diff_files(old, new, DiffOptions(ignore_types={'word', 'char'}))

    assert result['pages'][0]['changes'] == []
    assert result['pages'][0]['status'] == 'unchanged'
    assert result['options']['ignoreTypes'] == ['word', 'char']


def test_ignore_fonts_ignores_font_size_changes(tmp_path):
    old = _text_pdf(tmp_path / 'old.pdf', 'Sized', size=12)
    new = _text_pdf(tmp_path / 'new.pdf', 'Sized', size=20)

    result = diff_files(old, new, DiffOptions(ignore_fonts=True))

    assert result['pages'][0]['changes'] == []
    assert result['pages'][0]['status'] == 'unchanged'


def test_ignore_images_skips_image_changes(tmp_path):
    red = _png(tmp_path / 'red.png', (255, 0, 0))
    blue = _png(tmp_path / 'blue.png', (0, 0, 255))
    old = _image_pdf(tmp_path / 'old.pdf', red)
    new = _image_pdf(tmp_path / 'new.pdf', blue)

    result = diff_files(old, new, DiffOptions(ignore_images=True))

    assert result['pages'][0]['changes'] == []
    assert result['pages'][0]['status'] == 'unchanged'
    assert result['options']['ignoreImages'] is True


def test_invalid_options_are_rejected():
    with pytest.raises(ValueError, match='text_tolerance'):
        DiffOptions(text_tolerance='fuzzy')
    with pytest.raises(ValueError, match='Unknown ignore type'):
        DiffOptions(ignore_types={'pixel'})
    with pytest.raises(ValueError, match='position_tolerance'):
        DiffOptions(position_tolerance=-1)


# --- determinism, unicode, errors ------------------------------------------


def test_unicode_text_change_is_detected(tmp_path):
    old = _text_pdf(tmp_path / 'old.pdf', 'Grüße')
    new = _text_pdf(tmp_path / 'new.pdf', 'Grüße2')

    result = diff_files(old, new)
    word_changes = _changes_of(result, 0, 'word')

    assert word_changes
    assert any(
        change['textOld'] == 'Grüße' and change['textNew'] == 'Grüße2'
        for change in word_changes
    )
    json.dumps(result)


def test_repeated_runs_produce_identical_json(tmp_path):
    def old_page(canvas):
        _text('Alpha', y=700)(canvas)
        _rect(100, 500)(canvas)

    def new_page(canvas):
        _text('Beta', y=700, x=120)(canvas)
        _rect(140, 500)(canvas)

    old = _single_page(tmp_path / 'old.pdf', old_page)
    new = _single_page(tmp_path / 'new.pdf', new_page)

    first = diff_files(old, new)
    second = diff_files(old, new)

    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    assert first['pages'] == second['pages']


def test_malformed_pdf_raises_clear_error(tmp_path):
    good = _text_pdf(tmp_path / 'good.pdf', 'Hello')
    broken = tmp_path / 'broken.pdf'
    broken.write_bytes(b'%PDF-1.4\nthis is not a pdf at all\n')

    with pytest.raises(DiffError) as excinfo:
        diff_files(good, str(broken))

    message = str(excinfo.value)
    assert 'PDF' in message
    assert 'Traceback' not in message
    assert isinstance(excinfo.value, DiffError)


def test_missing_file_raises_clear_error(tmp_path):
    good = _text_pdf(tmp_path / 'good.pdf', 'Hello')

    with pytest.raises(DiffError, match='old PDF'):
        diff_files(str(tmp_path / 'missing.pdf'), good)


def test_extractors_are_closed_on_success_and_error(tmp_path, monkeypatch):
    good = _text_pdf(tmp_path / 'good.pdf', 'Hello')
    other = _text_pdf(tmp_path / 'other.pdf', 'Hello')
    broken = tmp_path / 'broken.pdf'
    broken.write_bytes(b'%PDF-1.4\nnot really a pdf\n')

    created = []

    class SpyExtractor:
        def __init__(self, path):
            self._inner = PdfExtractor(path)
            self.closed = False
            created.append(self)

        @property
        def _pdf(self):
            return self._inner._pdf

        def extract_page(self, page_num):
            return self._inner.extract_page(page_num)

        def close(self):
            self.closed = True
            self._inner.close()

    monkeypatch.setattr(diff_module, 'PdfExtractor', SpyExtractor)

    diff_files(good, other)
    assert created and all(extractor.closed for extractor in created)

    created.clear()
    with pytest.raises(DiffError):
        diff_files(good, str(broken))
    assert created and all(extractor.closed for extractor in created)


# --- exported page helper ---------------------------------------------------


def test_diff_pages_helper_accepts_extracted_pages(tmp_path):
    old_extractor = PdfExtractor(_text_pdf(tmp_path / 'old.pdf', 'Alpha'))
    new_extractor = PdfExtractor(_text_pdf(tmp_path / 'new.pdf', 'Beta'))
    try:
        changes = diff_pages(
            old_extractor.extract_page(1),
            new_extractor.extract_page(1),
            DiffOptions(),
        )
    finally:
        old_extractor.close()
        new_extractor.close()

    assert any(
        change['type'] == 'word' and change['kind'] == 'modified' for change in changes
    )
    for change in changes:
        if change['oldPage'] is not None:
            assert change['oldPage'] == 1
        if change['newPage'] is not None:
            assert change['newPage'] == 1
