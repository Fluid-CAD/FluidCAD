// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorPanel } from '../src/interactive/create-feature/connector-panel';
import type { VariableInfo } from '../src/ui/expression-core';
import './dom-reset';

// The Connector dialog's adjustments take expressions: the rotation axis
// under its ƒ toggle the way a schema dialog's select does, the angle and the
// offsets through their expression fields. A statement holding them
// (`.rotate(flipped ? 'x' : 'y', ang).offset(0, gap)`) opens the rows with
// what they come to; left alone they write back as they were; ƒ off lands
// the select on the resolved axis; ƒ on seeds the chosen axis as source. The
// ghost draws from the resolved numbers, and no frame while one cannot be
// told; the 90° stepper turns a number and stands disabled under an
// expression.

const VARIABLES: VariableInfo[] = [
  { name: 'flipped', initializer: "param('Flipped', true, 'checkbox')", numeric: true, value: true },
  { name: 'ang', initializer: '45', numeric: true, value: 45 },
  { name: 'gap', initializer: '2.5', numeric: true, value: 2.5 },
  { name: 'axisName', initializer: "'x'", numeric: false, value: 'x' },
];

const opened: ConnectorPanel[] = [];

function openPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new ConnectorPanel(container);
  const changes = vi.fn();
  panel.onChange = changes;
  opened.push(panel);
  const q = <T extends HTMLElement>(role: string) => container.querySelector<T>(`[data-role="${role}"]`)!;
  const toggle = () => q<HTMLButtonElement>('expression-rotate-axis');
  const input = () => q<HTMLInputElement>('expr-rotate-axis');
  const resolved = () => {
    const note = q<HTMLElement>('expression-line-rotate-axis').querySelector<HTMLElement>('[data-role="resolved"]')!;
    return note.hidden ? undefined : { text: note.textContent, warning: note.title || undefined };
  };
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const on = () => toggle().getAttribute('aria-pressed') === 'true';
  const fill = (role: string, text: string) => {
    const field = q<HTMLInputElement>(role);
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return { panel, container, changes, q, toggle, input, resolved, type, on, fill };
}

/** The edit seed of `connector('c1', e.endFaces(0).center())` with the given chains. */
const edited = (
  rotate: Parameters<ConnectorPanel['showEdit']>[0]['rotate'],
  offset: Parameters<ConnectorPanel['showEdit']>[0]['offset'],
) => ({ name: 'c1', sourceText: 'e.endFaces(0).center()', rotate, offset });

afterEach(() => {
  for (const panel of opened.splice(0)) {
    panel.hide();
  }
  document.body.innerHTML = '';
});

