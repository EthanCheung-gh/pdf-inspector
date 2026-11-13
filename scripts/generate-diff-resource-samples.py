#!/usr/bin/env python3
"""Generate the deterministic diff-resource sample pair.

Writes ``web-samples/diff-resources-old.pdf`` and
``web-samples/diff-resources-new.pdf`` with a minimal raw PDF writer (the same
technique as ``scripts/generate-security-sample.py``): no runtime dependency,
no network access, no compression and no clock.

Both revisions share the same page geometry, page content streams, font and
object numbers, so the object-level diff is empty.  Only document resources
differ, one of each supported kind:

* annotation: sticky-note ``/Contents`` and ``/C`` colour change;
* link: external ``/URI`` changes from ``/docs/v1`` to ``/docs/v2``;
* form: ``/AcroForm`` text widget value changes ``Alice`` -> ``Bob``;
* metadata: info ``/Title`` and ``/Author`` change;
* page labels: page 1 label changes ``i`` -> ``ii`` through a valid
  ``/PageLabels`` ``/Nums`` number tree.

Identity anchors (``/NM`` for annotations/links, the field name and widget rect
for forms) stay fixed, so the diff reports modifications instead of an
add/remove pair.  The output is byte-for-byte deterministic: running the
generator twice, or regenerating the committed fixtures, produces identical
files.

Run it from anywhere; the default target is the repository's ``web-samples``
folder.  Pass a directory to write both samples somewhere else.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = REPO_ROOT / 'web-samples'

PDF_HEADER = b'%PDF-1.7\n'
OLD_NAME = 'diff-resources-old.pdf'
NEW_NAME = 'diff-resources-new.pdf'

FIXED_DATE = b'D:20240101000000Z'
NOTE_DATE = b'D:20240101000000Z'
LINK_NM = b'link-docs'
NOTE_NM = b'note-review'
FIELD_NAME = b'customer_name'
FONT_NAME = b'Helv'

# Values that change between the two revisions.
OLD_TITLE = b'Diff Resources Sample - Revision A'
NEW_TITLE = b'Diff Resources Sample - Revision B'
OLD_AUTHOR = b'Alice Example'
NEW_AUTHOR = b'Bob Example'
OLD_NOTE = b'Reviewed in revision A. The page objects are identical.'
NEW_NOTE = b'Reviewed in revision B. The page objects are identical.'
OLD_NOTE_COLOR = b'[1 0.92 0.35]'
NEW_NOTE_COLOR = b'[0.85 0.92 1]'
OLD_URI = b'https://example.com/docs/v1'
NEW_URI = b'https://example.com/docs/v2'
OLD_FIELD_VALUE = b'Alice'
NEW_FIELD_VALUE = b'Bob'
OLD_LABEL_START = b'1'
NEW_LABEL_START = b'2'

# The page content is byte-identical in both revisions: only resources differ.
PAGE_ONE_CONTENT = (
    b'BT /F1 22 Tf 56 728 Td (PDF Inspector - diff resources sample) Tj ET\n'
    b'BT /F1 12 Tf 56 700 Td '
    b'(This page, its geometry and its content stream are identical in both revisions.) Tj ET\n'
    b'BT /F1 12 Tf 56 682 Td '
    b'(Only the document resources differ: annotation, link, form, metadata and page label.) Tj ET\n'
    b'BT /F1 11 Tf 56 640 Td (Form field: customer_name) Tj ET\n'
    b'q 0.94 g 56 610 300 24 re f Q\n'
    b'BT /F1 11 Tf 56 588 Td (Sticky note: annotation on this page) Tj ET\n'
    b'BT /F1 11 Tf 56 560 Td (External link: documentation) Tj ET\n'
    b'BT /F1 11 Tf 56 536 Td '
    b'(Metadata title/author and the page label also change between revisions.) Tj ET'
)

PAGE_TWO_CONTENT = (
    b'BT /F1 20 Tf 56 728 Td (Second page - unchanged) Tj ET\n'
    b'BT /F1 12 Tf 56 700 Td '
    b'(This page has no annotations and is unchanged in both revisions.) Tj ET'
)


def _stream(data: bytes, attrs: bytes = b'') -> bytes:
    return (
        b'<< /Length %d ' % len(data)
        + attrs
        + b' >>\nstream\n'
        + data
        + b'\nendstream'
    )


def _info(title: bytes, author: bytes) -> bytes:
    return (
        b'<< /Title ('
        + title
        + b') /Author ('
        + author
        + b') /Subject (Deterministic diff resource sample) '
        b'/Creator (scripts/generate-diff-resource-samples.py) '
        b'/Producer (PDF Inspector raw PDF writer) '
        b'/CreationDate ('
        + FIXED_DATE
        + b') /ModDate ('
        + FIXED_DATE
        + b') >>'
    )


def _page_labels(start: bytes) -> bytes:
    # Page 1 uses lowercase roman numerals (i -> ii); page 2 keeps the default
    # decimal label "1", which the collector omits because it equals the page
    # number.  Only the page 1 label therefore changes.
    return (
        b'<< /Nums [0 << /S /r /St '
        + start
        + b' >> 1 << /S /D /St 1 >>] >>'
    )


def _text_annotation(contents: bytes, color: bytes) -> bytes:
    return (
        b'<< /Type /Annot /Subtype /Text /Rect [72 580 94 602] '
        b'/NM ('
        + NOTE_NM
        + b') /T (Reviewer) /Contents ('
        + contents
        + b') /C '
        + color
        + b' /CA 1 /F 4 /M ('
        + NOTE_DATE
        + b') >>'
    )


def _uri_link(uri: bytes) -> bytes:
    return (
        b'<< /Type /Annot /Subtype /Link /Rect [144 552 300 574] '
        b'/Border [0 0 0] /NM ('
        + LINK_NM
        + b') /H /I /A << /S /URI /URI ('
        + uri
        + b') >> >>'
    )


def _text_widget(value: bytes) -> bytes:
    return (
        b'<< /Type /Annot /Subtype /Widget /Rect [56 610 356 634] '
        b'/P 3 0 R /F 4 /FT /Tx /T ('
        + FIELD_NAME
        + b') /V ('
        + value
        + b') /DV (Alice) /Ff 0 /DA (/Helv 12 Tf 0 0 0 rg) >>'
    )


def build_pdf(
    *,
    title: bytes,
    author: bytes,
    note: bytes,
    note_color: bytes,
    uri: bytes,
    field_value: bytes,
    label_start: bytes,
) -> bytes:
    """Build one complete sample revision as bytes."""
    objects = [
        # 1: catalog with an AcroForm and a PageLabels number tree.
        b'<< /Type /Catalog /Pages 2 0 R /AcroForm 10 0 R '
        b'/PageLabels 9 0 R /Lang (en-US) >>',
        # 2: page tree.
        b'<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
        # 3: page 1 with a fixed font and the three resource annotations.
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
        b'/Resources << /Font << /F1 8 0 R >> >> /Contents 4 0 R '
        b'/Annots [11 0 R 12 0 R 13 0 R] >>',
        # 4: page 1 content stream (identical in both revisions).
        _stream(PAGE_ONE_CONTENT),
        # 5: page 2 without annotations.
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
        b'/Resources << /Font << /F1 8 0 R >> >> /Contents 6 0 R >>',
        # 6: page 2 content stream (identical in both revisions).
        _stream(PAGE_TWO_CONTENT),
        # 7: document information dictionary.
        _info(title, author),
        # 8: Standard 14 font for extractable text and the form /DR.
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica '
        b'/Encoding /WinAnsiEncoding >>',
        # 9: PageLabels number tree.
        _page_labels(label_start),
        # 10: AcroForm with the single text widget field.
        b'<< /Fields [13 0 R] /DA (/Helv 0 Tf 0 g) '
        b'/DR << /Font << /Helv 8 0 R >> >> >>',
        # 11: sticky-note annotation.
        _text_annotation(note, note_color),
        # 12: external link annotation (displayed only, never followed).
        _uri_link(uri),
        # 13: form text widget.
        _text_widget(field_value),
    ]

    out = bytearray(PDF_HEADER)
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % number + body + b'\nendobj\n'

    xref_position = len(out)
    out += b'xref\n0 %d\n' % (len(objects) + 1)
    out += b'0000000000 65535 f \n'
    for offset in offsets:
        out += b'%010d 00000 n \n' % offset
    out += (
        b'trailer\n<< /Size %d /Root 1 0 R /Info 7 0 R >>\nstartxref\n%d\n%%%%EOF\n'
        % (len(objects) + 1, xref_position)
    )
    return bytes(out)


def build_old_pdf() -> bytes:
    """Revision A: note colour/content, URI v1, field Alice, labels i, title A."""
    return build_pdf(
        title=OLD_TITLE,
        author=OLD_AUTHOR,
        note=OLD_NOTE,
        note_color=OLD_NOTE_COLOR,
        uri=OLD_URI,
        field_value=OLD_FIELD_VALUE,
        label_start=OLD_LABEL_START,
    )


def build_new_pdf() -> bytes:
    """Revision B: note colour/content, URI v2, field Bob, labels ii, title B."""
    return build_pdf(
        title=NEW_TITLE,
        author=NEW_AUTHOR,
        note=NEW_NOTE,
        note_color=NEW_NOTE_COLOR,
        uri=NEW_URI,
        field_value=NEW_FIELD_VALUE,
        label_start=NEW_LABEL_START,
    )


SAMPLES = (
    (OLD_NAME, build_old_pdf),
    (NEW_NAME, build_new_pdf),
)


def write_samples(directory: Path) -> list[Path]:
    """Write both samples into ``directory`` and return their paths."""
    directory.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for name, builder in SAMPLES:
        path = directory / name
        path.write_bytes(builder())
        written.append(path)
    return written


def main(argv: list[str]) -> int:
    if len(argv) > 2:
        sys.stderr.write('usage: generate-diff-resource-samples.py [OUTPUT_DIR]\n')
        return 2
    directory = Path(argv[1]) if len(argv) == 2 else DEFAULT_OUTPUT_DIR
    for path in write_samples(directory):
        print(f'wrote {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
