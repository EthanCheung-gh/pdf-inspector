#!/usr/bin/env python3
"""Generate the deterministic demo PDFs used by the web build.

Creates three files in ``web-samples/``:

* ``basic.pdf`` - four pages with multi-font/colour text, a ruled table and a
  small raster image. Small enough to open instantly.
* ``large.pdf`` - 120 text pages using several fonts and sizes, so font
  analysis exercises batching/progress in the renderer.
* ``annotations.pdf`` - two pages with links, a text annotation, a highlight,
  a text field, a required checkbox and a combo choice field, for the
  read-only ``Annots`` tab and Inspector detail view.

The output is deterministic (fixed metadata, no timestamps, no randomness),
network-free and fast enough (<5s) to run on every demo setup. Only reportlab
is required; Pillow is used when available to build the sample image.
"""
from __future__ import annotations

import io
import os
import sys

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfdoc import PDFString
from reportlab.pdfgen import canvas

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "web-samples")

PAGE_WIDTH, PAGE_HEIGHT = LETTER
MARGIN = 56

INK = HexColor("#1f2937")
MUTED = HexColor("#6b7280")
ACCENT = HexColor("#2563eb")
ACCENT_SOFT = HexColor("#dbeafe")
RULE = HexColor("#9ca3af")
BAND = HexColor("#f3f4f6")

# Annotation demo values are module constants so the PDF stays byte-identical
# across runs: no clock, no randomness, fixed strings only.
ANNOTATION_URL = "https://example.com/pdf-inspector"
ANNOTATION_DATE = "D:20240101000000Z"
ANNOTATION_TITLE = "PDF Inspector"
ANNOTATION_NOTE = (
    "Sticky note: annotations are read-only in PDF Inspector. Select this box "
    "in the Annots tab to read the full contents in the Inspector."
)
ANNOTATION_HIGHLIGHT = "Highlighted: annotations are read-only in PDF Inspector."


