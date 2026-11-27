// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionGroupKind } from '../src/api';
import { expandDoubleClick } from '../src/interactive/pick-expansion';
import { PickSelection } from '../src/interactive/pick-selection';
import { SelectionContextMenu } from '../src/interactive/selection-menu';
import type { SelectedEntity } from '../src/viewer';
import { FakeSelectionServer } from './fixtures/fake-selection-server';

// Loops in the viewport (surface step 09). A double-click on an edge of a
// surface's open rim takes the rim loop it belongs to — a loaded surface
// too, which has no bucket — and any other pick its classified bucket, by
// one rule every pick dialog shares. A loop group the right-click menu
// offers previews on hover like any other, and a dialog that keeps chains
// keeps a chosen loop whole and sends it with `kind: 'loop'`, as it keeps a
// tangent chain.

let server: FakeSelectionServer;

beforeEach(() => {
  server = new FakeSelectionServer().install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const edge = (index: number, shapeId = 'sheet'): SelectedEntity => ({ shapeId, sub: { type: 'edge', index } });
const face = (index: number, shapeId = 'block'): SelectedEntity => ({ shapeId, sub: { type: 'face', index } });

describe('the double-click rule', () => {
  it('takes the rim loop of a surface edge, and asks for no bucket', async () => {
    server.loop = () => ({ rim: true, members: [edge(1), edge(2), edge(5)] });
    expect(await expandDoubleClick(edge(2))).toEqual({ kind: 'loop', members: [edge(1), edge(2), edge(5)] });
    expect(server.count('api/selection/expand-bucket')).toBe(0);
  });

  it('takes the rim loop of a loaded surface, which has no bucket', async () => {
    server.loop = () => ({ rim: true, members: [edge(0), edge(3)] });
    expect(await expandDoubleClick(edge(3))).toEqual({ kind: 'loop', members: [edge(0), edge(3)] });
  });

  it('expands any other edge to its bucket, as before', async () => {
    server.bucket = () => ({ members: [edge(4, 'block'), edge(6, 'block')] });
    const before = { index: 2, type: 'extrude', line: 5, column: 0 };
    expect(await expandDoubleClick(edge(4, 'block'), before)).toEqual({ kind: 'bucket', members: [edge(4, 'block'), edge(6, 'block')] });
    // Both questions are asked against the edit session's boundary.
    expect(server.requests.map(r => r.route)).toEqual(['api/selection/expand-loop', 'api/selection/expand-bucket']);
    expect(server.requests.map(r => r.body)).toEqual([{ entity: edge(4, 'block'), before }, { entity: edge(4, 'block'), before }]);
  });

  it('expands a face to its bucket without asking about a rim', async () => {
    server.bucket = () => ({ members: [face(1), face(2)] });
    expect(await expandDoubleClick(face(1))).toEqual({ kind: 'bucket', members: [face(1), face(2)] });
    expect(server.count('api/selection/expand-loop')).toBe(0);
  });

  it('falls through to the bucket when the rim question fails, and passes the bucket\'s refusal on', async () => {
    server.loop = () => ({ error: 'stale boundary' });
    server.bucket = (entity) => entity.shapeId === 'block' ? { members: [edge(4, 'block')] } : { error: 'this pick has no classified bucket to expand to' };
    expect(await expandDoubleClick(edge(4, 'block'))).toEqual({ kind: 'bucket', members: [edge(4, 'block')] });
    expect(await expandDoubleClick(edge(7))).toEqual({ error: 'this pick has no classified bucket to expand to' });
  });
});

describe('a loop chain in the pick set', () => {
  it('is sent with its kind, beside a tangent chain sent with its own', () => {
    const picks = new PickSelection();
    picks.addChain(edge(2), [edge(1), edge(2), edge(5)], 'loop');
    picks.addChain(edge(8, 'block'), [edge(8, 'block'), edge(9, 'block')]);
    expect(picks.apiChains()).toEqual([
      { seed: edge(2), members: [edge(1), edge(2), edge(5)], kind: 'loop' },
      { seed: edge(8, 'block'), members: [edge(8, 'block'), edge(9, 'block')], kind: 'tangent' },
    ]);
    expect(picks.chipRows().map(row => row.label)).toEqual(['Loop (3 edges)', 'Tangent chain (2 edges)']);
  });

  it('reads as connected faces when it holds faces', () => {
    const picks = new PickSelection();
    picks.addChain(face(1), [face(1), face(2)], 'loop');
    expect(picks.chipRows()).toEqual([{ label: 'Connected faces (2 faces)', members: [face(1), face(2)] }]);
  });

  it('goes whole when one of its members is clicked off, as a tangent chain does', () => {
    const picks = new PickSelection();
    picks.toggle(edge(9, 'block'));
    picks.addChain(edge(2), [edge(1), edge(2), edge(5)], 'loop');
    picks.toggle(edge(5));
    expect(picks.entities).toEqual([edge(9, 'block')]);
    expect(picks.chains).toEqual([]);
  });

  it('stays one chain when the same loop is chosen twice, and replaces a chain it overlaps', () => {
    const picks = new PickSelection();
    picks.addChain(edge(1), [edge(1), edge(2)]);
    picks.addChain(edge(2), [edge(1), edge(2), edge(5)], 'loop');
    picks.addChain(edge(5), [edge(1), edge(2), edge(5)], 'loop');
    expect(picks.entities).toEqual([edge(1), edge(2), edge(5)]);
    expect(picks.apiChains()).toEqual([{ seed: edge(5), members: [edge(1), edge(2), edge(5)], kind: 'loop' }]);
  });
});

describe('the right-click menu', () => {
  async function open(kinds: SelectionGroupKind[]) {
    server.groups = [
      { kind: 'tangent', label: 'Tangent Edges', members: [edge(2), edge(5)] },
      { kind: 'loop', label: 'Boundary Loop', members: [edge(1), edge(2), edge(5)] },
      { kind: 'loop', label: 'Outer Loop of Freeform Face', members: [edge(1), edge(2), edge(5), edge(6)] },
      { kind: 'same-type', label: 'All Splines', members: [edge(1), edge(2)] },
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const previews: (SelectedEntity[] | null)[] = [];
    const chosen: unknown[] = [];
    const menu = new SelectionContextMenu(container, 'test-menu', {
      kinds,
      onSelectGroup: (kind, seed, members) => chosen.push({ kind, seed, members }),
      onPreview: (members) => previews.push(members),
    });
    await menu.open(edge(2), 10, 10);
    const items = [...container.querySelectorAll<HTMLButtonElement>('#test-menu button')];
    return { items, labels: items.map(b => b.textContent), previews, chosen };
  }

  it('lists the loop groups of a consumer that offers them, in the server\'s order', async () => {
    const { labels } = await open(['tangent', 'loop', 'classified', 'same-type', 'equal', 'sibling']);
    expect(labels).toEqual(['Tangent Edges (2)', 'Boundary Loop (3)', 'Outer Loop of Freeform Face (4)', 'All Splines (2)']);
  });

  it('leaves them out for a consumer that does not', async () => {
    const { labels } = await open(['tangent', 'classified', 'sibling']);
    expect(labels).toEqual(['Tangent Edges (2)']);
  });

  it('previews a loop on hover and hands it over as a loop group on click', async () => {
    const { items, previews, chosen } = await open(['tangent', 'loop']);
    const boundary = items.find(b => b.textContent === 'Boundary Loop (3)')!;
    boundary.dispatchEvent(new MouseEvent('mouseenter'));
    expect(previews.at(-1)).toEqual([edge(1), edge(2), edge(5)]);
    boundary.click();
    expect(chosen).toEqual([{ kind: 'loop', seed: edge(2), members: [edge(1), edge(2), edge(5)] }]);
    // Closing the menu ends the preview.
    expect(previews.at(-1)).toBeNull();
  });
});
