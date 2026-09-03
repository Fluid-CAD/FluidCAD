// @vitest-environment jsdom
// The mate dialog's edit seeding: show(type, seed) titles the panel "Edit
// mate" and fills the option rows from an existing statement's serialized
// options — zeros rendering as the blank placeholder fields they'd be
// re-rendered from — while an unseeded show() stays the zeroed create form.
import { afterEach, describe, it, expect } from 'vitest';
import { MatePanel } from '../src/interactive/assembly-mate/mate-panel';

// vitest runs with isolate:false — panels appended to document.body leak
// into later test FILES (connector-props-position docks against the first
// '#fluidcad-mate-panel' it finds), so scrub between tests.
afterEach(() => {
  document.body.innerHTML = '';
});

function openPanel(): { panel: MatePanel; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { panel: new MatePanel(container), container };
}

function field(container: HTMLElement, role: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
}

function title(container: HTMLElement): string {
  return container.querySelector('[data-role="title"]')!.textContent ?? '';
}

describe('MatePanel edit seeding', () => {
  it('round-trips a full option seed through values()', () => {
    const { panel, container } = openPanel();
    panel.show('fastened', { flip: true, rotate: 45, offset: [1, 2, 3] });
    expect(title(container)).toBe('Edit mate');
    expect(panel.values()).toEqual({
      type: 'fastened',
      flip: true,
      rotate: 45,
      offset: [1, 2, 3],
      limits: null,
      propagate: true,
    });
  });

  it('seeds absent options as the blank placeholder fields', () => {
    const { panel, container } = openPanel();
    panel.show('fastened', {});
    expect(field(container, 'flip').checked).toBe(false);
    expect(field(container, 'rotate').value).toBe('');
    expect(field(container, 'offset-x').value).toBe('');
    expect(panel.values()).toMatchObject({ flip: false, rotate: 0, offset: [0, 0, 0] });
  });

  it('seeds limits enabled with zero kept as a literal 0', () => {
    const { panel, container } = openPanel();
    panel.show('revolute', { limits: [0, 90] });
    expect(field(container, 'limits-enable').checked).toBe(true);
    expect(field(container, 'limit-min').disabled).toBe(false);
    expect(field(container, 'limit-min').value).toBe('0');
    expect(field(container, 'limit-max').value).toBe('90');
    expect(panel.values()).toMatchObject({ limits: [0, 90] });
  });

  it('keeps Z-only types locked to their Z offset', () => {
    const { panel, container } = openPanel();
    panel.show('slider', { offset: [0, 0, 7] });
    expect(field(container, 'offset-x').disabled).toBe(true);
    expect(field(container, 'offset-x').value).toBe('');
    expect(field(container, 'offset-z').value).toBe('7');
    expect(panel.values()).toMatchObject({ offset: [0, 0, 7] });
  });

  it('an unseeded show() after an edit resets to the create form', () => {
    const { panel, container } = openPanel();
    panel.show('revolute', { flip: true, rotate: 30, limits: [0, 90] });
    panel.show('fastened');
    expect(title(container)).toBe('Fastened mate');
    expect(field(container, 'flip').checked).toBe(false);
    expect(field(container, 'rotate').value).toBe('');
    expect(field(container, 'limits-enable').checked).toBe(false);
    expect(field(container, 'limit-min').disabled).toBe(true);
    expect(panel.values()).toEqual({
      type: 'fastened',
      flip: false,
      rotate: 0,
      offset: [0, 0, 0],
      limits: null,
      propagate: true,
    });
  });
});

// The tangent reshape (17-mate-tangent §8): geometry slots, the propagation
// checkbox as the single option, every connector-frame row hidden.
describe('MatePanel — tangent reshape', () => {
  function hidden(container: HTMLElement, role: string): boolean {
    return container.querySelector<HTMLElement>(`[data-role="${role}"]`)!
      .classList.contains('hidden');
  }

  it('shows the propagation checkbox (checked) and hides flip/rotate/offset/limits', () => {
    const { panel, container } = openPanel();
    panel.show('tangent');
    expect(hidden(container, 'propagate-row')).toBe(false);
    expect(field(container, 'propagate').checked).toBe(true);
    expect(hidden(container, 'flip-row')).toBe(true);
    expect(hidden(container, 'rotate-row')).toBe(true);
    expect(hidden(container, 'offset-row')).toBe(true);
    expect(hidden(container, 'limits-section')).toBe(true);
    void panel;
  });

  it('values() carries only the propagation state for tangent', () => {
    const { panel, container } = openPanel();
    panel.show('tangent');
    field(container, 'propagate').checked = false;
    expect(panel.values()).toEqual({
      type: 'tangent',
      flip: false,
      rotate: 0,
      offset: [0, 0, 0],
      limits: null,
      propagate: false,
    });
  });

  it('seeds the checkbox from options: only an explicit false unchecks', () => {
    const { panel: p1, container: c1 } = openPanel();
    p1.show('tangent', { propagate: false });
    expect(field(c1, 'propagate').checked).toBe(false);
    const { panel: p2, container: c2 } = openPanel();
    p2.show('tangent', {});
    expect(field(c2, 'propagate').checked).toBe(true);
  });

  it('relabels the slots and prompts for geometry picking', () => {
    const { panel, container } = openPanel();
    panel.show('tangent');
    expect(container.textContent).toContain('Face / edge A');
    expect(container.textContent).toContain('Face / edge B');
    expect(container.textContent).toContain('Click a face or edge in 3D');
    void panel;
  });

  it('switching back to a connector type restores rows and labels', () => {
    const { panel, container } = openPanel();
    panel.show('tangent');
    panel.setType('revolute');
    expect(hidden(container, 'propagate-row')).toBe(true);
    expect(hidden(container, 'flip-row')).toBe(false);
    expect(container.textContent).toContain('Connector A');
  });
});

