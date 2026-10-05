// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { RegionPickControl } from '../src/interactive/create-feature/region-pick-control';
import { SketchSlotControl } from '../src/interactive/create-feature/sketch-slot';
import './dom-reset';

// The region row under a profile slot: the "Pick regions" link that turns
// viewport region picking on, the pick count with its ✕ once anything is
// picked, and nothing at all until a profile is chosen or a pick exists.

function make() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const control = new RegionPickControl(host);
  return { host, control };
}

function text(host: HTMLElement): string {
  return [...host.querySelectorAll<HTMLElement>('span, button')]
    .filter(el => el.children.length === 0 && !el.closest('.hidden'))
    .map(el => el.textContent?.trim())
    .filter(t => t)
    .join(' ');
}

describe('RegionPickControl', () => {
  it('shows nothing until a profile is chosen or a pick exists', () => {
    const { host, control } = make();
    expect(host.classList.contains('hidden')).toBe(true);
    control.setState({ count: 0, active: false, available: true });
    expect(host.classList.contains('hidden')).toBe(false);
    expect(text(host)).toBe('Pick regions');
  });

  it('counts the picks with a ✕ and flips the link to Done while picking', () => {
    const { host, control } = make();
    control.setState({ count: 2, active: true, available: true });
    expect(text(host)).toBe('2 regions ✕ Done');
    control.setState({ count: 1, active: false, available: true });
    expect(text(host)).toBe('1 region ✕ Pick regions');
  });

  it('hints at the viewport while picking with nothing picked yet', () => {
    const { host, control } = make();
    control.setState({ count: 0, active: true, available: true });
    expect(text(host)).toBe('Click regions in the view Done');
  });

  it('keeps the count reachable when the profile is unknown, without the link', () => {
    const { host, control } = make();
    control.setState({ count: 3, active: false, available: false });
    expect(host.classList.contains('hidden')).toBe(false);
    expect(text(host)).toBe('3 regions ✕');
  });

  it('reports the link and the ✕', () => {
    const { host, control } = make();
    const events: string[] = [];
    control.onToggle = () => events.push('toggle');
    control.onClear = () => events.push('clear');
    control.setState({ count: 1, active: false, available: true });
    const buttons = [...host.querySelectorAll('button')];
    buttons.find(b => b.textContent === 'Pick regions')!.click();
    buttons.find(b => b.textContent === '✕')!.click();
    expect(events).toEqual(['toggle', 'clear']);
  });
});

describe('SketchSlotControl regions row', () => {
  it('mounts the row only for the slots that opt in', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const plain = new SketchSlotControl(host);
    expect(plain.regions).toBeNull();

    const withRegions = document.createElement('div');
    document.body.appendChild(withRegions);
    const slot = new SketchSlotControl(withRegions, { regions: true });
    expect(slot.regions).not.toBeNull();
    slot.regions!.setState({ count: 0, active: false, available: true });
    expect(withRegions.textContent).toContain('Pick regions');
  });
});
