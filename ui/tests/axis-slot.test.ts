// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AxisSlotControl } from '../src/interactive/create-feature/axis-slot';

// The axis slot shared by every axis-picking dialog: no quick buttons — a
// standard axis arrives only from the viewport (a world axis, a sketch
// datum) or from a kept statement literal — and the chip/prompt follows the
// selection state machine.

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
    expect(chipText(host)).toContain('Pick a world axis, an axis or an edge');
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
});