def _sample_image() -> ImageReader | None:
    """Build a small in-memory PNG (no external asset, no network)."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:  # pragma: no cover - Pillow is in requirements
        return None

    image = Image.new("RGB", (240, 140), (248, 250, 252))
    draw = ImageDraw.Draw(image)

    # A tiny fake bar chart: three bars plus a baseline.
    for index, height in enumerate((44, 78, 60, 96)):
        left = 28 + index * 48
        draw.rectangle(
            [left, 118 - height, left + 30, 118],
            fill=(37, 99, 235),
            outline=(30, 64, 175),
        )
    draw.line([(16, 120), (224, 120)], fill=(107, 114, 128), width=2)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    buffer.seek(0)
    return ImageReader(buffer)


def _metadata(doc: canvas.Canvas, title: str) -> None:
    doc.setTitle(title)
    doc.setAuthor("PDF Inspector")
    doc.setSubject("Deterministic PDF Inspector demo document")
    doc.setCreator("scripts/generate-web-samples.py")
    doc.setProducer("ReportLab")


def _footer(doc: canvas.Canvas, label: str) -> None:
    doc.setFillColor(MUTED)
    doc.setFont("Courier", 8)
    doc.drawString(MARGIN, 30, label)
    doc.drawRightString(PAGE_WIDTH - MARGIN, 30, "PDF Inspector sample")


def _wrapped_lines(text: str, font: str, size: float, max_width: float) -> list[str]:
    """Cheap word wrap against the built-in font metrics."""
    from reportlab.pdfbase.pdfmetrics import stringWidth

    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if stringWidth(candidate, font, size) <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def build_basic(path: str) -> None:
    doc = canvas.Canvas(path, pagesize=LETTER, invariant=1)
    _metadata(doc, "PDF Inspector - Basic Sample")
    content_width = PAGE_WIDTH - 2 * MARGIN

    # -- Page 1: three fonts / sizes / colours -----------------------------
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 24)
    doc.drawString(MARGIN, PAGE_HEIGHT - 96, "PDF Inspector")

    doc.setFillColor(MUTED)
    doc.setFont("Times-Roman", 13)
    doc.drawString(MARGIN, PAGE_HEIGHT - 118, "A small four-page demo document")

    doc.setStrokeColor(ACCENT)
    doc.setLineWidth(2)
    doc.line(MARGIN, PAGE_HEIGHT - 136, MARGIN + 120, PAGE_HEIGHT - 136)

    samples = [
        ("Helvetica", 11, HexColor("#111827"), "Helvetica 11 - crisp sans-serif body text."),
        ("Times-Roman", 16, HexColor("#b91c1c"), "Times-Roman 16 - a larger serif line in red."),
        ("Courier", 20, HexColor("#047857"), "Courier 20 - monospaced, green."),
    ]
    y = PAGE_HEIGHT - 180
    for font, size, color, text in samples:
        doc.setFillColor(color)
        doc.setFont(font, size)
        doc.drawString(MARGIN, y, text)
        y -= size + 18

    doc.setFillColor(INK)
    doc.setFont("Helvetica", 10.5)
    paragraph = (
        "This document is generated by scripts/generate-web-samples.py so the "
        "browser build of PDF Inspector always has a local PDF to open. It "
        "contains text, a ruled table and an embedded image, which is enough to "
        "exercise page extraction, object inspection and font analysis."
    )
    for line in _wrapped_lines(paragraph, "Helvetica", 10.5, content_width):
        doc.drawString(MARGIN, y, line)
        y -= 15

    _footer(doc, "Page 1 of 4")
    doc.showPage()

    # -- Page 2: ruled table ------------------------------------------------
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 18)
    doc.drawString(MARGIN, PAGE_HEIGHT - 86, "Ruled table")

    columns = [MARGIN, MARGIN + 110, MARGIN + 250, MARGIN + 380]
    right = PAGE_WIDTH - MARGIN
    table_top = PAGE_HEIGHT - 120
    row_height = 26
    headers = ["Page", "Objects", "Fonts", "Notes"]
    rows = [
        ["1", "12", "3", "text + rules"],
        ["2", "18", "2", "table"],
        ["3", "9", "2", "image"],
        ["4", "14", "4", "mixed"],
        ["-", "-", "-", "demo data"],
        ["-", "-", "-", "not real metrics"],
    ]

    doc.setFillColor(ACCENT_SOFT)
    doc.rect(columns[0], table_top - row_height, right - columns[0], row_height, stroke=0, fill=1)
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 10)
    for index, header in enumerate(headers):
        doc.drawString(columns[index] + 8, table_top - 17, header)

    doc.setFont("Helvetica", 10)
    for row_index, row in enumerate(rows):
        top = table_top - row_height * (row_index + 1)
        if row_index % 2 == 1:
            doc.setFillColor(BAND)
            doc.rect(columns[0], top - row_height, right - columns[0], row_height, stroke=0, fill=1)
        doc.setFillColor(INK)
        for col_index, cell in enumerate(row):
            doc.drawString(columns[col_index] + 8, top - 17, cell)

    height = row_height * (len(rows) + 1)
    doc.setStrokeColor(RULE)
    doc.setLineWidth(0.6)
    doc.rect(columns[0], table_top - height, right - columns[0], height)
    for row_index in range(1, len(rows) + 1):
        y_line = table_top - row_height * row_index
        doc.line(columns[0], y_line, right, y_line)
    for x_line in columns[1:]:
        doc.line(x_line, table_top, x_line, table_top - height)

    doc.setFillColor(MUTED)
    doc.setFont("Times-Italic", 11)
    doc.drawString(MARGIN, table_top - height - 28, "The table is drawn with plain lines, not a form XObject.")
    _footer(doc, "Page 2 of 4")
    doc.showPage()

    # -- Page 3: embedded image --------------------------------------------
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 18)
    doc.drawString(MARGIN, PAGE_HEIGHT - 86, "Embedded image")

    image = _sample_image()
    if image is not None:
        image_width, image_height = 240, 140
        x = (PAGE_WIDTH - image_width) / 2
        y = PAGE_HEIGHT - 96 - image_height - 28
        doc.setStrokeColor(RULE)
        doc.setLineWidth(0.8)
        doc.rect(x - 1, y - 1, image_width + 2, image_height + 2)
        doc.drawImage(image, x, y, width=image_width, height=image_height, mask="auto")

        doc.setFillColor(MUTED)
        doc.setFont("Helvetica", 10)
        doc.drawCentredString(PAGE_WIDTH / 2, y - 24, "240 x 140 PNG generated in memory with Pillow")
    else:  # pragma: no cover - only when Pillow is missing
        doc.setFillColor(MUTED)
        doc.setFont("Helvetica", 11)
        doc.drawString(MARGIN, PAGE_HEIGHT - 140, "Image skipped: Pillow is not installed.")

    doc.setFillColor(INK)
    doc.setFont("Times-Roman", 12)
    doc.drawString(MARGIN, 150, "Use the image tab to inspect the XObject above.")
    _footer(doc, "Page 3 of 4")
    doc.showPage()

    # -- Page 4: mixed text -------------------------------------------------
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 18)
    doc.drawString(MARGIN, PAGE_HEIGHT - 86, "Mixed styles")

    y = PAGE_HEIGHT - 130
    styles = [
        ("Helvetica-Bold", 20, HexColor("#1d4ed8"), "Bold sans-serif 20"),
        ("Helvetica-Oblique", 15, HexColor("#7c3aed"), "Oblique sans-serif 15"),
        ("Times-Bold", 17, HexColor("#0f766e"), "Bold serif 17"),
        ("Times-Italic", 13, HexColor("#c2410c"), "Italic serif 13"),
        ("Courier-Bold", 14, HexColor("#111827"), "Bold monospace 14"),
    ]
    for font, size, color, text in styles:
        doc.setFillColor(color)
        doc.setFont(font, size)
        doc.drawString(MARGIN, y, text)
        y -= size + 20

    doc.setFillColor(INK)
    doc.setFont("Helvetica", 10)
    body = (
        "Font analysis walks every page, groups text by font, and reports the "
        "sizes and page ranges where each font is used. This last page adds "
        "three more built-in fonts so the result is not dominated by page one."
    )
    for line in _wrapped_lines(body, "Helvetica", 10, content_width):
        doc.drawString(MARGIN, y, line)
        y -= 14

    _footer(doc, "Page 4 of 4")
    doc.save()


def build_annotations(path: str) -> None:
    """Two-page read-only annotation demo: links, markup, note and form fields.

    Page 1 carries the interactive layer the ``Annots`` tab inspects: an
    external ``http(s)`` link, an internal link resolved through a named
    destination, a highlight, a sticky-note ``Text`` annotation, and three
    AcroForm widgets (text field, required checkbox, combo choice). Page 2 is
    the destination page and defines the ``page2`` bookmark target.

    Everything is fixed: the same URL, note, highlight colour and modification
    date on every run, ``invariant=1`` and no network access.
    """
    from reportlab.pdfbase.pdfmetrics import stringWidth

    doc = canvas.Canvas(path, pagesize=LETTER, invariant=1)
    _metadata(doc, "PDF Inspector - Annotations Sample")
    content_width = PAGE_WIDTH - 2 * MARGIN
    form = doc.acroForm

    def section(title: str, y: float) -> None:
        doc.setFillColor(INK)
        doc.setFont("Helvetica-Bold", 13)
        doc.drawString(MARGIN, y, title)

    # -- Page 1: links, markup, note and form fields -----------------------
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 22)
    doc.drawString(MARGIN, PAGE_HEIGHT - 60, "Annotations, links and forms")

    doc.setFillColor(MUTED)
    doc.setFont("Times-Roman", 12)
    doc.drawString(MARGIN, PAGE_HEIGHT - 82, "Read-only interactive layer for the Annots tab")

    doc.setStrokeColor(ACCENT)
    doc.setLineWidth(1.4)
    doc.line(MARGIN, PAGE_HEIGHT - 94, MARGIN + 120, PAGE_HEIGHT - 94)

    section("Links", PAGE_HEIGHT - 126)

    # External link: the URI annotation is the row itself, so the box in the
    # Annots overlay lines up with the visible label.
    url_label = f"External link: {ANNOTATION_URL}"
    url_width = stringWidth(url_label, "Helvetica", 10.5)
    url_baseline = PAGE_HEIGHT - 152
    doc.setFillColor(ACCENT)
    doc.setFont("Helvetica", 10.5)
    doc.drawString(MARGIN, url_baseline, url_label)
    doc.setStrokeColor(ACCENT)
    doc.setLineWidth(0.6)
    doc.line(MARGIN, url_baseline - 2.5, MARGIN + url_width, url_baseline - 2.5)
    doc.linkURL(
        ANNOTATION_URL,
        (MARGIN, url_baseline - 4, MARGIN + url_width + 2, url_baseline + 11),
        thickness=0,
    )

    # Internal link: resolved through the named destination defined on page 2.
    internal_label = "Internal link: go to page 2"
    internal_width = stringWidth(internal_label, "Helvetica", 10.5)
    internal_baseline = PAGE_HEIGHT - 178
    doc.setFillColor(ACCENT)
    doc.setFont("Helvetica", 10.5)
    doc.drawString(MARGIN, internal_baseline, internal_label)
    doc.setStrokeColor(ACCENT)
    doc.line(MARGIN, internal_baseline - 2.5, MARGIN + internal_width, internal_baseline - 2.5)
    doc.linkRect(
        "Go to page 2",
        "page2",
        (MARGIN, internal_baseline - 4, MARGIN + internal_width + 2, internal_baseline + 11),
        thickness=0,
    )

    section("Markup and notes", PAGE_HEIGHT - 212)

    highlight_width = stringWidth(ANNOTATION_HIGHLIGHT, "Helvetica-Oblique", 11)
    highlight_baseline = PAGE_HEIGHT - 238
    doc.setFillColor(BAND)
    doc.rect(MARGIN - 2, highlight_baseline - 4, highlight_width + 6, 17, stroke=0, fill=1)
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Oblique", 11)
    doc.drawString(MARGIN, highlight_baseline, ANNOTATION_HIGHLIGHT)
    doc.highlightAnnotation(
        ANNOTATION_HIGHLIGHT,
        (MARGIN - 2, highlight_baseline - 4, MARGIN + highlight_width + 4, highlight_baseline + 13),
        Color=[1.0, 0.9, 0.35],
    )

    # Sticky note: a small drawn icon plus a Text annotation of the same rect,
    # so the canvas box sits on something visible. PDF.js renders `Text`
    # annotations with a 22x22 note icon anchored at the top of the rectangle,
    # so the drawn square uses that same size to stay aligned.
    note_icon_size = 22
    note_top = PAGE_HEIGHT - 268
    note_bottom = note_top - note_icon_size
    doc.setFillColor(ACCENT_SOFT)
    doc.setStrokeColor(ACCENT)
    doc.setLineWidth(0.9)
    doc.rect(MARGIN, note_bottom, note_icon_size, note_icon_size, stroke=1, fill=1)
    doc.setFillColor(ACCENT)
    doc.setFont("Helvetica-Bold", 11)
    doc.drawString(MARGIN + 7, note_bottom + 6, "i")
    doc.setFillColor(MUTED)
    doc.setFont("Helvetica", 10.5)
    doc.drawString(MARGIN + 30, note_bottom + 6, "Text annotation (sticky note) - select it to read the contents")
    doc.textAnnotation(
        ANNOTATION_NOTE,
        Rect=(MARGIN, note_bottom, MARGIN + note_icon_size, note_top),
        T=PDFString(ANNOTATION_TITLE),
        M=PDFString(ANNOTATION_DATE),
    )

    section("Form fields (read-only)", PAGE_HEIGHT - 314)

    def field_label(text: str, y: float) -> None:
        doc.setFillColor(MUTED)
        doc.setFont("Helvetica", 9)
        doc.drawString(MARGIN, y, text)

    field_label("full_name (text field, value: Alice)", PAGE_HEIGHT - 340)
    form.textfield(
        name="full_name",
        value="Alice",
        x=MARGIN,
        y=PAGE_HEIGHT - 370,
        width=220,
        height=24,
        fontName="Helvetica",
        fontSize=10,
        fillColor=HexColor("#ffffff"),
        borderColor=RULE,
        textColor=INK,
        borderWidth=0.8,
        forceBorder=True,
    )

    field_label("agree (checkbox, required, checked)", PAGE_HEIGHT - 398)
    form.checkbox(
        name="agree",
        checked=True,
        x=MARGIN,
        y=PAGE_HEIGHT - 424,
        size=16,
        fieldFlags="required",
        fillColor=ACCENT_SOFT,
        borderColor=ACCENT,
        textColor=INK,
        borderWidth=0.8,
        forceBorder=True,
    )

    field_label("plan (combo choice, value: Pro)", PAGE_HEIGHT - 452)
    form.choice(
        name="plan",
        value="Pro",
        options=["Free", "Pro", "Team"],
        x=MARGIN,
        y=PAGE_HEIGHT - 482,
        width=180,
        height=24,
        fieldFlags="combo",
        fontName="Helvetica",
        fontSize=10,
        fillColor=HexColor("#ffffff"),
        borderColor=RULE,
        textColor=INK,
        borderWidth=0.8,
        forceBorder=True,
    )

    doc.setFillColor(MUTED)
    doc.setFont("Helvetica", 10)
    doc.drawString(MARGIN, PAGE_HEIGHT - 530, "Values and flags are displayed read-only in the Inspector.")
    doc.drawString(MARGIN, PAGE_HEIGHT - 546, "There is no edit, reset or submit action.")

    _footer(doc, "Page 1 of 2")
    doc.showPage()

    # -- Page 2: internal link destination ---------------------------------
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 22)
    doc.drawString(MARGIN, PAGE_HEIGHT - 60, "Destination page")

    doc.setFillColor(MUTED)
    doc.setFont("Times-Roman", 12)
    doc.drawString(MARGIN, PAGE_HEIGHT - 82, "Target of the internal link and the page2 bookmark")

    doc.setStrokeColor(ACCENT)
    doc.setLineWidth(1.4)
    doc.line(MARGIN, PAGE_HEIGHT - 94, MARGIN + 120, PAGE_HEIGHT - 94)

    paragraph = (
        "The internal link on page 1 points at the named destination page2, "
        "which is defined on this page. Selecting that link in the Annots tab "
        "shows Go to page 2 in the Inspector; the button navigates here with "
        "the same guarded page navigation as the Prev/Next controls."
    )
    y = PAGE_HEIGHT - 130
    doc.setFillColor(INK)
    doc.setFont("Helvetica", 10.5)
    for line in _wrapped_lines(paragraph, "Helvetica", 10.5, content_width):
        doc.drawString(MARGIN, y, line)
        y -= 15

    doc.setFillColor(MUTED)
    doc.setFont("Times-Italic", 11)
    doc.drawString(MARGIN, y - 12, "This page has no annotations of its own.")

    # Named destination used by the page 1 link; the app resolves it with
    # PDF.js and only navigates to the resolved page number.
    doc.bookmarkPage("page2", fit="Fit")

    _footer(doc, "Page 2 of 2")
    doc.save()


def build_large(path: str) -> None:
    """120 pages of simple text: fast to build, enough for batched analysis."""
    doc = canvas.Canvas(path, pagesize=LETTER, invariant=1)
    _metadata(doc, "PDF Inspector - Large Sample")
    content_width = PAGE_WIDTH - 2 * MARGIN

    body = (
        "This is one page of a generated 120-page document. The same paragraph "
        "is repeated with a few different fonts and sizes so font analysis has "
        "to visit every page and aggregate the results. Batches keep the UI "
        "responsive while the sidecar works through the range."
    )

    for page in range(1, 121):
        doc.setFillColor(INK)
        doc.setFont("Helvetica-Bold", 18)
        doc.drawString(MARGIN, PAGE_HEIGHT - 84, f"Large sample - page {page}")

        doc.setStrokeColor(ACCENT)
        doc.setLineWidth(1.2)
        doc.line(MARGIN, PAGE_HEIGHT - 98, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 98)

        y = PAGE_HEIGHT - 132
        doc.setFillColor(HexColor("#1d4ed8"))
        doc.setFont("Times-Bold", 15)
        doc.drawString(MARGIN, y, f"Section {page}: headings and body copy")
        y -= 26

        doc.setFillColor(INK)
        doc.setFont("Helvetica", 10.5)
        for line in _wrapped_lines(body, "Helvetica", 10.5, content_width):
            doc.drawString(MARGIN, y, line)
            y -= 14

        doc.setFillColor(HexColor("#374151"))
        doc.setFont("Courier", 9.5)
        doc.drawString(MARGIN, y - 6, f"monospace marker page={page:03d} step={page * 7 % 97:02d}")
        y -= 30

        doc.setFillColor(MUTED)
        doc.setFont("Times-Italic", 11)
        doc.drawString(MARGIN, y, "Italic serif line to give the analyzer another font to report.")
        y -= 24

        doc.setFillColor(INK)
        doc.setFont("Helvetica-Oblique", 10)
        doc.drawString(MARGIN, y, "Oblique sans-serif note closes the page.")

        _footer(doc, f"Page {page} of 120")
        doc.showPage()

    doc.save()


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    basic = os.path.join(OUT_DIR, "basic.pdf")
    large = os.path.join(OUT_DIR, "large.pdf")
    annotations = os.path.join(OUT_DIR, "annotations.pdf")

    build_basic(basic)
    build_large(large)
    build_annotations(annotations)

    print(basic)
    print(large)
    print(annotations)
    return 0


if __name__ == "__main__":
    sys.exit(main())
