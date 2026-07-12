import { describe, expect, it } from 'vitest';
import { pathToFileUrl } from '../path-utils';

describe('pathToFileUrl', () => {
  it('handles ASCII Linux path', () => {
    expect(pathToFileUrl('/home/user/doc.pdf')).toBe('file:///home/user/doc.pdf');
  });

  it('handles Chinese characters in path', () => {
    expect(pathToFileUrl('/home/用户/doc.pdf')).toBe(
      'file:///home/%E7%94%A8%E6%88%B7/doc.pdf',
    );
  });

  it('handles Japanese characters in path', () => {
    expect(pathToFileUrl('/Users/ユーザ/doc.pdf')).toBe(
      'file:///Users/%E3%83%A6%E3%83%BC%E3%82%B6/doc.pdf',
    );
  });

  it('handles spaces in path', () => {
    expect(pathToFileUrl('/home/user/my doc.pdf')).toBe(
      'file:///home/user/my%20doc.pdf',
    );
  });

  it('encodes # character in path', () => {
    expect(pathToFileUrl('/home/user/#report.pdf')).toBe(
      'file:///home/user/%23report.pdf',
    );
  });

  it('encodes ? character in path', () => {
    expect(pathToFileUrl('/home/user/report?.pdf')).toBe(
      'file:///home/user/report%3F.pdf',
    );
  });

  it('handles Windows drive letter', () => {
    expect(pathToFileUrl('C:\\docs\\report.pdf')).toBe(
      'file:///C%3A/docs/report.pdf',
    );
  });

  it('handles Windows path with Chinese and special chars', () => {
    expect(pathToFileUrl('C:\\文档\\# report?.pdf')).toBe(
      'file:///C%3A/%E6%96%87%E6%A1%A3/%23%20report%3F.pdf',
    );
  });

  it('handles Windows path with backslashes', () => {
    expect(pathToFileUrl('D:\\data\\test\\file.pdf')).toBe(
      'file:///D%3A/data/test/file.pdf',
    );
  });

  it('handles empty path segments (root path)', () => {
    expect(pathToFileUrl('/')).toBe('file:///');
  });

  it('does not double-encode already-encoded percent sequences', () => {
    expect(pathToFileUrl('/home/user/file%20name.pdf')).toBe(
      'file:///home/user/file%2520name.pdf',
    );
  });
});
