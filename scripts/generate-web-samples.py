#!/usr/bin/env python3
"""Generate the deterministic demo PDFs used by the web build.

Creates these files in ``web-samples/``:

* ``basic.pdf`` - four pages with multi-font/colour text, a ruled table and a
  small raster image. Small enough to open instantly.
* ``large.pdf`` - 120 text pages using several fonts and sizes, so font
  analysis exercises batching/progress in the renderer.
* ``huge.pdf`` - 1000 minimal text pages with one unique search marker per
  page, for the large-document page list, Go-to-page jump and batched search
  index progress. Deliberately simple: it is a scale fixture, not a font or
  layout fixture.
* ``annotations.pdf`` - two pages with links, a text annotation, a highlight,
  a text field, a required checkbox and a combo choice field, for the
  read-only ``Annots`` tab and Inspector detail view.
* ``raw.pdf`` - two pages for the ``Raw`` workspace: page 1 has text, several
  named font resources, a raster image XObject (``Do``) and content-stream
  ``BT``/``Tf``/``Tj`` operators, page 2 is a plain text page.
* ``diff-visual-old.pdf`` / ``diff-visual-new.pdf`` - the same two-page
  document with a small text, colour and position change on page 1, for the
  Diff ``Visual`` blend/heatmap view.
* ``diff-reordered-old.pdf`` / ``diff-reordered.pdf`` - five-page documents
  where revision B drops the draft page from the front, moves every surviving
  page to a new ordinal position and appends a release-notes page, so page
  alignment reports reordered pairs and one added page.

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

# Diff fixtures reuse a tiny fixed palette so the visual diff has a few solid
# colour blocks (clear heatmap areas) next to text and moved shapes.
VISUAL_BADGE_OLD = HexColor("#f59e0b")
VISUAL_BADGE_NEW = HexColor("#10b981")
VISUAL_SWATCHES = (
    ("Red", HexColor("#dc2626")),
    ("Green", HexColor("#16a34a")),
    ("Blue", HexColor("#2563eb")),
)
# Revision B recolours the first swatch instead of moving it.
VISUAL_SWATCH_RED_NEW = HexColor("#7c3aed")
# The blue swatch is shifted right by this many points in revision B.
VISUAL_SWATCH_SHIFT = 28.0

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

# Page count of the large-document scale fixture; exported so docs and tests can
# refer to one number without parsing the PDF.
HUGE_PAGE_COUNT = 1000


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


def build_raw(path: str) -> None:
    """Two-page demo for the read-only ``Raw`` workspace.

    Page 1 keeps every shape the Raw view needs to show, without hand-writing
    any PDF syntax:

    * heading and body text, emitted as ``BT`` / ``Tf`` / ``Tj`` operators;
    * several named font resources (reportlab names them ``/F1``, ``/F2``, ...);
    * an image XObject placed with a ``Do`` operator;
    * the nested ``/Resources`` dictionary reportlab produces naturally
      (``/Font`` and ``/XObject`` sub-dictionaries).

    Page 2 is a plain text page so the content-stream page selector has a
    second, much smaller stream to compare against. Metadata, image bytes and
    operator order are fixed on every run (``invariant=1``, no clock, no
    randomness, no network).
    """
    doc = canvas.Canvas(path, pagesize=LETTER, invariant=1)
    _metadata(doc, "PDF Inspector - Raw Object Sample")
    content_width = PAGE_WIDTH - 2 * MARGIN

    # -- Page 1: text, resources, image and their operators -----------------
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 22)
    doc.drawString(MARGIN, PAGE_HEIGHT - 86, "Raw object graph")

    # The image is drawn right after the heading so its `Do` operator lands
    # near the top of the decoded content stream, directly after the heading's
    # BT / Tf / Tj block. One screen of the Content stream tab is then enough
    # to show all four operators without scrolling.
    image = _sample_image()
    image_width, image_height = 240, 140
    image_top = PAGE_HEIGHT - 116
    image_y = image_top - image_height
    if image is not None:
        doc.drawImage(
            image,
            MARGIN,
            image_y,
            width=image_width,
            height=image_height,
            mask="auto",
        )

        doc.setFillColor(MUTED)
        doc.setFont("Helvetica", 9)
        doc.drawString(
            MARGIN,
            image_y - 16,
            "Raster image XObject, placed with a Do operator",
        )
    else:  # pragma: no cover - only when Pillow is missing
        doc.setFillColor(MUTED)
        doc.setFont("Helvetica", 10)
        doc.drawString(MARGIN, image_y + 60, "Image skipped: Pillow is not installed.")

    y = image_y - 46
    doc.setFillColor(MUTED)
    doc.setFont("Times-Roman", 12)
    doc.drawString(
        MARGIN,
        y,
        "Catalog, page resources, references and content operators",
    )

    doc.setStrokeColor(ACCENT)
    doc.setLineWidth(1.4)
    doc.line(MARGIN, y - 12, MARGIN + 160, y - 12)

    y -= 44
    paragraph = (
        "Open this page with the Raw workspace to read the trailer roots, the "
        "catalog, and the page dictionary as plain PDF values. References such "
        "as the page tree or a font stay references until they are expanded, "
        "and the decoded content stream shows the same text and image operators "
        "a PDF reader would execute."
    )
    doc.setFillColor(INK)
    doc.setFont("Helvetica", 10.5)
    for line in _wrapped_lines(paragraph, "Helvetica", 10.5, content_width):
        doc.drawString(MARGIN, y, line)
        y -= 15

    # A second named font resource (Courier) so the /Font dictionary has more
    # than one entry, and the operator examples read like a real stream.
    y -= 10
    doc.setFillColor(HexColor("#0f766e"))
    doc.setFont("Courier", 9.5)
    for snippet in (
        "BT /F1 10.5 Tf 56 640 Td (Raw object graph) Tj ET",
        "q 240 0 0 140 56 300 cm /FormXob... Do Q",
    ):
        doc.drawString(MARGIN, y, snippet)
        y -= 13

    _footer(doc, "Page 1 of 2")
    doc.showPage()

    # -- Page 2: a small, plain text page ----------------------------------
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 18)
    doc.drawString(MARGIN, PAGE_HEIGHT - 86, "A second, simpler page")

    paragraph = (
        "This page only draws text, so its content stream is short: one font "
        "resource, a handful of BT / Tf / Tj operators and nothing else. Switch "
        "the page selector in the Content stream tab to compare it with page 1."
    )
    y = PAGE_HEIGHT - 124
    doc.setFillColor(INK)
    doc.setFont("Helvetica", 10.5)
    for line in _wrapped_lines(paragraph, "Helvetica", 10.5, content_width):
        doc.drawString(MARGIN, y, line)
        y -= 15

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


def build_huge(path: str) -> None:
    """1000 minimal pages for page-list and search-index scale tests.

    Each page carries one unique ``huge marker NNNN`` string so a search returns
    exactly one match and can prove which page the batched index reached. The
    layout is deliberately tiny (a heading, one marker line and a footer): this
    fixture tests pagination/search scale, not font analysis or object density,
    and staying small keeps the deterministic file around a megabyte.
    """
    doc = canvas.Canvas(path, pagesize=LETTER, invariant=1)
    _metadata(doc, "PDF Inspector - Huge Sample")

    for page in range(1, HUGE_PAGE_COUNT + 1):
        doc.setFillColor(INK)
        doc.setFont("Helvetica-Bold", 18)
        doc.drawString(MARGIN, PAGE_HEIGHT - 84, f"Huge sample - page {page}")

        doc.setStrokeColor(ACCENT)
        doc.setLineWidth(1.2)
        doc.line(MARGIN, PAGE_HEIGHT - 98, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 98)

        doc.setFillColor(INK)
        doc.setFont("Helvetica", 11)
        doc.drawString(
            MARGIN,
            PAGE_HEIGHT - 130,
            f"Search marker: huge marker {page:04d}",
        )

        doc.setFillColor(MUTED)
        doc.setFont("Times-Roman", 10.5)
        doc.drawString(
            MARGIN,
            PAGE_HEIGHT - 152,
            "Use Go to page, the page list or Ctrl+F to exercise a 1000-page document.",
        )

        _footer(doc, f"Page {page} of {HUGE_PAGE_COUNT}")
        doc.showPage()

    doc.save()


def _visual_page(doc: canvas.Canvas, *, revised: bool) -> None:
    """Page 1 of the visual fixture; revision B edits text, colour and position."""
    content_width = PAGE_WIDTH - 2 * MARGIN

    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 22)
    doc.drawString(MARGIN, PAGE_HEIGHT - 88, "Visual diff demo")

    doc.setFillColor(MUTED)
    doc.setFont("Times-Roman", 12)
    doc.drawString(MARGIN, PAGE_HEIGHT - 110, "Revision B" if revised else "Revision A")

    doc.setStrokeColor(ACCENT)
    doc.setLineWidth(1.6)
    doc.line(MARGIN, PAGE_HEIGHT - 124, MARGIN + 140, PAGE_HEIGHT - 124)

    # Status badge: the fill colour and the label both change in revision B,
    # so the heatmap has one large, unmistakable colour block.
    badge_color = VISUAL_BADGE_NEW if revised else VISUAL_BADGE_OLD
    badge_label = "STATUS: FINAL" if revised else "STATUS: DRAFT"
    doc.setFillColor(badge_color)
    doc.rect(MARGIN, PAGE_HEIGHT - 180, 168, 34, stroke=0, fill=1)
    doc.setFillColor(HexColor("#ffffff"))
    doc.setFont("Helvetica-Bold", 12)
    doc.drawString(MARGIN + 16, PAGE_HEIGHT - 169, badge_label)

    # Three swatches: red is recoloured, blue moves right, green is untouched.
    swatch_top = PAGE_HEIGHT - 236
    for index, (label, colour) in enumerate(VISUAL_SWATCHES):
        x = MARGIN + index * 126
        if revised and label == "Blue":
            x += VISUAL_SWATCH_SHIFT
        fill = VISUAL_SWATCH_RED_NEW if revised and label == "Red" else colour
        doc.setFillColor(fill)
        doc.rect(x, swatch_top, 96, 64, stroke=0, fill=1)
        doc.setStrokeColor(RULE)
        doc.setLineWidth(0.8)
        doc.rect(x, swatch_top, 96, 64, stroke=1, fill=0)
        doc.setFillColor(INK)
        doc.setFont("Helvetica", 10)
        doc.drawCentredString(x + 48, swatch_top - 16, label)

    # One number in the body text changes.
    count = "48" if revised else "42"
    paragraph = (
        "This fixture is generated twice with the same layout. The status "
        f"badge, the swatches and this line change: object counts read {count} "
        "words, a handful of rectangles and 2 pages in the current revision."
    )
    y = swatch_top - 52
    doc.setFillColor(INK)
    doc.setFont("Helvetica", 10.5)
    for line in _wrapped_lines(paragraph, "Helvetica", 10.5, content_width):
        doc.drawString(MARGIN, y, line)
        y -= 15

    # A quiet callout below the paragraph: identical in both revisions, it just
    # fills the page so the visual view has a realistic amount of white space.
    box_top = y - 34
    box_height = 96
    doc.setFillColor(BAND)
    doc.rect(MARGIN, box_top - box_height, content_width, box_height, stroke=0, fill=1)
    doc.setStrokeColor(RULE)
    doc.setLineWidth(0.8)
    doc.rect(MARGIN, box_top - box_height, content_width, box_height, stroke=1, fill=0)
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 11)
    doc.drawString(MARGIN + 14, box_top - 24, "What to look for")
    doc.setFont("Helvetica", 10)
    callout = [
        "A solid colour block turns green and its label reads FINAL.",
        "The first swatch is recoloured and the third one moves to the right.",
        "Only page 1 changes; page 2 stays identical in both revisions.",
    ]
    callout_y = box_top - 44
    for line in callout:
        doc.drawString(MARGIN + 14, callout_y, line)
        callout_y -= 15

    doc.setFillColor(MUTED)
    doc.setFont("Times-Italic", 10.5)
    doc.drawString(
        MARGIN,
        box_top - box_height - 26,
        "Switch the Diff workspace to Visual to compare this page as pixels.",
    )

    _footer(doc, "Page 1 of 2")
    doc.showPage()

    # -- Page 2: identical in both revisions --------------------------------
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 18)
    doc.drawString(MARGIN, PAGE_HEIGHT - 86, "Unchanged page")

    paragraph = (
        "The second page is identical in both revisions. It shows that the "
        "visual view still reports an unchanged pair, and that page alignment "
        "keeps the two pages together."
    )
    y = PAGE_HEIGHT - 124
    doc.setFillColor(INK)
    doc.setFont("Helvetica", 10.5)
    for line in _wrapped_lines(paragraph, "Helvetica", 10.5, content_width):
        doc.drawString(MARGIN, y, line)
        y -= 15

    _footer(doc, "Page 2 of 2")


def build_diff_visual(old_path: str, new_path: str) -> None:
    """Two-page revisions that differ only on page 1 (text, colour, position).

    ``diff-visual-old.pdf`` is revision A and ``diff-visual-new.pdf`` revision
    B: the status badge turns green and reads ``FINAL``, the red swatch becomes
    purple, the blue swatch moves 28 pt right and one number in the body text
    changes. Page 2 is identical, so the pair also exercises the unchanged-page
    state. Both files are byte-identical across runs.
    """
    for path, title, revised in (
        (old_path, "PDF Inspector - Diff Visual (Revision A)", False),
        (new_path, "PDF Inspector - Diff Visual (Revision B)", True),
    ):
        doc = canvas.Canvas(path, pagesize=LETTER, invariant=1)
        _metadata(doc, title)
        _visual_page(doc, revised=revised)
        doc.save()


def _revision_page(
    doc: canvas.Canvas,
    *,
    title: str,
    subtitle: str,
    bullets: list[str],
    footer: str,
    badge_text: str | None = None,
    badge_color: HexColor | None = None,
    bars: tuple[int, ...] = (),
    rule_offset: float = 0.0,
) -> None:
    """Draw one text page of the alignment fixture.

    Every page uses the same layout, and the footer carries no page number, so
    the extracted text of a page is identical in both revisions. That keeps the
    page fingerprints stable and makes the alignment (not the content) the only
    thing revision B changes.
    """
    doc.setFillColor(INK)
    doc.setFont("Helvetica-Bold", 22)
    doc.drawString(MARGIN, PAGE_HEIGHT - 88, title)

    doc.setFillColor(MUTED)
    doc.setFont("Times-Roman", 12)
    doc.drawString(MARGIN, PAGE_HEIGHT - 110, subtitle)

    doc.setStrokeColor(ACCENT)
    doc.setLineWidth(1.6)
    doc.line(MARGIN, PAGE_HEIGHT - 124 + rule_offset, MARGIN + 150, PAGE_HEIGHT - 124 + rule_offset)

    y = PAGE_HEIGHT - 162
    if badge_text is not None and badge_color is not None:
        doc.setFillColor(badge_color)
        doc.rect(MARGIN, y - 8, 150, 30, stroke=0, fill=1)
        doc.setFillColor(HexColor("#ffffff"))
        doc.setFont("Helvetica-Bold", 11)
        doc.drawString(MARGIN + 14, y + 2, badge_text)
        y -= 46

    if bars:
        for index, height in enumerate(bars):
            doc.setFillColor(VISUAL_SWATCHES[index % len(VISUAL_SWATCHES)][1])
            doc.rect(MARGIN + index * 72, y - height, 42, height, stroke=0, fill=1)
            doc.setFillColor(INK)
            doc.setFont("Helvetica", 9)
            doc.drawCentredString(MARGIN + index * 72 + 21, y - height - 14, f"Q{index + 1}")
        y -= max(bars) + 38

    doc.setFillColor(INK)
    doc.setFont("Helvetica", 10.5)
    for bullet in bullets:
        doc.drawString(MARGIN, y, bullet)
        y -= 17

    _footer(doc, footer)


def build_diff_reordered(old_path: str, new_path: str) -> None:
    """Five-page fixtures whose alignment reports reordered and added pages.

    Revision A is ``draft, cover, summary, charts, appendix``; revision B drops
    the draft page from the front, then appends a release-notes page:

    ``cover, summary, charts, appendix, release notes``

    Every surviving page therefore keeps its content but lands on a new ordinal
    position, so page alignment pairs it and sets ``match.reordered`` (four
    reordered pairs), the draft page is removed and the release-notes page is
    added. The cover badge changes colour, which gives the changed-page state
    without touching the extracted text, so the fingerprint stays identical.
    """
    draft = dict(
        title="Draft notice",
        subtitle="Removed in revision B",
        bullets=[
            "Revision A starts with this draft page.",
            "Revision B removes it from the front of the document.",
            "The page stays one-sided in the result: removed, never paired.",
        ],
    )
    cover = dict(
        title="Revision cover",
        subtitle="Deterministic page-alignment fixture",
        badge_text="REVISION 1.0",
        bullets=[
            "Document: alignment-demo.pdf",
            "Owner: docs team",
            "Pages: cover, summary, charts, appendix and release notes",
        ],
    )
    # Revision B moves every header rule down by 3 pt (a global spacing tweak).
    # Text and object counts stay identical, so every page fingerprint still
    # matches, while the object diff reports one moved line per page and the
    # page list shows each reordered pair.
    summary = dict(        title="Summary",
        subtitle="Why revision B looks reordered",
        bullets=[
            "The draft page is gone, so every surviving page moves up one number.",
            "Page alignment pairs pages by content and then reads the new number.",
            "Reordered means oldIndex != newIndex, not that objects moved.",
        ],
    )
    charts = dict(
        title="Charts",
        subtitle="A stable page keeps the alignment readable",
        bars=(60, 96, 78, 120),
        bullets=[
            "The bars are plain rectangles with fixed sizes.",
            "They are identical in both revisions, so only the page number moves.",
        ],
    )
    appendix = dict(
        title="Appendix",
        subtitle="Paired, unchanged and reordered",
        bullets=[
            "This page is the last surviving page of revision A.",
            "Revision B keeps it but appends a new page after it.",
            "Open the Diff workspace to see the old -> new page labels.",
        ],
    )
    release = dict(
        title="Release notes",
        subtitle="Added in revision B",
        bullets=[
            "This page only exists in revision B, so it is reported as added.",
            "Added pages are one-sided: they have no old page number.",
            "Appending it keeps every earlier page pair stable.",
        ],
    )

    footer = "Alignment demo - PDF Inspector sample"

    for path, title, pages, badge_color in (
        (
            old_path,
            "PDF Inspector - Diff Reordered (Revision A)",
            [draft, cover, summary, charts, appendix],
            ACCENT,
        ),
        (
            new_path,
            "PDF Inspector - Diff Reordered (Revision B)",
            [
                {**page, "rule_offset": 3.0}
                for page in (cover, summary, charts, appendix, release)
            ],
            HexColor("#0f766e"),
        ),
    ):
        doc = canvas.Canvas(path, pagesize=LETTER, invariant=1)
        _metadata(doc, title)
        for page in pages:
            _revision_page(
                doc,
                title=page["title"],
                subtitle=page["subtitle"],
                bullets=page["bullets"],
                footer=footer,
                badge_text=page.get("badge_text"),
                badge_color=badge_color if page.get("badge_text") else None,
                bars=page.get("bars", ()),
                rule_offset=page.get("rule_offset", 0.0),
            )
            doc.showPage()
        doc.save()


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    basic = os.path.join(OUT_DIR, "basic.pdf")
    large = os.path.join(OUT_DIR, "large.pdf")
    huge = os.path.join(OUT_DIR, "huge.pdf")
    annotations = os.path.join(OUT_DIR, "annotations.pdf")
    raw = os.path.join(OUT_DIR, "raw.pdf")
    diff_visual_old = os.path.join(OUT_DIR, "diff-visual-old.pdf")
    diff_visual_new = os.path.join(OUT_DIR, "diff-visual-new.pdf")
    diff_reordered_old = os.path.join(OUT_DIR, "diff-reordered-old.pdf")
    diff_reordered = os.path.join(OUT_DIR, "diff-reordered.pdf")

    build_basic(basic)
    build_large(large)
    build_huge(huge)
    build_annotations(annotations)
    build_raw(raw)
    build_diff_visual(diff_visual_old, diff_visual_new)
    build_diff_reordered(diff_reordered_old, diff_reordered)

    print(basic)
    print(large)
    print(huge)
    print(annotations)
    print(raw)
    print(diff_visual_old)
    print(diff_visual_new)
    print(diff_reordered_old)
    print(diff_reordered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