describe('Connector panel — the axis, the angle and the offsets take expressions', () => {
  it('opens a statement\'s expressions as written, reads them back verbatim, and draws no frame until the variables resolve them', () => {
    const { panel, q, on, input, resolved, changes } = openPanel();
    panel.showEdit(edited({ axis: { expr: "flipped ? 'x' : 'y'" }, angle: 'ang' }, [0, 'gap', 0]));
    expect(on()).toBe(true);
    expect(input().value).toBe("flipped ? 'x' : 'y'");
    expect(q('rotate-axis').classList.contains('hidden')).toBe(true);
    expect(q<HTMLInputElement>('rotate-angle').value).toBe('ang');
    expect(q<HTMLInputElement>('offset-y').value).toBe('gap');
    expect(q<HTMLInputElement>('offset-x').value).toBe('');
    // The stepper has no number to turn under an expression.
    expect(q<HTMLButtonElement>('rotate').disabled).toBe(true);
    expect(resolved()).toBeUndefined();
    expect(panel.resolvedAdjustments()).toBeNull();
    expect(panel.values()).toEqual({
      name: 'c1',
      rotate: { axis: { expr: "flipped ? 'x' : 'y'" }, angle: 'ang' },
      offset: [0, 'gap', 0],
      newVariables: undefined,
    });
    expect(changes).not.toHaveBeenCalled();
    panel.setScopeVariables(VARIABLES);
    expect(resolved()).toEqual({ text: 'Around X', warning: undefined });
    expect(panel.resolvedAdjustments()).toEqual({ rotate: { axis: 'x', angle: 45 }, offset: [0, 2.5, 0] });
    expect(panel.values()).toMatchObject({ rotate: { axis: { expr: "flipped ? 'x' : 'y'" }, angle: 'ang' }, offset: [0, 'gap', 0] });
  });

  it('a variable named as the axis opens as the expression of its name; a literal angle keeps the stepper', () => {
    const { panel, q, on, input, resolved } = openPanel();
    panel.setScopeVariables(VARIABLES);
    panel.showEdit(edited({ axis: { ref: 'axisName' }, angle: 90 }, null));
    expect(on()).toBe(true);
    expect(input().value).toBe('axisName');
    expect(resolved()).toEqual({ text: 'Around X', warning: undefined });
    expect(q<HTMLInputElement>('rotate-angle').value).toBe('90');
    expect(q<HTMLButtonElement>('rotate').disabled).toBe(false);
    q<HTMLButtonElement>('rotate').click();
    expect(q<HTMLInputElement>('rotate-angle').value).toBe('180');
    expect(panel.values()).toMatchObject({ rotate: { axis: { expr: 'axisName' }, angle: 180 }, offset: [0, 0, 0] });
    expect(panel.resolvedAdjustments()).toEqual({ rotate: { axis: 'x', angle: 180 }, offset: [0, 0, 0] });
  });

  it('ƒ off lands the select on the resolved axis, as a change; ƒ on seeds the chosen axis as source', () => {
    const { panel, q, on, toggle, input, resolved, changes } = openPanel();
    panel.setScopeVariables(VARIABLES);
    panel.showEdit(edited({ axis: { expr: "flipped ? 'x' : 'y'" }, angle: 90 }, null));
    toggle().click();
    expect(on()).toBe(false);
    expect(q<HTMLSelectElement>('rotate-axis').value).toBe('x');
    expect(panel.values()).toMatchObject({ rotate: { axis: 'x', angle: 90 } });
    expect(changes).toHaveBeenCalledTimes(1);
    toggle().click();
    expect(input().value).toBe("'x'");
    expect(resolved()).toEqual({ text: 'Around X', warning: undefined });
    expect(panel.values()).toMatchObject({ rotate: { axis: { expr: "'x'" }, angle: 90 } });
  });

  it('typing writes the expression; a value no axis carries warns and draws no frame; emptied, there is nothing to apply', () => {
    const { panel, q, toggle, type, resolved, fill } = openPanel();
    panel.show();
    panel.setScopeVariables(VARIABLES);
    fill('name', 'c1');
    toggle().click();
    type("flipped ? 'y' : 'z'");
    expect(resolved()).toEqual({ text: 'Around Y', warning: undefined });
    expect(panel.values()).toMatchObject({ rotate: { axis: { expr: "flipped ? 'y' : 'z'" }, angle: 0 } });
    expect(panel.resolvedAdjustments()).toEqual({ rotate: { axis: 'y', angle: 0 }, offset: [0, 0, 0] });
    type('gap');
    expect(resolved()).toEqual({ text: '2.5', warning: 'gap is 2.5, which is not one of the options.' });
    expect(panel.values()).toMatchObject({ rotate: { axis: { expr: 'gap' } } });
    expect(panel.resolvedAdjustments()).toBeNull();
    type('  ');
    expect(panel.values()).toEqual({ error: 'Rotation axis needs an expression.' });
    // The number fields: a typed expression rides bare; one the scope lacks draws no frame.
    type("'z'");
    fill('offset-z', 'gap * 2');
    fill('rotate-angle', 'ang');
    expect(panel.values()).toMatchObject({ rotate: { axis: { expr: "'z'" }, angle: 'ang' }, offset: [0, 0, 'gap * 2'] });
    expect(panel.resolvedAdjustments()).toEqual({ rotate: { axis: 'z', angle: 45 }, offset: [0, 0, 5] });
    expect(q<HTMLButtonElement>('rotate').disabled).toBe(true);
  });

  it('Enter in the axis expression applies; a fresh dialog opens out of expression mode with blank adjustments', () => {
    const { panel, q, on, toggle, input } = openPanel();
    const apply = vi.fn();
    panel.onApply = apply;
    panel.setScopeVariables(VARIABLES);
    panel.showEdit(edited({ axis: { expr: 'axisName' }, angle: 'ang' }, ['gap', 0, 0]));
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(apply).toHaveBeenCalledTimes(1);
    panel.show();
    expect(on()).toBe(false);
    expect(q<HTMLSelectElement>('rotate-axis').value).toBe('z');
    expect(q<HTMLInputElement>('rotate-angle').value).toBe('');
    expect(q<HTMLInputElement>('offset-x').value).toBe('');
    expect(q<HTMLButtonElement>('rotate').disabled).toBe(false);
    toggle();
  });
});

describe('ConnectorPanel.resolveAdjustments', () => {
  it('turns a statement\'s adjustments into the ghost\'s numbers, or nothing while one cannot be told', () => {
    expect(ConnectorPanel.resolveAdjustments({ rotate: null, offset: null }, [])).toEqual({
      rotate: { axis: 'z', angle: 0 }, offset: [0, 0, 0],
    });
    expect(ConnectorPanel.resolveAdjustments({ rotate: { axis: 'x', angle: 90 }, offset: [1, 2, 3] }, [])).toEqual({
      rotate: { axis: 'x', angle: 90 }, offset: [1, 2, 3],
    });
    const computed = { rotate: { axis: { ref: 'axisName' as const }, angle: 'ang * 2' }, offset: [0, 'gap', 0] as [number, string, number] };
    expect(ConnectorPanel.resolveAdjustments(computed, [])).toBeNull();
    expect(ConnectorPanel.resolveAdjustments(computed, VARIABLES)).toEqual({
      rotate: { axis: 'x', angle: 90 }, offset: [0, 2.5, 0],
    });
    // An axis expression coming to none of the three is no frame either.
    expect(ConnectorPanel.resolveAdjustments({ rotate: { axis: { expr: 'gap' }, angle: 0 }, offset: null }, VARIABLES)).toBeNull();
  });
});
