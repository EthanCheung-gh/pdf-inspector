"""Page signatures and the unchanged-page fast path.

A page signature is a SHA-256 over a page's geometry, content streams and
resources, computed from pdfminer objects only.  Two pages with equal signatures
are the same page, so ``diff_files`` reports them unchanged without ever running
a pdfplumber layout or an object extraction.  These tests pin

* what the signature covers (text, fonts, images, geometry, tables);
* that unchanged pages cause zero ``PdfExtractor.extract_page`` calls;
* that only the changed page of a pair is extracted;
* that reordering/inserting/deleting pages still aligns by content.
"""

import sys
from pathlib import Path
from types import SimpleNamespace

import pdfplumber.page
import pytest
from PIL import Image
from reportlab.lib.pagesizes import A4, letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import diff as diff_module  # noqa: E402
from diff import DiffOptions, diff_files  # noqa: E402
from extractor import PdfExtractor  # noqa: E402


# --- fixture builders -------------------------------------------------------


def _multi_page(path: Path, draws, pagesize=letter) -> str:
    """Build a PDF from one draw callback per page.

    ``invariant=1`` pins the info dict, so two fixtures built at different times
    never differ by a CreationDate/ModDate timestamp (the engine compares
    document metadata as of R2).
    """
    canvas = rl_canvas.Canvas(str(path), pagesize=pagesize, invariant=1)
    for draw in draws:
        draw(canvas)
        canvas.showPage()
    canvas.save()
    return str(path)


def _text(text: str, x: float = 100, y: float = 700, font: str = 'Helvetica'):
    def draw(canvas) -> None:
        # Set the font per page: a font set once before the loop makes the first
        # page's content stream differ from the same text drawn later.
        canvas.setFont(font, 12)
        canvas.drawString(x, y, text)

    return draw


def _image(image_path: str, y: float = 300):
    def draw(canvas) -> None:
        canvas.drawImage(image_path, 400, y, width=50, height=50)

    return draw


def _table(header_right: str, y: float = 700):
    def draw(canvas) -> None:
        canvas.rect(50, 650, 300, 80)
        canvas.line(200, 650, 200, 730)
        canvas.line(50, 690, 350, 690)
        canvas.setFont('Helvetica', 10)
        canvas.drawString(60, 700, 'Header A')
        canvas.drawString(210, y, header_right)
        canvas.drawString(210, 660, 'Row B1')

    return draw


def _png(path: Path, color) -> str:
    Image.new('RGB', (20, 20), color).save(path)
    return str(path)


def _signature(path: str, page_num: int = 1, label: str = 'old'):
    extractor = PdfExtractor(path)
    try:
        return diff_module._page_signature(extractor, page_num, Path(path), label)
    finally:
        extractor.close()


def _pages(result):
    return [
        (page['oldIndex'], page['newIndex'], page['status'], page['match'])
        for page in result['pages']
    ]


@pytest.fixture()
def extracted(monkeypatch):
    """Record every ``PdfExtractor.extract_page`` call made by a diff."""
    calls: list[int] = []
    original = PdfExtractor.extract_page

    def spy(self, page_num, include_types=None):
        calls.append(page_num)
        return original(self, page_num, include_types=include_types)

    monkeypatch.setattr(PdfExtractor, 'extract_page', spy)
    return calls


# --- what the signature covers ---------------------------------------------


def test_identical_pages_have_equal_signatures(tmp_path):
    first = _multi_page(tmp_path / 'first.pdf', [_text('Hello world')])
    second = _multi_page(tmp_path / 'second.pdf', [_text('Hello world')])

    signature, width, height = _signature(first)

    assert signature == _signature(second)[0]
    assert len(signature) == 64
    assert (width, height) == (612.0, 792.0)


