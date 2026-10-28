import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_PDF_BYTES,
  buildTempPdfPath,
  cleanupDownloadedFiles,
  deleteDownloadedFile,
  downloadPdfToFile,
  parsePdfUrl,
  resetDownloadedFilesForTests,
} from '../pdf-url';

// A Windows-style locked file cannot be simulated portably, so `unlink` can be
// made to fail on demand. Everything else stays the real implementation.
const fsHarness = vi.hoisted(() => ({ blockUnlink: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: async (filePath: string) => {
      if (fsHarness.blockUnlink) {
        const error = new Error(
          `EPERM: operation not permitted, unlink '${filePath}'`,
        ) as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return actual.unlink(filePath);
    },
  };
});

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');

let tempDir: string;
const servers: http.Server[] = [];

/** Start a local HTTP server on an ephemeral port and return its base URL. */
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Test server has no port');
  }

  return `http://127.0.0.1:${address.port}`;
}

function hashOf(href: string): string {
  return createHash('sha256').update(href).digest('hex').slice(0, 8);
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-url-test-'));
  fsHarness.blockUnlink = false;
  resetDownloadedFilesForTests();
});

afterEach(async () => {
  // closeAllConnections() prevents a hanging test from blocking the teardown:
  // the timeout test leaves an open socket that close() alone would await.
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );

  resetDownloadedFilesForTests();
  await rm(tempDir, { recursive: true, force: true });
});

