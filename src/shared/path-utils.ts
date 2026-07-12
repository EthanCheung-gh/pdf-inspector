/**
 * Convert an OS-native absolute file path to a file:// URL.
 *
 * Handles:
 * - Backslash separators (Windows)
 * - Non-ASCII characters via encodeURIComponent on each segment
 * - Special URL characters (#, ?, %) in the path
 * - Windows drive letters (e.g., C:)
 */
export function pathToFileUrl(path: string): string {
  let normalized = path.replace(/\\/g, '/');

  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }

  const encodedPath = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `file://${encodedPath}`;
}
