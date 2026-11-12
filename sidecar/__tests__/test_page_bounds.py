"""Page numbers that do not exist must be rejected, never indexed.

A page request is addressed to "the document the sidecar has open". A renderer
that still holds a page number from a document the user already replaced (a
bookmark clicked just before a tab switch, a restored snapshot) therefore asks
for a page that the current PDF does not have. Both entry points used to index
``self._pdf.pages[page_num - 1]`` directly, which raised ``IndexError: list index
out of range`` for a page past the end and silently read the *last* page for
page 0. These tests pin the explicit behaviour instead.
"""

import sys
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractor import PdfExtractor  # noqa: E402

PAGE_COUNT = 3


@pytest.fixture()
def extractor(tmp_path):
    path = tmp_path / "three-pages.pdf"
    pdf = rl_canvas.Canvas(str(path), pagesize=letter)
    for index in range(PAGE_COUNT):
        pdf.drawString(72, 720, f"page {index + 1}")
        pdf.showPage()
    pdf.save()

    instance = PdfExtractor(str(path))
    try:
        yield instance
    finally:
        instance.close()


def test_valid_pages_are_unchanged(extractor):
    for page_num in range(1, PAGE_COUNT + 1):
        data = extractor.extract_page(page_num)
        assert data["width"] > 0 and data["height"] > 0
        assert {c["page"] for c in data["chars"]} == {page_num}


@pytest.mark.parametrize("page_num", [0, -1, PAGE_COUNT + 1, 99])
def test_extract_page_rejects_pages_outside_the_document(extractor, page_num):
    with pytest.raises(ValueError) as excinfo:
        extractor.extract_page(page_num)

    message = str(excinfo.value)
    assert "Invalid page range" in message
    assert f"document has {PAGE_COUNT} pages" in message
    # The point of the validation: no IndexError leaks out of the indexing.
    assert not isinstance(excinfo.value, IndexError)
    assert "list index out of range" not in message


@pytest.mark.parametrize("page_num", [1.5, "1", True])
def test_extract_page_rejects_non_integer_pages(extractor, page_num):
    with pytest.raises(ValueError):
        extractor.extract_page(page_num)


def test_get_image_data_reports_page_zero_without_reading_the_last_page(extractor):
    # Page 0 is valid Python indexing for the last page; it must be an error
    # instead of a confusing "image index out of range" (or, worse, the wrong
    # page's image) for the current document.
    assert extractor.get_image_data("p0_img_0") == {"error": "Page 0 out of range"}
    assert extractor.get_image_data("p0_img_3") == {"error": "Page 0 out of range"}


@pytest.mark.parametrize("page_num", [PAGE_COUNT + 1, 99])
def test_get_image_data_reports_pages_past_the_end(extractor, page_num):
    assert extractor.get_image_data(f"p{page_num}_img_0") == {
        "error": f"Page {page_num} out of range"
    }


def test_get_image_data_on_a_valid_page_still_reports_missing_images(extractor):
    # Valid pages keep the previous behaviour: the page is looked up and only the
    # image index can then be out of range.
    assert extractor.get_image_data("p1_img_0") == {"error": "Image index 0 out of range"}
