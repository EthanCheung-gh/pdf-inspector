#!/usr/bin/env python3
"""Generate the deterministic tagged-PDF accessibility samples.

Both samples are written with a minimal raw PDF writer (the same technique as
``scripts/generate-security-sample.py`` and the sidecar test fixtures): no new
runtime dependency, no network access and no compression.  The output is
byte-for-byte reproducible, so regenerating the committed fixtures produces no
diff.

``accessibility-valid.pdf``
    One page with ``/StructTreeRoot``, ``/ParentTree``, page ``/StructParents``
    and a structure tree::

        Document
          H1
          P
          Figure (/Alt)
          Table
            TR
              TH (/Scope /Column)
              TD

    Every content item is a real marked-content sequence (MCID 0-4), so the
    file opens and extracts text in pdfplumber.  The audit reports no
    accessibility finding for it.

``accessibility-broken.pdf``
    One page with a structure tree that exercises the common PDF/UA problems::

        Document
          H1
          H3                 (heading level skipped)
          Figure             (no /Alt)
          L                  (no LI)
            P
          Table              (no TR)
            TD

    It has no ``/ParentTree`` and no page ``/StructParents``.

Run it from anywhere; the default target is the repository's ``web-samples``
folder.  Pass a directory to write both samples somewhere else.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = REPO_ROOT / 'web-samples'

PDF_HEADER = b'%PDF-1.7\n'
VALID_NAME = 'accessibility-valid.pdf'
BROKEN_NAME = 'accessibility-broken.pdf'

VALID_TEXT = (
    (b'Quarterly report', 18, 720),
    (b'Revenue grew by twelve percent.', 12, 690),
    (b'Figure: revenue by quarter', 12, 660),
    (b'Quarter', 12, 630),
    (b'Q1', 12, 600),
)

BROKEN_TEXT = (
    (b'Quarterly report', 18, 720),
    (b'Revenue grew by twelve percent.', 12, 690),
    (b'Figure without alternative text', 12, 660),
    (b'Item without a list structure', 12, 630),
    (b'Q1', 12, 600),
)

INFO = (
    b'<< /Title (%s) /Author (PDF Inspector) '
    b'/Producer (PDF Inspector sample generator) /Lang (en-US) >>'
)


def _stream(data: bytes, attrs: bytes = b'') -> bytes:
    return (
        b'<< /Length %d ' % len(data)
        + attrs
        + b' >>\nstream\n'
        + data
        + b'\nendstream'
    )


def _content(lines, tags) -> bytes:
    """Marked-content text lines: one ``/<tag> <</MCID n>> BDC`` per line."""
    out = bytearray()
    for mcid, (tag, (text, size, y)) in enumerate(zip(tags, lines)):
        out += b'/%s <</MCID %d>> BDC\n' % (tag, mcid)
        out += (
            b'BT /F1 %d Tf 72 %d Td (' % (size, y)
            + text
            + b') Tj ET\n'
        )
        out += b'EMC\n'
    return bytes(out)


def _write_pdf(objects: list[bytes], trailer_extra: bytes = b'') -> bytes:
    """Numbered (1-based) uncompressed objects with a classic xref table."""
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
    trailer = b'trailer\n<< /Size %d /Root 1 0 R' % (len(objects) + 1)
    if trailer_extra:
        trailer += b' ' + trailer_extra
    out += trailer + b' >>\nstartxref\n%d\n%%%%EOF\n' % xref_position
    return bytes(out)


def build_valid_pdf() -> bytes:
    """The fully tagged sample (no expected accessibility findings)."""
    objects = [
        # 1: catalog.
        b'<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 5 0 R '
        b'/MarkInfo << /Marked true >> /Lang (en-US) '
        b'/ViewerPreferences << /DisplayDocTitle true >> >>',
        # 2: page tree.
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        # 3: the page, pointing at its structure parents.
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
        b'/Resources << /Font << /F1 15 0 R >> >> /Contents 4 0 R '
        b'/StructParents 0 >>',
        # 4: marked-content page stream.
        _stream(_content(VALID_TEXT, (b'H1', b'P', b'Figure', b'TH', b'TD'))),
        # 5: structure tree root with a ParentTree.
        b'<< /Type /StructTreeRoot /K [6 0 R] /ParentTree 16 0 R '
        b'/ParentTreeNextKey 1 >>',
        # 6: Document.
        b'<< /Type /StructElem /S /Document /Pg 3 0 R '
        b'/K [7 0 R 8 0 R 9 0 R 10 0 R] >>',
        # 7: H1.
        b'<< /Type /StructElem /S /H1 /Pg 3 0 R /K 0 >>',
        # 8: P.
        b'<< /Type /StructElem /S /P /Pg 3 0 R /K 1 >>',
        # 9: Figure with alternative text.
        b'<< /Type /StructElem /S /Figure /Pg 3 0 R '
        b'/Alt (Revenue by quarter: Q1 is 42 percent of the total.) /K 2 >>',
        # 10: Table.
        b'<< /Type /StructElem /S /Table /Pg 3 0 R /K [11 0 R] >>',
        # 11: TR.
        b'<< /Type /StructElem /S /TR /Pg 3 0 R /K [12 0 R 13 0 R] >>',
        # 12: TH with a scope.
        b'<< /Type /StructElem /S /TH /Pg 3 0 R '
        b'/A << /O /Table /Scope /Column >> /K 3 >>',
        # 13: TD.
        b'<< /Type /StructElem /S /TD /Pg 3 0 R /K 4 >>',
        # 14: document information dictionary.
        INFO % b'Accessibility sample - valid',
        # 15: Standard 14 font for extractable text.
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica '
        b'/Encoding /WinAnsiEncoding >>',
        # 16: ParentTree mapping each MCID to its structure element.
        b'<< /Nums [0 [7 0 R] 1 [8 0 R] 2 [9 0 R] 3 [12 0 R] 4 [13 0 R]] >>',
    ]
    return _write_pdf(objects, trailer_extra=b'/Info 14 0 R')


def build_broken_pdf() -> bytes:
    """The deliberately broken sample (one finding per common PDF/UA problem)."""
    objects = [
        # 1: catalog; tagged, but no /ParentTree in the structure root.
        b'<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 5 0 R '
        b'/MarkInfo << /Marked true >> /Lang (en-US) '
        b'/ViewerPreferences << /DisplayDocTitle true >> >>',
        # 2: page tree.
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        # 3: the page; no /StructParents on purpose.
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
        b'/Resources << /Font << /F1 15 0 R >> >> /Contents 4 0 R >>',
        # 4: marked-content page stream.
        _stream(_content(BROKEN_TEXT, (b'H1', b'H3', b'Figure', b'P', b'TD'))),
        # 5: structure tree root without a ParentTree.
        b'<< /Type /StructTreeRoot /K [6 0 R] >>',
        # 6: Document.
        b'<< /Type /StructElem /S /Document /Pg 3 0 R '
        b'/K [7 0 R 8 0 R 9 0 R 10 0 R 11 0 R] >>',
        # 7: H1.
        b'<< /Type /StructElem /S /H1 /Pg 3 0 R /K 0 >>',
        # 8: H3 (H1 -> H3 skips a level).
        b'<< /Type /StructElem /S /H3 /Pg 3 0 R /K 1 >>',
        # 9: Figure without /Alt.
        b'<< /Type /StructElem /S /Figure /Pg 3 0 R /K 2 >>',
        # 10: L whose only child is a P (no LI).
        b'<< /Type /StructElem /S /L /Pg 3 0 R /K [12 0 R] >>',
        # 11: Table whose only child is a TD (no TR).
        b'<< /Type /StructElem /S /Table /Pg 3 0 R /K [13 0 R] >>',
        # 12: P inside L.
        b'<< /Type /StructElem /S /P /Pg 3 0 R /K 3 >>',
        # 13: TD inside Table.
        b'<< /Type /StructElem /S /TD /Pg 3 0 R /K 4 >>',
        # 14: document information dictionary.
        INFO % b'Accessibility sample - broken',
        # 15: Standard 14 font for extractable text.
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica '
        b'/Encoding /WinAnsiEncoding >>',
    ]
    return _write_pdf(objects, trailer_extra=b'/Info 14 0 R')


SAMPLES = (
    (VALID_NAME, build_valid_pdf),
    (BROKEN_NAME, build_broken_pdf),
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
        sys.stderr.write('usage: generate-accessibility-samples.py [OUTPUT_DIR]\n')
        return 2
    directory = Path(argv[1]) if len(argv) == 2 else DEFAULT_OUTPUT_DIR
    for path in write_samples(directory):
        print(f'wrote {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
