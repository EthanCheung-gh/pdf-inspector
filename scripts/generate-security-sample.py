#!/usr/bin/env python3
"""Generate ``web-samples/security-sample.pdf`` deterministically.

The sample is a tiny, uncompressed PDF written with a minimal raw object
writer (the same technique as ``sidecar/__tests__/test_security.py``): no new
runtime dependency and no network access are needed.  It contains, on one
page:

* an embedded file (``notes.txt``) with a declared size and MIME type;
* JavaScript in ``/Names /JavaScript`` and in the catalog ``/OpenAction``;
* a URI link annotation action;
* an ``/AcroForm /XFA`` marker (a small XDP stream);
* a signature field with a ``/V`` signature dictionary and a ``/ByteRange``.

Because the writer is byte-for-byte deterministic, running this script twice
(and regenerating the committed fixture) produces identical output.  Run it
from anywhere: the default target is the repository's ``web-samples`` folder.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / 'web-samples' / 'security-sample.pdf'

PDF_HEADER = b'%PDF-1.7\n'
ATTACHMENT_TEXT = b'PDF Inspector security sample attachment.\n'
SIGNED_AT = 'D:20240101000000Z'


def _stream(data: bytes, attrs: bytes = b'') -> bytes:
    return (
        b'<< /Length %d ' % len(data)
        + attrs
        + b' >>\nstream\n'
        + data
        + b'\nendstream'
    )


def build_pdf() -> bytes:
    """Build the complete sample PDF as bytes."""
    content = b'BT /F1 20 Tf 72 700 Td (PDF Inspector security sample) Tj ET'
    xfa = (
        b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">'
        b'<template><subform name="form1"/></template></xdp:xdp>'
    )

    objects = [
        # 1: catalog with attachments, JavaScript, OpenAction and AcroForm.
        b'<< /Type /Catalog /Pages 2 0 R '
        b'/Names << /EmbeddedFiles 5 0 R /JavaScript 7 0 R >> '
        b'/OpenAction 8 0 R /AcroForm 10 0 R >>',
        # 2: page tree.
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        # 3: the page, with a font, content stream and one link annotation.
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
        b'/Resources << /Font << /F1 14 0 R >> >> '
        b'/Contents 4 0 R /Annots [12 0 R] >>',
        # 4: page content stream.
        _stream(content),
        # 5: /Names /EmbeddedFiles name tree.
        b'<< /Names [(' + b'notes.txt' + b') 6 0 R] >>',
        # 6: attachment file specification.
        b'<< /Type /Filespec /UF (notes.txt) /F (notes.txt) '
        b'/Desc (Sample embedded text file for the security CLI) '
        b'/EF << /F 15 0 R >> >>',
        # 7: /Names /JavaScript name tree.
        b'<< /Names [(security-sample) 9 0 R] >>',
        # 8: catalog OpenAction (JavaScript).
        b'<< /S /JavaScript /JS (app.alert\\(PDF Inspector security sample\\)) >>',
        # 9: named JavaScript action.
        b'<< /S /JavaScript '
        b'/JS (console.println\\(PDF Inspector security sample\\);) >>',
        # 10: AcroForm with a signature field and an XFA marker.
        b'<< /Fields [11 0 R] /XFA 13 0 R >>',
        # 11: signature field pointing at the page and a signature value.
        b'<< /FT /Sig /T (Approval) /V 16 0 R /P 3 0 R >>',
        # 12: URI link annotation (displayed only, never followed).
        b'<< /Type /Annot /Subtype /Link /Rect [72 620 300 640] '
        b'/Border [0 0 0] /A << /S /URI '
        b'/URI (https://example.com/pdf-inspector/security) >> >>',
        # 13: XFA form description stream.
        _stream(xfa),
        # 14: Standard 14 font so the page always has extractable text.
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        # 15: the embedded file stream.
        _stream(
            ATTACHMENT_TEXT,
            (
                b'/Type /EmbeddedFile /Subtype /text#2Fplain '
                b'/Params << /Size %d /ModDate (%s) >>'
            )
            % (len(ATTACHMENT_TEXT), SIGNED_AT.encode('ascii')),
        ),
        # 16: the signature value; never cryptographically verified.
        b'<< /Type /Sig /Name (Sample Signer) /M ('
        + SIGNED_AT.encode('ascii')
        + b') /Reason (Approval) /Location (Sample) '
        b'/SubFilter /adbe.pkcs7.detached /ByteRange [0 100 120 80] >>',
    ]

    out = bytearray(PDF_HEADER)
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % number + body + b'\nendobj\n'

    xref_position = len(out)
    out += b'xref\n0 %d\n' % (len(objects) + 1)
    out += b'0000000000 65535 f \n'
    for offset in offsets:
        out += b'%010d 00000 n \n' % offset
    out += (
        b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n'
        % (len(objects) + 1, xref_position)
    )
    return bytes(out)


def write_sample(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(build_pdf())
    return path


def main(argv: list[str]) -> int:
    if len(argv) > 2:
        sys.stderr.write('usage: generate-security-sample.py [OUTPUT.pdf]\n')
        return 2
    target = Path(argv[1]) if len(argv) == 2 else DEFAULT_OUTPUT
    write_sample(target)
    print(f'wrote {target}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
