"""Image preview payloads must be labelled with a format the renderer can display."""

import base64
import sys
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractor import PdfExtractor  # noqa: E402

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
JPX_SIGNATURES = (b"\x00\x00\x00\x0cjP  \r\n\x87\n", b"\xff\x4f\xff\x51")
JBIG2_SIGNATURE = b"\x97JB2\r\n\x1a\n"


def _image_bytes(fmt: str) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (4, 4), (200, 30, 30)).save(buffer, format=fmt)
    return buffer.getvalue()


def _decode(payload: dict) -> bytes:
    return base64.b64decode(payload["base64"])


def _single_image_pdf(path: Path, image_bytes: bytes, pdf_filter: str) -> str:
    """Hand-build a one-page PDF whose only XObject is `image_bytes` under `pdf_filter`."""
    content = b"q 100 0 0 100 50 50 cm /Im0 Do Q"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
        b"/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB "
        b"/BitsPerComponent 8 /Filter /" + pdf_filter.encode("ascii")
        + b" /Length %d >>\nstream\n" % len(image_bytes) + image_bytes + b"\nendstream",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % index + body + b"\nendobj\n"
    xref_offset = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref_offset,
    )
    path.write_bytes(bytes(out))
    return str(path)


@pytest.mark.parametrize(
    "data, expected",
    [
        (PNG_SIGNATURE + b"\x00" * 8, "png"),
        (b"\xff\xd8\xff\xe0" + b"\x00" * 8, "jpeg"),
        (b"GIF89a" + b"\x00" * 8, "gif"),
        (b"GIF87a" + b"\x00" * 8, "gif"),
        (b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 8, "webp"),
        (JPX_SIGNATURES[0] + b"\x00" * 8, "jpx"),
        (JPX_SIGNATURES[1] + b"\x00" * 8, "jpx"),
        (JBIG2_SIGNATURE + b"\x00" * 8, "jbig2"),
        (b"not an image at all", None),
        (b"", None),
    ],
)
def test_detect_image_format_signatures(data, expected):
    assert PdfExtractor._detect_image_format(data) == expected


@pytest.mark.parametrize(
    "fmt, expected",
    [("PNG", "png"), ("JPEG", "jpeg"), ("GIF", "gif"), ("WEBP", "webp")],
)
def test_browser_renderable_formats_pass_through_unchanged(fmt, expected):
    data = _image_bytes(fmt)
    payload = PdfExtractor._encode_for_preview(data)

    assert payload["format"] == expected
    assert _decode(payload) == data


@pytest.mark.parametrize("fmt", ["BMP", "TIFF"])
def test_non_renderable_formats_are_transcoded_to_png(fmt):
    try:
        data = _image_bytes(fmt)
    except OSError:  # Pillow built without that codec
        pytest.skip(f"Pillow cannot encode {fmt} in this build")

    payload = PdfExtractor._encode_for_preview(data)

    assert payload.get("error") is None
    assert payload["format"] == "png"
    decoded = _decode(payload)
    assert decoded.startswith(PNG_SIGNATURE)
    with Image.open(BytesIO(decoded)) as image:
        assert image.format == "PNG"
        assert image.size == (4, 4)


def test_undecodable_payload_reports_error_instead_of_mislabeled_bytes():
    payload = PdfExtractor._encode_for_preview(b"\x00\x01\x02 definitely not an image")

    assert "base64" not in payload
    assert payload["error"]


def test_jbig2_payload_that_pillow_cannot_decode_reports_error():
    payload = PdfExtractor._encode_for_preview(JBIG2_SIGNATURE + b"\x00" * 16)

    # Either Pillow decodes it (then it must be real PNG) or we surface an error.
    if "error" in payload:
        assert "base64" not in payload
    else:
        assert payload["format"] == "png"
        assert _decode(payload).startswith(PNG_SIGNATURE)


def test_embedded_jpeg_stream_passes_through(tmp_path):
    jpeg = _image_bytes("JPEG")
    path = _single_image_pdf(tmp_path / "dct.pdf", jpeg, "DCTDecode")

    extractor = PdfExtractor(path)
    try:
        page = extractor.extract_page(1)
        assert len(page["images"]) == 1
        payload = extractor.get_image_data(page["images"][0]["stream_id"])
    finally:
        extractor.close()

    assert payload["format"] == "jpeg"
    assert _decode(payload) == jpeg


def test_embedded_jpx_stream_is_transcoded_to_png(tmp_path):
    try:
        jpx = _image_bytes("JPEG2000")
    except OSError:  # Pillow built without openjpeg
        pytest.skip("Pillow cannot encode JPEG2000 in this build")

    path = _single_image_pdf(tmp_path / "jpx.pdf", jpx, "JPXDecode")

    extractor = PdfExtractor(path)
    try:
        page = extractor.extract_page(1)
        payload = extractor.get_image_data(page["images"][0]["stream_id"])
    finally:
        extractor.close()

    assert payload.get("error") is None
    assert payload["format"] == "png"
    with Image.open(BytesIO(_decode(payload))) as image:
        assert image.format == "PNG"
