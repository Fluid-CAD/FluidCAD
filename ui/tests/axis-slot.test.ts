// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AxisSlotControl } from '../src/interactive/create-feature/axis-slot';

// The axis slot shared by every axis-picking dialog: no quick buttons — a
// standard axis arrives only from the viewport (a world axis, a sketch
// datum) or from a kept statement literal — and the chip/prompt follows the
// selection state machine. Every slot takes a connector too (its Z axis),
// re-found by its site after renders, and an edit whose own axis is one
// shows that connector's chip while keeping its text.

function make(opts?: ConstructorParameters<typeof AxisSlotControl>[1]) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const control = new AxisSlotControl(host, opts);
  return { host, control };
}

function chipText(host: HTMLElement): string {
  return host.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function clickRemove(host: HTMLElement): void {
  const remove = [...host.querySelectorAll('button')].find(b => b.textContent === '✕');
  expect(remove).toBeDefined();
  remove!.click();
}

describe('AxisSlotControl', () => {
  it('renders no quick buttons — only the slot and its prompt', () => {
    const { host, control } = make();
    expect(control.selection).toBeNull();
    expect(host.querySelectorAll('button').length).toBe(0);
    expect(chipText(host)).toContain('Pick a world axis, an axis, an edge or a connector');
  });

  it('shows a picked world axis as the standard chip', () => {
    const { host, control } = make();
    control.selectStandard('y');
    expect(control.selection).toEqual({ kind: 'standard', axis: 'y' });
    expect(chipText(host)).toContain('World Y axis');
  });

  it('reads a kept world-axis literal as the standard selection', () => {
    const { host, control } = make();
    control.seedKeep("'z'");
    expect(control.selection).toEqual({ kind: 'standard', axis: 'z' });
    expect(chipText(host)).toContain('World Z axis');

    control.seedKeep('shaftAxis');
    expect(control.selection).toEqual({ kind: 'keep' });
    expect(chipText(host)).toContain('Current: shaftAxis');
  });

  it('limits kept matches to the dialog\'s own datum axes', () => {
    const { host, control } = make({
      keepAxes: ['x', 'y'],
      keepMatcher: /^([xy])Axis\(\s*\)$/,
      chipLabel: (axis) => `Sketch ${axis.toUpperCase()} axis`,
    });
    control.seedKeep('xAxis()');
    expect(control.selection).toEqual({ kind: 'standard', axis: 'x' });
    expect(chipText(host)).toContain('Sketch X axis');

    control.seedKeep("'z'");
    expect(control.selection).toEqual({ kind: 'keep' });
  });

  it('tracks the picked-edge chip and falls back when it clears', () => {
    const { host, control } = make();
    control.setEdgeChip('Picked edge');
    expect(control.selection).toEqual({ kind: 'edge' });
    expect(chipText(host)).toContain('Picked edge');
    control.setEdgeChip(null);
    expect(control.selection).toBeNull();

    // Edit mode: clearing the edge reverts to the statement's own axis.
    control.seedKeep("'x'");
    control.setEdgeChip('Picked edge');
    expect(control.selection).toEqual({ kind: 'edge' });
    control.setEdgeChip(null);
    expect(control.selection).toEqual({ kind: 'standard', axis: 'x' });
  });

  it('a standard pick replaces an edge pick and vice versa', () => {
    const { control } = make();
    control.setEdgeChip('Picked edge');
    control.selectStandard('z');
    expect(control.selection).toEqual({ kind: 'standard', axis: 'z' });
    control.setEdgeChip('Picked edge');
    expect(control.selection).toEqual({ kind: 'edge' });
  });

  it('the chip\'s ✕ reverts to the fallback and fires the mode and change hooks', () => {
    const { host, control } = make();
    const events: string[] = [];
    control.onModeChange = () => events.push('mode');
    control.onChange = () => events.push('change');

    control.selectStandard('z');
    clickRemove(host);
    expect(control.selection).toBeNull();
    expect(events).toEqual(['mode', 'change']);

    control.seedKeep("'y'");
    control.selectStandard('x');
    clickRemove(host);
    expect(control.selection).toEqual({ kind: 'standard', axis: 'y' });
  });

  it('keeps standard and edge states across option refreshes', () => {
    const { control } = make();
    control.selectStandard('x');
    control.setOptions([]);
    expect(control.selection).toEqual({ kind: 'standard', axis: 'x' });

    const option = { label: 'Axis', filePath: 'a.fluid.js', line: 3, column: 1 };
    control.selectOption(option);
    control.setOptions([{ ...option, label: 'ringAxis' }]);
    expect(control.selection).toEqual({ kind: 'axis', option: { ...option, label: 'ringAxis' } });
    control.setOptions([]);
    expect(control.selection).toBeNull();
  });

  const BOLT = { id: 'c1', label: 'bolt', name: 'bolt', filePath: 'm.part.js', line: 8, column: 15 };
  const COPY = { ...BOLT, id: 'c2', label: 'bolt.instance(1)', slot: 1 };

  it('holds a connector, re-found by its site after a render, and falls back when it is gone', () => {
    const { host, control } = make();
    control.selectConnector(COPY);
    expect(control.selection).toEqual({ kind: 'connector', option: COPY });
    expect(control.connector).toBe(COPY);
    expect(chipText(host)).toContain('bolt.instance(1)');

    // A render re-minted the ids: the copy is found again by seed site and slot, not the seed.
    const rerendered = [{ ...BOLT, id: 'c7' }, { ...COPY, id: 'c8' }];
    control.setConnectorOptions(rerendered);
    expect(control.selection).toEqual({ kind: 'connector', option: rerendered[1] });

    control.setConnectorOptions([{ ...BOLT, id: 'c9' }]);
    expect(control.selection).toBeNull();

    // Edit mode: a lost connector falls back to the statement's own axis.
    control.seedKeep('pivot');
    control.selectConnector(BOLT);
    control.setConnectorOptions([]);
    expect(control.selection).toEqual({ kind: 'keep' });
  });

  it("shows an edit's own connector axis as that connector's chip, still kept as written", () => {
    const { host, control } = make();
    control.seedKeep('bolt.instance(1)');
    expect(chipText(host)).toContain('Current: bolt.instance(1)');
    expect(control.connector).toBeNull();

    control.setKeptConnector(COPY);
    expect(control.selection).toEqual({ kind: 'keep' });
    expect(control.connector).toBe(COPY);
    expect(chipText(host)).toContain('bolt.instance(1)');
    expect(chipText(host)).not.toContain('Current:');
    // The kept chip can't be taken off — a re-pick is undone by its ✕, never the statement's own axis.
    expect([...host.querySelectorAll('button')].some(b => b.textContent === '✕')).toBe(false);

    // Re-found by its site after a render; a re-pick replaces it, its ✕ comes back to it.
    const again = { ...COPY, id: 'c5' };
    control.setConnectorOptions([again]);
    expect(control.connector).toBe(again);
    control.selectStandard('x');
    expect(control.connector).toBeNull();
    clickRemove(host);
    expect(control.selection).toEqual({ kind: 'keep' });
    expect(control.connector).toBe(again);

    // Gone from the scene, the chip reads as the statement's text again; a fresh create forgets it.
    control.setConnectorOptions([]);
    expect(chipText(host)).toContain('Current: bolt.instance(1)');
    control.setKeptConnector(COPY);
    control.reset();
    expect(control.connector).toBeNull();
  });
});
