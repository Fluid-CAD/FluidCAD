// @vitest-environment jsdom
// The mate dialog's edit seeding: show(type, seed) titles the panel "Edit
// mate" and fills the option rows from an existing statement's serialized
// options — zeros rendering as the blank placeholder fields they'd be
// re-rendered from — while an unseeded show() stays the zeroed create form.
import { describe, it, expect } from 'vitest';
import { MatePanel } from '../src/interactive/assembly-mate/mate-panel';

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
    });
  });
});
