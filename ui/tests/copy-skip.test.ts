// The copy dialog's Skip field: what the user types ⇄ the index tuples
// `copy()`'s `skip` option takes. A single-direction copy (and every circular
// one) names instances by index; a grid names cells as bracketed pairs, and a
// bare index there names a whole row — the kernel matches a coordinate only as
// far as it is stated.
import { describe, it, expect } from 'vitest';
import {
  formatSkipEntries, parseSkipEntries, skipRangeError,
} from '../src/interactive/create-feature/copy-skip';

/** The entries a field text parses to, or the test blows up on the error. */
function entries(text: string, arity = 1): number[][] {
  const result = parseSkipEntries(text, arity);
  if ('error' in result) {
    throw new Error(`refused "${text}": ${result.error}`);
  }
  return result;
}

describe('parseSkipEntries', () => {
  it('reads an empty field as no skip at all', () => {
    expect(entries('')).toEqual([]);
    expect(entries('   ')).toEqual([]);
  });

  it('reads comma-separated indices as single-index tuples', () => {
    expect(entries('1, 3')).toEqual([[1], [3]]);
    expect(entries('0,2,4')).toEqual([[0], [2], [4]]);
  });

  it('takes spaces and semicolons as separators too', () => {
    expect(entries('1 3')).toEqual([[1], [3]]);
    expect(entries('1; 3')).toEqual([[1], [3]]);
    // Punctuation the user is mid-typing names nothing, so it skips nothing.
    expect(entries('1, ')).toEqual([[1]]);
  });

  it('reads a grid cell as a bracketed tuple', () => {
    expect(entries('[1, 0], [2, 1]', 2)).toEqual([[1, 0], [2, 1]]);
    expect(entries('[1,0][2,1]', 2)).toEqual([[1, 0], [2, 1]]);
  });

  it('keeps a bare index in a grid — it names that whole row', () => {
    expect(entries('[1, 0], 2', 2)).toEqual([[1, 0], [2]]);
  });

  it('collapses a cell named twice', () => {
    expect(entries('1, 1, 3')).toEqual([[1], [3]]);
    expect(entries('[1, 0], [1, 0]', 2)).toEqual([[1, 0]]);
  });

  it('refuses anything that is not a whole index', () => {
    for (const text of ['a', '1.5', '-1', '1..2', 'count - 1', '[1, x]']) {
      expect(parseSkipEntries(text, 2), text).toMatchObject({ error: expect.any(String) });
    }
  });

  it('refuses a cell wider than the copy has directions', () => {
    expect(parseSkipEntries('[1, 0]', 1)).toMatchObject({ error: expect.any(String) });
    expect(parseSkipEntries('[1, 0, 2]', 2)).toMatchObject({ error: expect.any(String) });
  });
});

describe('formatSkipEntries', () => {
  it('writes a lone index bare and a cell bracketed', () => {
    expect(formatSkipEntries([[1], [3]])).toBe('1, 3');
    expect(formatSkipEntries([[1, 0], [2, 1]])).toBe('[1, 0], [2, 1]');
    expect(formatSkipEntries([])).toBe('');
  });

  it('round-trips the statement skip lists an edit dialog opens on', () => {
    const cases: { skip: number[][]; arity: number }[] = [
      { skip: [[1], [3]], arity: 1 },
      { skip: [[1, 0], [2]], arity: 2 },
    ];
    for (const { skip, arity } of cases) {
      expect(parseSkipEntries(formatSkipEntries(skip), arity)).toEqual(skip);
    }
  });
});

describe('skipRangeError', () => {
  it('passes indices the pattern has', () => {
    expect(skipRangeError([[1], [3]], [4])).toBeNull();
    expect(skipRangeError([[2, 1]], [3, 2])).toBeNull();
  });

  it('catches an index past its direction count', () => {
    expect(skipRangeError([[4]], [4])).toContain('past the count of 4');
    expect(skipRangeError([[0, 2]], [3, 2])).toContain('direction 2');
  });

  it('leaves a count it cannot resolve unchecked', () => {
    // The count field holds an expression — the kernel ignores a stray index
    // either way, so the dialog does not guess at one.
    expect(skipRangeError([[99]], [null])).toBeNull();
  });
});