describe('MAX_PDF_BYTES', () => {
  it('caps a download at 100 MiB', () => {
    expect(MAX_PDF_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe('parsePdfUrl', () => {
  it('accepts http and https URLs and trims surrounding whitespace', () => {
    const url = parsePdfUrl('  https://example.com/docs/report.pdf?token=abc#page=2  ');

    expect(url.href).toBe('https://example.com/docs/report.pdf?token=abc#page=2');
    expect(parsePdfUrl('http://example.com/a.pdf').protocol).toBe('http:');
  });

  it('rejects empty input with a friendly message', () => {
    expect(() => parsePdfUrl('')).toThrow('Enter a valid http(s) URL');
    expect(() => parsePdfUrl('   ')).toThrow('Enter a valid http(s) URL');
  });

  it('rejects input that is not an absolute URL', () => {
    expect(() => parsePdfUrl('example.com/report.pdf')).toThrow('Enter a valid http(s) URL');
    expect(() => parsePdfUrl('not a url')).toThrow('Enter a valid http(s) URL');
  });

  it('rejects every non-http(s) protocol', () => {
    expect(() => parsePdfUrl('ftp://example.com/report.pdf')).toThrow(
      'Only http(s) URLs are supported',
    );
    expect(() => parsePdfUrl('file:///etc/passwd')).toThrow('Only http(s) URLs are supported');
    expect(() => parsePdfUrl('data:application/pdf;base64,JVBERi0=')).toThrow(
      'Only http(s) URLs are supported',
    );
    expect(() => parsePdfUrl('javascript:alert(1)')).toThrow('Only http(s) URLs are supported');
  });
});

describe('buildTempPdfPath', () => {
  it('sanitizes the URL basename and appends a hash of the full URL', () => {
    const url = parsePdfUrl('https://example.com/docs/My%20Report%20(1).pdf?token=abc#page=2');
    const result = buildTempPdfPath(tempDir, url);

    expect(path.dirname(result)).toBe(tempDir);
    expect(path.basename(result)).toBe(`MyReport1-${hashOf(url.href)}.pdf`);
  });

  it('is stable for the same URL and different for different URLs', () => {
    const first = parsePdfUrl('https://example.com/report.pdf');
    const other = parsePdfUrl('https://example.com/other-report.pdf');

    expect(buildTempPdfPath(tempDir, first)).toBe(buildTempPdfPath(tempDir, first));
    expect(buildTempPdfPath(tempDir, first)).not.toBe(buildTempPdfPath(tempDir, other));
  });

  it('falls back to document.pdf when the path has no usable name', () => {
    const root = parsePdfUrl('https://example.com/');
    const directoryLike = parsePdfUrl('http://example.com/dir/');

    expect(path.basename(buildTempPdfPath(tempDir, root))).toBe(`document-${hashOf(root.href)}.pdf`);
    expect(path.basename(buildTempPdfPath(tempDir, directoryLike))).toBe(
      `document-${hashOf(directoryLike.href)}.pdf`,
    );
  });

  it('adds a .pdf suffix and does not duplicate an existing one', () => {
    const withoutExtension = parsePdfUrl('https://example.com/download');
    const withExtension = parsePdfUrl('https://example.com/report.PDF');

    expect(path.basename(buildTempPdfPath(tempDir, withoutExtension))).toMatch(
      /^download-[0-9a-f]{8}\.pdf$/,
    );
    expect(path.basename(buildTempPdfPath(tempDir, withExtension))).toMatch(
      /^report-[0-9a-f]{8}\.pdf$/,
    );
  });

  it('never lets encoded path traversal escape the directory', () => {
    const url = parsePdfUrl('https://example.com/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
    const result = buildTempPdfPath(tempDir, url);
    const base = path.basename(result);

    expect(path.dirname(result)).toBe(tempDir);
    expect(base).not.toContain('/');
    expect(base).not.toContain('\\');
    expect(base).not.toContain('..');
    expect(base).toMatch(/^etcpasswd-[0-9a-f]{8}\.pdf$/);
  });

  it('caps the URL-derived stem', () => {
    const url = parsePdfUrl(`https://example.com/${'a'.repeat(150)}.pdf`);

    expect(path.basename(buildTempPdfPath(tempDir, url))).toBe(
      `${'a'.repeat(60)}-${hashOf(url.href)}.pdf`,
    );
  });
});

describe('downloadPdfToFile', () => {
  it('writes the body to a temp file and tracks it for cleanup', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': String(PDF_BYTES.length),
      });
      res.end(PDF_BYTES);
    });
    const url = parsePdfUrl(`${base}/files/report.pdf`);
    const directory = path.join(tempDir, 'pdf-inspector');

    const filePath = await downloadPdfToFile(url, { directory });

    // The destination directory is created on demand and the name carries the
    // URL hash, so two downloads cannot collide.
    expect(path.dirname(filePath)).toBe(directory);
    expect(path.basename(filePath)).toMatch(/^report-[0-9a-f]{8}\.pdf$/);
    expect(path.basename(filePath)).toContain(hashOf(url.href));
    await expect(readFile(filePath)).resolves.toEqual(PDF_BYTES);

    // Tracked: cleanup removes it (this is what the quit path relies on).
    await cleanupDownloadedFiles();
    expect(existsSync(filePath)).toBe(false);
  });

  it('follows redirects', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/moved') {
        res.writeHead(302, { location: '/report.pdf' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF_BYTES);
    });

    const filePath = await downloadPdfToFile(parsePdfUrl(`${base}/moved`), {
      directory: tempDir,
    });

    await expect(readFile(filePath)).resolves.toEqual(PDF_BYTES);
  });

  it('never overwrites an existing file at the preferred path', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF_BYTES);
    });
    const url = parsePdfUrl(`${base}/report.pdf`);

    // The preferred name is already taken: same URL downloaded earlier and
    // possibly still open in the sidecar.
    const preferred = buildTempPdfPath(tempDir, url);
    await writeFile(preferred, 'sentinel');

    const downloaded = await downloadPdfToFile(url, { directory: tempDir });

    expect(downloaded).not.toBe(preferred);
    expect(downloaded).toBe(`${preferred.slice(0, -'.pdf'.length)}-1.pdf`);
    // The existing file keeps its bytes; the new download is a separate file.
    await expect(readFile(preferred, 'utf8')).resolves.toBe('sentinel');
    await expect(readFile(downloaded)).resolves.toEqual(PDF_BYTES);

    // Only the new download is tracked, so cleanup leaves the sentinel alone.
    await cleanupDownloadedFiles();
    expect(existsSync(downloaded)).toBe(false);
    expect(existsSync(preferred)).toBe(true);
  });

  it('increments the suffix until it finds a free name', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF_BYTES);
    });
    const url = parsePdfUrl(`${base}/report.pdf`);

    const preferred = buildTempPdfPath(tempDir, url);
    const stem = preferred.slice(0, -'.pdf'.length);
    await writeFile(preferred, 'sentinel-0');
    await writeFile(`${stem}-1.pdf`, 'sentinel-1');

    const downloaded = await downloadPdfToFile(url, { directory: tempDir });

    expect(downloaded).toBe(`${stem}-2.pdf`);
    await expect(readFile(preferred, 'utf8')).resolves.toBe('sentinel-0');
    await expect(readFile(`${stem}-1.pdf`, 'utf8')).resolves.toBe('sentinel-1');
  });

  it('gives repeated downloads of the same URL distinct paths', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF_BYTES);
    });
    const url = parsePdfUrl(`${base}/report.pdf`);

    const first = await downloadPdfToFile(url, { directory: tempDir });
    const second = await downloadPdfToFile(url, { directory: tempDir });

    expect(first).not.toBe(second);
    for (const filePath of [first, second]) {
      expect(path.basename(filePath)).toContain(hashOf(url.href));
      await expect(readFile(filePath)).resolves.toEqual(PDF_BYTES);
    }

    // Both downloads are tracked, so neither is left behind on quit.
    await cleanupDownloadedFiles();
    expect(await readdir(tempDir)).toEqual([]);
  });

  it('gives concurrent downloads of the same URL distinct paths', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF_BYTES);
    });
    const url = parsePdfUrl(`${base}/report.pdf`);

    const paths = await Promise.all([
      downloadPdfToFile(url, { directory: tempDir }),
      downloadPdfToFile(url, { directory: tempDir }),
    ]);

    // Exclusive creation ('wx') makes the reservation atomic: even a race
    // cannot hand the same path to two downloads.
    expect(new Set(paths).size).toBe(2);
    for (const filePath of paths) {
      await expect(readFile(filePath)).resolves.toEqual(PDF_BYTES);
    }

    await cleanupDownloadedFiles();
    expect(await readdir(tempDir)).toEqual([]);
  });

  it('rejects a non-OK status and leaves no file behind', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });

    await expect(
      downloadPdfToFile(parsePdfUrl(`${base}/missing.pdf`), { directory: tempDir }),
    ).rejects.toThrow(/Download failed with HTTP 404/);

    expect(await readdir(tempDir)).toEqual([]);
  });

  it('deletes the downloaded file when the body is not a PDF', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('<html>please log in</html>');
    });

    await expect(
      downloadPdfToFile(parsePdfUrl(`${base}/login`), { directory: tempDir }),
    ).rejects.toThrow('The downloaded file is not a PDF');

    expect(await readdir(tempDir)).toEqual([]);
  });

  it('accepts a PDF header inside the first 1024 bytes (preamble)', async () => {
    const preamble = Buffer.from('GIF89a mail-preamble junk\n', 'latin1');
    const body = Buffer.concat([preamble, PDF_BYTES]);
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(body);
    });

    const filePath = await downloadPdfToFile(parsePdfUrl(`${base}/preamble.pdf`), {
      directory: tempDir,
    });

    await expect(readFile(filePath)).resolves.toEqual(body);
  });

  it('accepts a UTF-8 BOM before the header', async () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), PDF_BYTES]);
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(body);
    });

    await expect(
      downloadPdfToFile(parsePdfUrl(`${base}/bom.pdf`), { directory: tempDir }),
    ).resolves.toBeTypeOf('string');
  });

  it('rejects a PDF header beyond the first 1024 bytes', async () => {
    // Readers do not scan past the header window, so neither do we.
    const body = Buffer.concat([Buffer.alloc(1100, 0x41), PDF_BYTES]);
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(body);
    });

    await expect(
      downloadPdfToFile(parsePdfUrl(`${base}/late-header.pdf`), { directory: tempDir }),
    ).rejects.toThrow('The downloaded file is not a PDF');

    expect(await readdir(tempDir)).toEqual([]);
  });

  it('rejects an empty body and leaves no file behind', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '0' });
      res.end();
    });

    await expect(
      downloadPdfToFile(parsePdfUrl(`${base}/empty.pdf`), { directory: tempDir }),
    ).rejects.toThrow('The downloaded file is not a PDF');

    expect(await readdir(tempDir)).toEqual([]);
  });

  it('rejects a declared content-length above the cap', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '2048' });
      res.end(Buffer.alloc(2048, 0x20));
    });

    await expect(
      downloadPdfToFile(parsePdfUrl(`${base}/big.pdf`), { directory: tempDir, maxBytes: 1024 }),
    ).rejects.toThrow(/larger than the 1024 byte limit/);

    expect(await readdir(tempDir)).toEqual([]);
  });

  it('caps a streamed body even without content-length', async () => {
    const base = await serve((_req, res) => {
      // No content-length header: Node sends the body chunked.
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.on('error', () => {});
      res.write(PDF_BYTES);
      res.write(Buffer.alloc(4096, 0x41));
      res.end();
    });

    await expect(
      downloadPdfToFile(parsePdfUrl(`${base}/stream.pdf`), { directory: tempDir, maxBytes: 1024 }),
    ).rejects.toThrow(/larger than the 1024 byte limit/);

    expect(await readdir(tempDir)).toEqual([]);
  });

  it('times out when the server never responds', async () => {
    const base = await serve(() => {
      // Never respond, never end.
    });

    await expect(
      downloadPdfToFile(parsePdfUrl(`${base}/hang.pdf`), { directory: tempDir, timeoutMs: 50 }),
    ).rejects.toThrow('Download timed out after 50ms');

    expect(await readdir(tempDir)).toEqual([]);
  });

  it('times out mid-download and deletes the partial file', async () => {
    const base = await serve((_req, res) => {
      res.on('error', () => {});
      // Headers plus a partial body, then nothing: the abort lands while the
      // response body is still streaming.
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.write(PDF_BYTES);
    });

    await expect(
      downloadPdfToFile(parsePdfUrl(`${base}/slow.pdf`), { directory: tempDir, timeoutMs: 50 }),
    ).rejects.toThrow('Download timed out after 50ms');

    expect(await readdir(tempDir)).toEqual([]);
  });

  it('does not delete an earlier download when a retry fails before writing', async () => {
    let status = 200;
    const base = await serve((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/pdf' });
      res.end(status === 200 ? PDF_BYTES : 'boom');
    });
    const url = parsePdfUrl(`${base}/report.pdf`);

    const first = await downloadPdfToFile(url, { directory: tempDir });
    expect(existsSync(first)).toBe(true);

    // Same URL: the retry fails before it reserves a path, so the copy the
    // sidecar may still have open survives untouched.
    status = 500;
    await expect(downloadPdfToFile(url, { directory: tempDir })).rejects.toThrow(/HTTP 500/);

    expect(existsSync(first)).toBe(true);
    expect(await readFile(first)).toEqual(PDF_BYTES);
    expect(await readdir(tempDir)).toEqual([path.basename(first)]);
  });
});