def test_text_change_changes_the_signature(tmp_path):
    base = _multi_page(tmp_path / 'base.pdf', [_text('Hello world')])
    edited = _multi_page(tmp_path / 'edited.pdf', [_text('Hello World')])
    moved = _multi_page(tmp_path / 'moved.pdf', [_text('Hello world', x=140)])

    our = _signature(base)[0]

    assert _signature(edited)[0] != our
    # A pure move is a change too: the object diff has to report it.
    assert _signature(moved)[0] != our


def test_font_change_changes_the_signature(tmp_path):
    base = _multi_page(tmp_path / 'base.pdf', [_text('Hello world')])
    other_font = _multi_page(tmp_path / 'font.pdf', [_text('Hello world', font='Courier')])

    assert _signature(base)[0] != _signature(other_font)[0]


def test_image_content_change_changes_the_signature(tmp_path):
    red = _png(tmp_path / 'red.png', (255, 0, 0))
    blue = _png(tmp_path / 'blue.png', (0, 0, 255))
    old = _multi_page(tmp_path / 'old.pdf', [_image(red)])
    new = _multi_page(tmp_path / 'new.pdf', [_image(blue)])
    same = _multi_page(tmp_path / 'same.pdf', [_image(red)])

    assert _signature(old)[0] != _signature(new)[0]
    # Same pixels, different file: the signature still matches.
    assert _signature(old)[0] == _signature(same)[0]


def test_table_only_change_changes_the_signature(tmp_path):
    old = _multi_page(tmp_path / 'old.pdf', [_table('Header B')])
    new = _multi_page(tmp_path / 'new.pdf', [_table('Header C')])

    # Same geometry and same fonts; only a cell's text differs.
    assert _signature(old)[0] != _signature(new)[0]


def test_page_geometry_change_changes_the_signature(tmp_path):
    base = _multi_page(tmp_path / 'base.pdf', [_text('Hello')])
    resized = _multi_page(tmp_path / 'resized.pdf', [_text('Hello')], pagesize=A4)

    def rotated(canvas) -> None:
        _text('Hello')(canvas)
        canvas.setPageRotation(90)

    turned = _multi_page(tmp_path / 'rotated.pdf', [rotated])

    assert _signature(base)[0] != _signature(resized)[0]
    assert _signature(base)[0] != _signature(turned)[0]


def test_signature_never_builds_a_pdfplumber_layout(tmp_path, monkeypatch):
    path = _multi_page(tmp_path / 'page.pdf', [_text('No layout please')])

    def refuse(self):  # pragma: no cover - must not be called
        raise AssertionError('page signature must not parse the page layout')

    monkeypatch.setattr(pdfplumber.page.Page, 'layout', property(refuse))

    signature, width, height = _signature(path)

    assert len(signature) == 64
    assert (width, height) == (612.0, 792.0)


def test_unreadable_page_gets_a_per_side_marker(tmp_path):
    # A page the signature cannot hash must never compare equal across sides:
    # that would silently skip the comparison instead of falling back to it.
    class BrokenPageObj:
        @property
        def attrs(self):
            raise RuntimeError('broken page tree')

    page = SimpleNamespace(width=612.0, height=792.0, page_obj=BrokenPageObj())
    extractor = SimpleNamespace(_pdf=SimpleNamespace(pages=[page]))
    path = Path('/tmp/broken.pdf')

    old_side = diff_module._page_signature(extractor, 1, path, 'old')
    new_side = diff_module._page_signature(extractor, 1, path, 'new')

    assert old_side == ('unhashed:old:1', 612.0, 792.0)
    assert new_side[0] == 'unhashed:new:1'
    assert old_side[0] != new_side[0]
    # The alignment key degrades the same way.
    assert diff_module._page_alignment_key(extractor, 1, path, 'old') != (
        diff_module._page_alignment_key(extractor, 1, path, 'new')
    )


# --- unchanged pages are never extracted ------------------------------------


