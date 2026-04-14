/**
 * Normalize a file path to use forward slashes and uppercase drive letter.
 * No-op on Unix. On Windows, converts backslashes to forward slashes
 * and uppercases the drive letter to match Vite's internal module graph keying.
 */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  if (slashed.length >= 2 && slashed[1] === ':') {
    return slashed[0].toUpperCase() + slashed.slice(1);
  }
  return slashed;
}
