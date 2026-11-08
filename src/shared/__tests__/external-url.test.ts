import { describe, expect, it } from 'vitest';
import {
  UNSAFE_EXTERNAL_URL_ERROR,
  isSafeExternalUrl,
  toSafeExternalUrl,
} from '../external-url';

/** Targets that must never reach an OS/browser opener. */
const UNSAFE_URLS = [
  '',
  '   ',
  '\t\n',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'java\nscript:alert(1)',
  'data:text/html,<b>x</b>',
  'file:///etc/passwd',
  'mailto:user@example.com',
  'ftp://example.com/file.pdf',
  'tel:+123456',
  'about:blank',
  'blob:https://example.com/1234',
  '/relative/path',
  'relative.html',
  './relative.html',
  '//example.com/path',
  'http://example.com/\u0000',
  'https://example.com/\u0007',
];

describe('isSafeExternalUrl', () => {
  it('accepts absolute http(s) URLs only', () => {
    for (const url of [
      'http://example.com',
      'https://example.com',
      'https://example.com/path?q=1#top',
      'HTTPS://EXAMPLE.COM',
      '  http://example.com/padded  ',
    ]) {
      expect(isSafeExternalUrl(url)).toBe(true);
    }
  });

  it('rejects non-http schemes, relative and control-character targets', () => {
    for (const url of UNSAFE_URLS) {
      expect(isSafeExternalUrl(url)).toBe(false);
    }
  });

  it('rejects non-string values instead of throwing', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(isSafeExternalUrl(value)).toBe(false);
    }
  });
});

describe('toSafeExternalUrl', () => {
  it('returns the trimmed URL that will actually be opened', () => {
    expect(toSafeExternalUrl('  https://example.com/a?b=1  ')).toBe(
      'https://example.com/a?b=1',
    );
  });

  it('returns null for every refused target', () => {
    for (const url of UNSAFE_URLS) {
      expect(toSafeExternalUrl(url)).toBeNull();
    }
    expect(toSafeExternalUrl(null)).toBeNull();
    expect(toSafeExternalUrl(undefined)).toBeNull();
  });

  it('exposes one message for refused URLs', () => {
    expect(UNSAFE_EXTERNAL_URL_ERROR).toBe('Only absolute http(s) links can be opened');
  });
});
