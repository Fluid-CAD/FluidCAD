import { describe, expect, it } from 'vitest';
import { megabytes, openedAgo, shortenPath } from '../../src/start/format';

describe('start screen formatting', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('says how long ago a project was opened', () => {
    expect(openedAgo(ago(20_000), now)).toBe('Opened just now');
    expect(openedAgo(ago(5 * 60_000), now)).toBe('Opened 5 min ago');
    expect(openedAgo(ago(3 * 3_600_000), now)).toBe('Opened 3 h ago');
    expect(openedAgo(ago(26 * 3_600_000), now)).toBe('Opened yesterday');
    expect(openedAgo(ago(9 * 86_400_000), now)).toBe('Opened 9 days ago');
    expect(openedAgo('not a date', now)).toBe('');
  });

  it('shortens paths under home with either separator', () => {
    expect(shortenPath('/home/you/cad/bracket', '/home/you')).toBe('~/cad/bracket');
    expect(shortenPath('C:\\Users\\you\\cad', 'C:\\Users\\you')).toBe('~\\cad');
    expect(shortenPath('/home/youth/cad', '/home/you')).toBe('/home/youth/cad');
    expect(shortenPath('/srv/cad', '')).toBe('/srv/cad');
  });

  it('prints megabytes to one decimal', () => {
    expect(megabytes(12_400_000)).toBe('11.8 MB');
  });
});