def test_identical_documents_extract_no_pages(tmp_path, extracted):
    old = _multi_page(
        tmp_path / 'old.pdf',
        [_text('Page One'), _text('Page Two'), _text('Page Three')],
    )
    new = _multi_page(
        tmp_path / 'new.pdf',
        [_text('Page One'), _text('Page Two'), _text('Page Three')],
    )

    result = diff_files(old, new)

    assert extracted == []
    assert [page['status'] for page in result['pages']] == ['unchanged'] * 3
    assert all(page['changes'] == [] for page in result['pages'])
    assert all(page['match'] == {'score': 1.0, 'reordered': False} for page in result['pages'])
    assert result['summary'] == {
        'pagesAdded': 0,
        'pagesRemoved': 0,
        'pagesChanged': 0,
        'pagesReordered': 0,
        'objectsAdded': 0,
        'objectsRemoved': 0,
        'objectsMoved': 0,
        'objectsModified': 0,
        'changesTruncated': False,
    }


def test_byte_identical_files_take_the_shortcut(tmp_path, extracted):
    path = _multi_page(
        tmp_path / 'doc.pdf', [_text('Alpha'), _text('Bravo'), _text('Charlie')]
    )

    result = diff_files(path, path)

    assert extracted == []
    assert [page['status'] for page in result['pages']] == ['unchanged'] * 3
    assert result['old']['sha256'] == result['new']['sha256']
    assert [page['match'] for page in result['pages']] == [
        {'score': 1.0, 'reordered': False}
    ] * 3
    # Sizes still come from the page dictionary: the result shape is unchanged.
    assert result['pages'][0]['oldSize'] == {'width': 612.0, 'height': 792.0}
    assert result['pages'][0]['newSize'] == {'width': 612.0, 'height': 792.0}


def test_one_changed_page_extracts_only_that_page(tmp_path, extracted):
    old = _multi_page(
        tmp_path / 'old.pdf',
        [_text('Page One'), _text('Page Two'), _text('Page Three')],
    )
    new = _multi_page(
        tmp_path / 'new.pdf',
        [_text('Page One'), _text('Page Two CHANGED'), _text('Page Three')],
    )

    result = diff_files(old, new)

    # Only the changed page is extracted, once per side.
    assert extracted == [2, 2]
    assert [(page['oldIndex'], page['newIndex'], page['status']) for page in result['pages']] == [
        (1, 1, 'unchanged'),
        (2, 2, 'changed'),
        (3, 3, 'unchanged'),
    ]
    changes = result['pages'][1]['changes']
    # 'Page Two' → 'Page Two CHANGED': the extra word is reported, the pair is
    # still matched (not removed + added).
    assert any(
        change['type'] == 'word'
        and change['kind'] == 'added'
        and change['textNew'] == 'CHANGED'
        for change in changes
    )
    assert result['summary']['pagesChanged'] == 1
    # A changed page still carries a 0..1 score; its signature no longer matches.
    assert 0.0 < result['pages'][1]['match']['score'] < 1.0


def test_changed_page_with_ignored_types_is_still_extracted(tmp_path, extracted):
    # Ignored types do not make a page "unchanged": its signature differs, so it
    # is extracted and compared with the filtered object set.
    old = _multi_page(tmp_path / 'old.pdf', [_text('Alpha'), _text('Bravo')])
    new = _multi_page(tmp_path / 'new.pdf', [_text('Alpha'), _text('Bravo CHANGED')])

    result = diff_files(old, new, DiffOptions(ignore_types={'char'}))

    assert extracted == [2, 2]
    assert result['summary']['pagesChanged'] == 1
    assert all(
        change['type'] != 'char'
        for page in result['pages']
        for change in page['changes']
    )


# --- pairing ----------------------------------------------------------------


