import { describe, expect, it } from 'vitest';
import { TimelineHistory } from '../src/fluidcad-server/timeline-history.ts';
import type { TimelineEntry, TimelineRow } from '../../lib/common/timeline.js';

const FILE = '/workspace/model.part.js';
function row(code: string, text: string, id: string, type = 'extrude', parentId: string | null = null): TimelineRow {
  const offset = code.indexOf(text);
  if (offset < 0) throw new Error(`Missing fixture call ${text}`);
  const prefix = code.slice(0, offset).split('\n');
  return { id, name: id, type, uniqueType: type, parentId, isContainer: type === 'part',
    sourceLocation: { filePath: FILE, line: prefix.length, column: prefix.at(-1)!.length + 1 } };
}
function pending(entries: TimelineEntry[] | undefined): TimelineRow[] {
  return (entries ?? []).flatMap(e => e.kind === 'unevaluated' ? [e.row] : []);
}

describe('retained breakpoint timeline', () => {
  it('has no invented rows on a cold pause and isolates/deletes sessions', async () => {
    const history = new TimelineHistory();
    const code = 'extrude(1); fillet(2);';
    const rows = [row(code, 'extrude', 'a'), row(code, 'fillet', 'b', 'fillet')];
    expect(await history.update('cold', rows.slice(0, 1), true, () => code)).toBeUndefined();
    await history.update('a', rows, false, () => code);
    expect(await history.update('b', [], true, () => code)).toBeUndefined();
    history.delete('a');
    expect(await history.update('a', [], true, () => code)).toBeUndefined();
  });

  it('retains computed labels for any feature kind, without geometry or stale build status', async () => {
    const history = new TimelineHistory();
    const code = 'extrude(1); brandNewFeature().name(label);';
    const paused = 'extrude(1); breakpoint(); brandNewFeature().name(label);';
    const old = { ...row(code, 'brandNewFeature', 'b', 'brand-new'), name: 'Computed label',
      object: { geometry: true }, sceneShapes: [{ vertices: [1, 2, 3] }],
      hasError: true, fromCache: true, buildDurationMs: 80 };
    await history.update('a', [row(code, 'extrude', 'a'), old], false, () => code);
    const live = [row(paused, 'extrude', 'new-a')];
    const entries = await history.update('a', live, true, () => paused);
    expect(entries?.[0]).toEqual({ kind: 'evaluated', index: 0 });
    expect(pending(entries)).toEqual([{ ...row(paused, 'brandNewFeature', 'b', 'brand-new'),
      name: 'Computed label', hideChildren: undefined, internal: undefined }]);
    expect(live).toHaveLength(1);
    expect(history.get('a')).toBe(entries);
  });

  it('keeps a paused part tail under its new id and later built top-level rows live', async () => {
    const history = new TimelineHistory();
    const code = "part('A', () => { extrude(1); fillet(2); }); sphere(3);";
    const paused = code.replace('fillet', 'breakpoint(); fillet');
    await history.update('a', [row(code, 'part', 'p', 'part'), row(code, 'extrude', 'e', 'extrude', 'p'),
      row(code, 'fillet', 'f', 'fillet', 'p'), row(code, 'sphere', 's', 'sphere')], false, () => code);
    const entries = await history.update('a', [row(paused, 'part', 'new-p', 'part'),
      row(paused, 'extrude', 'new-e', 'extrude', 'new-p'), row(paused, 'sphere', 'new-s', 'sphere')], true, () => paused);
    expect(entries?.map(e => e.kind === 'evaluated' ? e.index : e.row.id)).toEqual([0, 1, 'f', 2]);
    expect(pending(entries)[0].parentId).toBe('new-p');
  });

  it('retains whole missing containers and their children in the same order', async () => {
    const history = new TimelineHistory();
    const code = "extrude(1); part('B', () => { fillet(2); hole(3); }); sphere(4);";
    const paused = code.replace('part', 'breakpoint(); part');
    const rows = [row(code, 'extrude', 'e'), row(code, 'part', 'p', 'part'),
      row(code, 'fillet', 'f', 'fillet', 'p'), row(code, 'hole', 'h', 'hole', 'p'), row(code, 'sphere', 's', 'sphere')];
    await history.update('a', rows, false, () => code);
    const entries = await history.update('a', [row(paused, 'extrude', 'new-e')], true, () => paused);
    expect(entries?.map(e => e.kind === 'evaluated' ? e.index : e.row.id)).toEqual([0, 'p', 'f', 'h', 's']);
  });

  it('follows line shifts and new prefix statements across repeated paused edits', async () => {
    const history = new TimelineHistory();
    const code = 'extrude(1);\nfillet(2);';
    await history.update('a', [row(code, 'extrude', 'e'), row(code, 'fillet', 'f', 'fillet')], false, () => code);
    for (const prefix of ['breakpoint();\n', 'sphere(3);\nbreakpoint();\n']) {
      const paused = prefix + code;
      const entries = await history.update('a', [], true, () => paused);
      expect(pending(entries).map(r => r.id)).toEqual(['e', 'f']);
      expect(pending(entries)[1].sourceLocation).toEqual(row(paused, 'fillet', 'f').sourceLocation);
    }
  });

  it('drops deleted/edited calls and the descendants of deleted containers', async () => {
    const history = new TimelineHistory();
    const code = "part('A', () => { fillet(2); }); extrude(1); hole(3);";
    await history.update('a', [row(code, 'part', 'p', 'part'), row(code, 'fillet', 'f', 'fillet', 'p'),
      row(code, 'extrude', 'e'), row(code, 'hole', 'h', 'hole')], false, () => code);
    const paused = 'breakpoint(); fillet(2); extrude(5); hole(3);';
    expect(pending(await history.update('a', [], true, () => paused)).map(r => r.id)).toEqual(['h']);
  });

  it('does not guess between identical statements after a source edit', async () => {
    const history = new TimelineHistory();
    const code = 'extrude(1);\nextrude(1);';
    const rows = [row(code, 'extrude', 'a'), { ...row(code, 'extrude', 'b'), sourceLocation: { filePath: FILE, line: 2, column: 1 } }];
    await history.update('a', rows, false, () => code);
    expect(pending(await history.update('a', [], true, () => 'breakpoint();\n' + code))).toEqual([]);
  });

  it('matches runtime occurrences and does not duplicate evaluated rows', async () => {
    const history = new TimelineHistory();
    const code = 'for (let i = 0; i < 2; i++) { extrude(i); }';
    const a = row(code, 'extrude', 'a');
    const b = { ...a, id: 'b', sourceLocation: { ...a.sourceLocation!, occurrence: 1 } };
    await history.update('a', [a, b], false, () => code);
    const entries = await history.update('a', [{ ...a, id: 'new-a' }, { ...b, id: 'new-b' }], true, () => code);
    expect(entries).toEqual([{ kind: 'evaluated', index: 0 }, { kind: 'evaluated', index: 1 }]);
  });

  it('replaces old history on completion and respects unavailable source', async () => {
    const history = new TimelineHistory();
    const code = 'extrude(1); fillet(2);';
    await history.update('a', [row(code, 'extrude', 'e'), row(code, 'fillet', 'f', 'fillet')], false, () => code);
    await history.update('a', [row(code, 'extrude', 'new-e')], false, () => 'extrude(1);');
    expect(history.get('a')).toBeUndefined();
    expect(pending(await history.update('a', [], true, () => 'breakpoint(); extrude(1);')).map(r => r.id)).toEqual(['new-e']);
    expect(pending(await history.update('a', [], true, () => null))).toEqual([]);
  });
});
