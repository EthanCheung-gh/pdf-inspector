import { describe, expect, it } from 'vitest';
import { isRenderCancelled } from '../pdf-render';

describe('isRenderCancelled', () => {
  it('accepts the PDF.js RenderingCancelledException by name', () => {
    const error = new Error('Rendering cancelled, page 3');
    error.name = 'RenderingCancelledException';
    expect(isRenderCancelled(error)).toBe(true);
  });

  it('accepts the message prefix even when the class name was minified', () => {
    const error = new Error('Rendering cancelled, page 12');
    error.name = 'Iv';
    expect(isRenderCancelled(error)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isRenderCancelled(new Error('rendering cancelled, page 1'))).toBe(true);
  });

  it('does not swallow real render errors', () => {
    expect(isRenderCancelled(new Error('Invalid PDF structure'))).toBe(false);
    expect(isRenderCancelled(new Error('Rendering failed'))).toBe(false);
    expect(isRenderCancelled(null)).toBe(false);
    expect(isRenderCancelled('Rendering cancelled')).toBe(false);
  });
});
