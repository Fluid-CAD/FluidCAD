import { describe, expect, it } from 'vitest';
import { duration, localizeIsoInstants, relativeTime, resetsText } from '../src/ui/chat/time-format';
import { compactCount, usageText } from '../src/ui/chat/usage';

// How the Agent panel words times and usage: the chats menu's "5 min ago",
// a plan limit's "resets in 3 h, at 17:00" in the user's own time, and a
// turn's tokens.

const at = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

describe('relativeTime', () => {
  const now = new Date(2026, 10, 17, 15, 30);
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('says how long ago, coarser the older it is', () => {
    expect(relativeTime(before(20_000), now)).toBe('just now');
    expect(relativeTime(before(5 * 60_000), now)).toBe('5 min ago');
    expect(relativeTime(before(3 * 3600_000), now)).toBe('3 h ago');
    expect(relativeTime(new Date(2026, 10, 16, 9, 0).toISOString(), now)).toBe('yesterday');
    expect(relativeTime(new Date(2026, 10, 13, 9, 0).toISOString(), now)).toBe('4 days ago');
    expect(relativeTime(new Date(2026, 9, 2, 9, 0).toISOString(), now)).toBe(
      new Date(2026, 9, 2, 9, 0).toLocaleDateString([], { month: 'short', day: 'numeric' }),
    );
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('resetsText', () => {
  const now = new Date(2026, 10, 17, 14, 0);

  it('is relative and local: in hours and minutes today, then the day', () => {
    const soon = new Date(2026, 10, 17, 17, 0).toISOString();
    expect(resetsText(soon, now)).toBe(`resets in 3 h, at ${at(soon)}`);
    const half = new Date(2026, 10, 17, 14, 25).toISOString();
    expect(resetsText(half, now)).toBe(`resets in 25 min, at ${at(half)}`);
    const tomorrow = new Date(2026, 10, 18, 9, 0).toISOString();
    expect(resetsText(tomorrow, now)).toBe(`resets tomorrow at ${at(tomorrow)}`);
    const friday = new Date(2026, 10, 20, 9, 0);
    expect(resetsText(friday.toISOString(), now)).toBe(
      `resets in 3 days, on ${friday.toLocaleDateString([], { weekday: 'short' })} at ${at(friday.toISOString())}`,
    );
    const later = new Date(2026, 10, 30, 9, 0);
    expect(resetsText(later.toISOString(), now)).toBe(
      `resets in 13 days, on ${later.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${at(later.toISOString())}`,
    );
    expect(resetsText(new Date(2026, 10, 17, 13, 0).toISOString(), now)).toBe('resets any moment now');
    expect(resetsText('2026-99', now)).toBeNull();
  });

  it('never says "0 min"', () => {
    expect(duration(1)).toBe('1 min');
    expect(duration(90 * 60_000)).toBe('1 h 30 min');
    expect(duration(11 * 3600_000 + 5 * 60_000)).toBe('11 h');
  });

  it('rewrites the raw instants older notices carry', () => {
    const iso = new Date(2026, 10, 17, 17, 0).toISOString();
    expect(localizeIsoInstants(`Limit reached; it resets at ${iso}.`, now)).toBe(`Limit reached; it resets in 3 h, at ${at(iso)}.`);
    expect(localizeIsoInstants(`You've hit your usage limit. It resets at ${iso}.`, now)).toBe(
      `You've hit your usage limit. It resets in 3 h, at ${at(iso)}.`,
    );
    expect(localizeIsoInstants('Nothing to change.', now)).toBe('Nothing to change.');
  });
});

describe('usageText', () => {
  it('counts compactly, with the exact figures in the long form', () => {
    expect(compactCount(950)).toBe('950');
    expect(compactCount(1000)).toBe('1k');
    expect(compactCount(12_400)).toBe('12k');
    expect(compactCount(1_250_000)).toBe('1.3M');
    expect(usageText({ inputTokens: 1500, outputTokens: 20 })).toEqual({
      short: '1.5k in · 20 out',
      long: 'This turn used 1,500 input tokens (the context it re-read included), 20 output tokens.',
    });
    expect(usageText({})).toBeNull();
  });

  it('shows a cost only when each use is billed', () => {
    expect(usageText({ outputTokens: 5, costUsd: 0.004 })!.short).toBe('5 out');
    expect(usageText({ outputTokens: 5, costUsd: 0.004 }, { billed: true })!.short).toBe('5 out · <$0.01');
    expect(usageText({ outputTokens: 5, costUsd: 1.234 }, { billed: true })!.long).toMatch(/\$1\.23 billed to the API key/);
  });
});
