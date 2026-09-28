/**
 * The start screen's small print: how long ago a project was opened, a path
 * shortened against the home directory, and download sizes.
 */

/** "Opened 5 min ago" and the like, for a card's footer. Empty for an unreadable date. */
export function openedAgo(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) {
    return '';
  }
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 60) {
    return 'Opened just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `Opened ${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `Opened ${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  if (days === 1) {
    return 'Opened yesterday';
  }
  if (days < 30) {
    return `Opened ${days} days ago`;
  }
  return `Opened ${new Date(iso).toLocaleDateString()}`;
}

/** `~/cad/bracket` for a path under `home`; any other path unchanged. Both separators count. */
export function shortenPath(full: string, home: string): string {
  if (home && (full === home || full.startsWith(`${home}/`) || full.startsWith(`${home}\\`))) {
    return `~${full.slice(home.length)}`;
  }
  return full;
}

/** Bytes as "12.3 MB", the unit the download progress speaks in. */
export function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
