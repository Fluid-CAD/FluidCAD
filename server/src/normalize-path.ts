/**
 * Normalize a file path to use forward slashes.
 * No-op on Unix. On Windows, converts backslashes to forward slashes
 * to match Vite's internal module graph keying.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}
