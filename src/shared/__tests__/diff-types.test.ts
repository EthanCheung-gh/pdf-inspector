import { describe, expect, it } from 'vitest';
import { diffOptionsToRpc, isFileSource } from '../diff-types';

describe('diffOptionsToRpc', () => {
  it('returns an empty object when no options are given', () => {
    expect(diffOptionsToRpc()).toEqual({});
    expect(diffOptionsToRpc(null)).toEqual({});
    expect(diffOptionsToRpc({})).toEqual({});
  });

  it('maps every camelCase field to its snake_case RPC name', () => {
    expect(
      diffOptionsToRpc({
        positionTolerance: 2.5,
        textTolerance: 'case-insensitive',
        ignoreTypes: ['image', 'char'],
        ignoreFonts: true,
        ignoreColors: true,
        ignoreImages: true,
      }),
    ).toEqual({
      position_tolerance: 2.5,
      text_tolerance: 'case-insensitive',
      ignore_types: ['image', 'char'],
      ignore_fonts: true,
      ignore_colors: true,
      ignore_images: true,
    });
  });

  it('forwards only the provided fields so the engine keeps its defaults', () => {
    expect(diffOptionsToRpc({ ignoreImages: false })).toEqual({ ignore_images: false });
  });

  it('copies ignoreTypes so later mutation cannot alter a sent request', () => {
    const ignoreTypes: ('image' | 'table')[] = ['image'];
    const rpc = diffOptionsToRpc({ ignoreTypes });

    ignoreTypes.push('table');

    expect(rpc.ignore_types).toEqual(['image']);
  });
});

describe('isFileSource', () => {
  it('treats a string as a file path, not a File', () => {
    expect(isFileSource('/tmp/a.pdf')).toBe(false);
  });

  it('recognises a browser File', () => {
    const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });
    expect(isFileSource(file)).toBe(true);
  });
});
