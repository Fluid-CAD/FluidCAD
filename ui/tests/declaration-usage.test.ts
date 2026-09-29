// The wording the parameter and property dialogs share for a delete: the
// server's plan put into a sentence — what the reads become and which
// overrides go, or why the delete is refused.

import { describe, expect, it } from 'vitest';
import { describeDeletionPlan } from '../src/ui/declaration-usage';

const FILE = '/ws/parts/plate.part.js';
const FRAME = '/ws/frame.assembly.js';

describe('describeDeletionPlan', () => {
  it('says plainly that only the declaration goes when nothing reads it', () => {
    const wording = describeDeletionPlan('parameter', 'Width', { value: '100', replaced: [], dropped: [], blocked: [] });
    expect(wording).toEqual({ blocked: false, text: 'Delete “Width”? Its declaration is removed from the code.' });
  });

  it('names the reads that take the default, per file, and the overrides that go', () => {
    const wording = describeDeletionPlan('parameter', 'Width', {
      value: '100',
      replaced: [{ filePath: FILE, count: 2, lines: [8, 11] }, { filePath: FRAME, count: 1, lines: [9] }],
      dropped: [{ filePath: FRAME, count: 2, lines: [4, 5] }],
      blocked: [],
    });
    expect(wording.blocked).toBe(false);
    expect(wording.text).toBe(
      'Delete “Width”? Its 3 reads in plate.part.js (lines 8, 11) and frame.assembly.js (line 9) become its default value 100, '
      + 'and the Width override on 2 inserts in frame.assembly.js (lines 4, 5) is dropped.',
    );
  });

  it('leads with the overrides when nothing is read', () => {
    const wording = describeDeletionPlan('parameter', 'Width', {
      value: '100', replaced: [], dropped: [{ filePath: FRAME, count: 1, lines: [4] }], blocked: [],
    });
    expect(wording.text).toBe('Delete “Width”? The Width override on one insert in frame.assembly.js (line 4) is dropped.');
  });

  it('reads right for a single read of a property, and marks a truncated line list', () => {
    const one = describeDeletionPlan('property', 'boltCount', {
      value: '4', replaced: [{ filePath: FRAME, count: 1, lines: [6] }], dropped: [], blocked: [],
    });
    expect(one.text).toBe('Delete “boltCount”? Its read in frame.assembly.js (line 6) becomes its value 4.');
    const many = describeDeletionPlan('property', 'boltCount', {
      value: '4', replaced: [{ filePath: FRAME, count: 7, lines: [1, 2, 3, 4, 5] }], dropped: [], blocked: [],
    });
    expect(many.text).toContain('Its 7 reads in frame.assembly.js (lines 1, 2, 3, 4, 5, …) become its value 4.');
  });

  it('blocks the delete, naming the reads to rewrite, when the value cannot replace them', () => {
    const wording = describeDeletionPlan('property', 'pocketDiameter', {
      value: 'width - 2 * wall',
      replaced: [{ filePath: FILE, count: 1, lines: [3] }],
      dropped: [],
      blocked: [{ filePath: '/ws/parts/plug.part.js', count: 1, lines: [5] }, { filePath: FRAME, count: 2, lines: [6, 7] }],
    });
    expect(wording.blocked).toBe(true);
    expect(wording.text).toBe(
      '“pocketDiameter” cannot be deleted yet. Its value (width - 2 * wall) reads names that are out of scope in '
      + 'plug.part.js (line 5) and frame.assembly.js (lines 6, 7). Rewrite those reads by hand, then delete the property.',
    );
  });

  it('blocks a declaration with no value to put in place of its reads', () => {
    const wording = describeDeletionPlan('parameter', 'Width', {
      value: null, replaced: [], dropped: [], blocked: [{ filePath: FILE, count: 1, lines: [8] }],
    });
    expect(wording.blocked).toBe(true);
    expect(wording.text).toContain('It has no value to put in place of its reads in plate.part.js (line 8).');
  });
});