describe('downloaded file tracking', () => {
  async function servePdf(): Promise<string> {
    return serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF_BYTES);
    });
  }

  it('deleteDownloadedFile removes the file and stops tracking it', async () => {
    const base = await servePdf();
    const filePath = await downloadPdfToFile(parsePdfUrl(`${base}/tracked.pdf`), {
      directory: tempDir,
    });

    await deleteDownloadedFile(filePath);
    expect(existsSync(filePath)).toBe(false);

    // A replacement written at the same path must survive cleanup: the path is
    // no longer tracked, so cleanup never touches it again.
    await writeFile(filePath, 'replacement');
    await cleanupDownloadedFiles();
    expect(existsSync(filePath)).toBe(true);
  });

  it('ignores files that are already gone', async () => {
    await expect(deleteDownloadedFile(path.join(tempDir, 'gone.pdf'))).resolves.toBeUndefined();
    await expect(cleanupDownloadedFiles()).resolves.toBeUndefined();
  });

  it('keeps a file it could not delete tracked so cleanup can retry', async () => {
    const base = await servePdf();
    const filePath = await downloadPdfToFile(parsePdfUrl(`${base}/locked.pdf`), {
      directory: tempDir,
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fsHarness.blockUnlink = true;
      await deleteDownloadedFile(filePath);

      // Locked (think: the sidecar still has it open on Windows): the file is
      // still there and, crucially, still tracked instead of being leaked.
      expect(existsSync(filePath)).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      fsHarness.blockUnlink = false;
      errorSpy.mockRestore();
    }

    await cleanupDownloadedFiles();
    expect(existsSync(filePath)).toBe(false);
  });

  it('cleanupDownloadedFiles deletes everything tracked', async () => {
    const base = await servePdf();
    const first = await downloadPdfToFile(parsePdfUrl(`${base}/first.pdf`), { directory: tempDir });
    const second = await downloadPdfToFile(parsePdfUrl(`${base}/second.pdf`), {
      directory: tempDir,
    });

    expect(first).not.toBe(second);

    await cleanupDownloadedFiles();

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(await readdir(tempDir)).toEqual([]);
  });
});
