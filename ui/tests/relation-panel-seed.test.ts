// @vitest-environment jsdom
// The relation dialog's form: show(type) is the create form (blank ratio
// reads as 1, Reverse off), show(type, seed) titles it "Edit relation" and
// fills the fields from an existing statement; values() applies the ratio
// rule (positive, finite) and the type switch relabels the slots.
import { afterEach, describe, it, expect } from 'vitest';
import { RelationPanel } from '../src/interactive/assembly-relation/relation-panel';

afterEach(() => {
  document.body.innerHTML = '';
});

function openPanel(): { panel: RelationPanel; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { panel: new RelationPanel(container), container };
}

function field(container: HTMLElement, role: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
}

function title(container: HTMLElement): string {
  return container.querySelector('[data-role="title"]')!.textContent ?? '';
}

describe('RelationPanel', () => {
  it('opens the create form with the type titled and a unit ratio', () => {
    const { panel, container } = openPanel();
    panel.show('gear');
    expect(title(container)).toBe('Gear relation');
    expect(field(container, 'ratio').value).toBe('');
    expect(field(container, 'reverse').checked).toBe(false);
    expect(panel.values()).toEqual({ type: 'gear', ratio: 1, reverse: false });
    expect(panel.getArmedSlot()).toBe('a');
  });

  it('seeds the edit form from an existing relation', () => {
    const { panel, container } = openPanel();
    panel.show('rack-and-pinion', { ratio: 62.8, reverse: true });
    expect(title(container)).toBe('Edit relation');
    expect(field(container, 'ratio').value).toBe('62.8');
    expect(field(container, 'reverse').checked).toBe(true);
    expect(panel.values()).toEqual({ type: 'rack-and-pinion', ratio: 62.8, reverse: true });
  });

  it('refuses a non-positive or non-numeric ratio with a pointed message', () => {
    const { panel, container } = openPanel();
    panel.show('gear');
    field(container, 'ratio').value = '0';
    expect(panel.values()).toEqual({ error: expect.stringMatching(/positive.*Reverse/) });
    // (A number input sanitizes non-numeric text to blank, which reads as 1.)
    panel.setType('rack-and-pinion');
    field(container, 'ratio').value = '-3';
    expect(panel.values()).toEqual({ error: expect.stringMatching(/travel per revolution must be positive/) });
  });

  it('relabels the slots and the ratio for a rack and pinion', () => {
    const { panel, container } = openPanel();
    panel.show('gear');
    expect(container.textContent).toContain('Mate A (revolute or cylindrical)');
    expect(container.querySelector('[data-role="ratio-label"]')!.textContent).toBe('Ratio');
    panel.setType('rack-and-pinion');
    expect(title(container)).toBe('Rack and pinion relation');
    expect(container.textContent).toContain('Pinion mate (revolute or cylindrical)');
    expect(container.textContent).toContain('Rack mate (slider or cylindrical)');
    expect(container.querySelector('[data-role="ratio-label"]')!.textContent).toBe('Travel per revolution');
  });

  it('renders picked chips and arms the other slot on demand', () => {
    const { panel, container } = openPanel();
    panel.show('gear');
    panel.setSlotChip('a', 'Revolute · base ↔ pinion');
    expect(container.textContent).toContain('Revolute · base ↔ pinion');
    panel.armSlot('b');
    expect(panel.getArmedSlot()).toBe('b');
    panel.setSlotChip('a', null);
    expect(container.textContent).not.toContain('Revolute · base ↔ pinion');
  });
});
