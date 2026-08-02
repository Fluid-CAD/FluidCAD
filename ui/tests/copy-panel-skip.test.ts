// @vitest-environment jsdom
// The copy dialog's Skip field wired to the form it belongs to: what the field
// contributes to `values()`, how it reads a grid once a second direction is
// added, and what an edit dialog seeds it with.
import { describe, it, expect } from 'vitest';
import { CopyPanel } from '../src/interactive/create-feature/copy-panel';

function openPanel(): { panel: CopyPanel; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new CopyPanel(container);
  panel.show();
  return { panel, container };
}

/** Type into a dialog field the way the user would. */
function type(container: HTMLElement, role: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function field(container: HTMLElement, role: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
}

describe('CopyPanel — the Skip field', () => {
  it('contributes nothing when it is empty', () => {
    const { panel } = openPanel();
    expect(panel.values()).toMatchObject({ kind: 'linear', skip: [] });
  });

  it('reads comma-separated indices for a single direction', () => {
    const { panel, container } = openPanel();
    type(container, 'count', '5');
    type(container, 'skip', '1, 3');
    expect(panel.values()).toMatchObject({ kind: 'linear', skip: [[1], [3]] });
  });

  it('refuses an index the pattern does not reach', () => {
    const { panel, container } = openPanel();
    type(container, 'count', '3');
    type(container, 'skip', '4');
    expect(panel.values()).toMatchObject({ error: expect.stringContaining('past the count of 3') });
  });

  it('takes grid cells once a second direction is added', () => {
    const { panel, container } = openPanel();
    container.querySelector<HTMLButtonElement>('[data-role="add-direction"]')!.click();
    // The placeholder switches with the arity — a cell, not a bare instance.
    expect(field(container, 'skip').placeholder).toContain('[1, 0]');
    type(container, 'skip', '[1, 0]');
    expect(panel.values()).toMatchObject({ skip: [[1, 0]] });
  });

  it('names the direction whose count a cell overshoots', () => {
    const { panel, container } = openPanel();
    container.querySelector<HTMLButtonElement>('[data-role="add-direction"]')!.click();
    // Direction 2 opens on a count of 2 — index 2 is one past its last.
    type(container, 'skip', '[0, 2]');
    expect(panel.values()).toMatchObject({ error: expect.stringContaining('direction 2') });
  });

  it('takes single indices for a circular copy', () => {
    const { panel, container } = openPanel();
    const kind = field(container, 'kind') as unknown as HTMLSelectElement;
    kind.value = 'circular';
    kind.dispatchEvent(new Event('change'));
    type(container, 'count', '6');
    type(container, 'skip', '2, 4');
    expect(panel.values()).toMatchObject({ kind: 'circular', skip: [[2], [4]] });
  });

  it('opens its examples on the help icon, and closes them again', () => {
    const { panel, container } = openPanel();
    const icon = container.querySelector<HTMLButtonElement>('[data-role="skip-help"]')!;
    const popover = () => container.querySelector('[role="tooltip"]');

    expect(popover()).toBeNull();

    icon.dispatchEvent(new MouseEvent('mouseenter'));
    const shown = popover()!;
    expect(shown).not.toBeNull();
    // Every form the field takes is worked through, down to what it writes.
    for (const example of ['1, 3', '[1, 0]', '[1, 0], [2, 1]', '[1, 0], 2', 'skip: [[1], [3]]', 'skip: [1, 3]']) {
      expect(shown.textContent, example).toContain(example);
    }

    icon.dispatchEvent(new MouseEvent('mouseleave'));
    expect(popover()).toBeNull();

    // Keyboard focus reaches the same panel — and a closing dialog takes it
    // with it, since a hidden anchor never gets its `mouseleave`.
    icon.dispatchEvent(new FocusEvent('focus'));
    expect(popover()).not.toBeNull();
    panel.hide();
    expect(popover()).toBeNull();
  });

  it("seeds an edit dialog with the statement's own list, and a fresh dialog with none", () => {
    const { panel, container } = openPanel();
    panel.showEdit({
      kind: 'linear',
      directions: [{ count: 4, value: 40 }],
      spacingMode: 'offset',
      centered: false,
      count: null,
      sweep: null,
      skip: [[1], [3]],
      axisLabels: [`'x'`],
    });
    expect(field(container, 'skip').value).toBe('1, 3');
    expect(panel.values()).toMatchObject({ skip: [[1], [3]] });

    // The next arming starts clean — a previous session's skips never carry.
    panel.show();
    expect(field(container, 'skip').value).toBe('');
  });
});