def test_reordered_unchanged_pages_are_still_paired(tmp_path, extracted):
    old = _multi_page(tmp_path / 'old.pdf', [_text('Alpha'), _text('Bravo')])
    new = _multi_page(tmp_path / 'new.pdf', [_text('Bravo'), _text('Alpha')])

    result = diff_files(old, new)

    paired = [
        (page['oldIndex'], page['newIndex'], page['match'])
        for page in result['pages']
        if page['match'] is not None
    ]
    # The swapped page is paired by content and flagged as reordered, with a
    # perfect score — even though its page number changed.
    assert paired == [(1, 2, {'score': 1.0, 'reordered': True})]
    assert result['summary']['pagesReordered'] == 1
    assert result['summary']['pagesChanged'] == 0
    # Only the two one-sided leftovers were extracted (difflib pairs one page of
    # a swap); the signature-identical pair itself never was.
    assert extracted == [1, 2]


def test_inserted_page_shifts_pairs_without_extracting_them(tmp_path, extracted):
    old = _multi_page(tmp_path / 'old.pdf', [_text('Page One'), _text('Page Two')])
    new = _multi_page(
        tmp_path / 'new.pdf',
        [_text('Inserted'), _text('Page One'), _text('Page Two')],
    )

    result = diff_files(old, new)

    assert _pages(result) == [
        (None, 1, 'added', None),
        (1, 2, 'unchanged', {'score': 1.0, 'reordered': True}),
        (2, 3, 'unchanged', {'score': 1.0, 'reordered': True}),
    ]
    assert result['summary']['pagesAdded'] == 1
    assert result['summary']['pagesReordered'] == 2
    # Only the one-sided page needed an extraction.
    assert extracted == [1]


def test_deleted_page_keeps_the_surviving_pages_paired(tmp_path, extracted):
    old = _multi_page(
        tmp_path / 'old.pdf',
        [_text('Removed'), _text('Page One'), _text('Page Two')],
    )
    new = _multi_page(tmp_path / 'new.pdf', [_text('Page One'), _text('Page Two')])

    result = diff_files(old, new)

    assert _pages(result) == [
        (1, None, 'removed', None),
        (2, 1, 'unchanged', {'score': 1.0, 'reordered': True}),
        (3, 2, 'unchanged', {'score': 1.0, 'reordered': True}),
    ]
    assert result['summary']['pagesRemoved'] == 1
    assert extracted == [1]


def test_moved_and_edited_page_is_still_paired(tmp_path, extracted):
    # The page moved to another position *and* one word moved inside it: it must
    # still be paired (and its word reported as moved) rather than degraded into
    # a removed page plus an added page.
    old = _multi_page(tmp_path / 'old.pdf', [_text('Alpha', x=100), _text('Beta')])
    new = _multi_page(tmp_path / 'new.pdf', [_text('Beta'), _text('Alpha', x=140)])

    result = diff_files(old, new)

    paired = [
        (page['oldIndex'], page['newIndex'], page['status'])
        for page in result['pages']
        if page['match'] is not None
    ]
    assert paired == [(1, 2, 'changed')]
    moved = [
        change
        for page in result['pages']
        for change in page['changes']
        if change['type'] == 'word' and change['kind'] == 'moved'
    ]
    assert len(moved) == 1
    assert moved[0]['textOld'] == moved[0]['textNew'] == 'Alpha'
    # The paired page was extracted on both sides ("Alpha" changed position); the
    # remaining page of the swap is one-sided, so it is extracted once per side.
    assert sorted(extracted) == [1, 1, 2, 2]


def test_duplicate_pages_still_align_deterministically(tmp_path, extracted):
    old = _multi_page(
        tmp_path / 'old.pdf', [_text('Same'), _text('Same'), _text('Other')]
    )
    new = _multi_page(tmp_path / 'new.pdf', [_text('Same'), _text('Other')])

    first = diff_files(old, new)
    extracted.clear()
    second = diff_files(old, new)

    assert first['pages'] == second['pages']
    # One of the duplicate pages is dropped and reported removed; the surviving
    # duplicate and 'Other' pair unchanged.
    assert [(page['oldIndex'], page['newIndex'], page['status']) for page in first['pages']] == [
        (1, None, 'removed'),
        (2, 1, 'unchanged'),
        (3, 2, 'unchanged'),
    ]
    # Only the dropped page had to be extracted.
    assert extracted == [1]
