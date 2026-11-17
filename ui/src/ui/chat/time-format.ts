// Times as the Agent panel words them: the chats menu's "5 min ago" and a
// plan limit's "resets in 3 h, at 17:00", always in the user's own time zone
// and locale (the engine stores and sends ISO instants only).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else the date. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const ago = now.getTime() - date.getTime();
  if (ago < MINUTE) {
    return 'just now';
  }
  if (ago < HOUR) {
    return `${Math.floor(ago / MINUTE)} min ago`;
  }
  if (sameDay(date, now)) {
    return `${Math.floor(ago / HOUR)} h ago`;
  }
  const days = calendarDaysBetween(date, now);
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 7) {
    return `${days} days ago`;
  }
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/**
 * When a plan limit resets, relative and in local time: "resets in 3 h, at
 * 17:00", "resets in 25 min, at 16:40", "resets tomorrow at 09:00", "resets
 * in 3 days, on Fri at 09:00". Null for a time that is not a date; "resets
 * any moment now" once it has passed.
 */
export function resetsText(iso: string, now: Date = new Date()): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const left = date.getTime() - now.getTime();
  if (left <= 0) {
    return 'resets any moment now';
  }
  const at = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay(date, now) || left < 12 * HOUR) {
    return `resets in ${duration(left)}, at ${at}`;
  }
  const days = calendarDaysBetween(now, date);
  if (days === 1) {
    return `resets tomorrow at ${at}`;
  }
  const day = days < 7 ? date.toLocaleDateString([], { weekday: 'short' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `resets in ${days} days, on ${day} at ${at}`;
}

/** "25 min", "3 h", "3 h 20 min" (rounded up to the minute: never "0 min"). */
export function duration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 || hours >= 10 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Text the runtime wrote before reset times were sent apart from the words
 * ("…; it resets at 2026-11-17T16:00:00.000Z."): every ISO instant in it
 * read as a local reset time, so a stored notice stays readable.
 */
export function localizeIsoInstants(text: string, now: Date = new Date()): string {
  return text.replace(
    /(?:[Ii]t )?resets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/g,
    (match, iso: string) => {
      const words = resetsText(iso, now);
      if (!words) {
        return match;
      }
      return match[0] === 'I' ? `It ${words}` : match.startsWith('it ') ? `it ${words}` : words;
    },
  );
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

/** Midnights between `from` and `to`, in local time (0 on the same day). */
function calendarDaysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / DAY);
}
