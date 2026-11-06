// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HolePanel } from '../src/interactive/create-feature/hole/hole-panel';
import { tableDiameter } from '../src/interactive/create-feature/hole/hole-catalog';
import type { ParsedFeatureStatement } from '../src/api';
import { ParamDeclareMode, type VariableInfo } from '../src/ui/expression-core';
import './dom-reset';

// The Hole dialog's typed-in rows — the fastener fit, the tapped pitch and
// the fasten pitch — take an expression under their ƒ the way a schema
// dialog's select does: a statement holding one (`.clearance(left ? 'close'
// : 'loose')`) opens the row in that mode with the option it comes to, the
// table diameter and the ghost following that option; left alone the row
// writes the expression back as it was; ƒ off lands the dropdown on the
// resolved option; ƒ on seeds the input with the chosen option as source;
// typing writes the text. The size row stays a choice or a variable: an
// expression in its slot is a drilled diameter, never a label.

const VARIABLES: VariableInfo[] = [
  { name: 'left', initializer: "param('Left', true, 'checkbox')", numeric: true, value: true },
  { name: 'fine', initializer: 'false', numeric: true, value: false },
  { name: 'pitch', initializer: "param('Pitch', 1)", numeric: true, value: 1 },
  { name: 'depth', initializer: '8', numeric: true, value: 8 },
];

const opened: HolePanel[] = [];

/** A parsed M6 clearance hole at one connector, its fastener and fasten chains as given. */
function parsedHole(
  fastener: Extract<ParsedFeatureStatement, { feature: 'hole' }>['fastener'],
  fasten: Extract<ParsedFeatureStatement, { feature: 'hole' }>['fasten'] = null,
): Extract<ParsedFeatureStatement, { feature: 'hole' }> {
  return {
    feature: 'hole', size: { kind: 'fastener', label: 'M6' }, fastener, style: null, depth: null, tipAngle: null,
    placementTexts: ['bolt'], placementRefs: [null], fasten, scopeTexts: [], scopeRefs: [],
  };
}

function openPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new HolePanel(container);
  const changes = vi.fn();
  panel.onChange = changes;
  panel.show();
  opened.push(panel);
  const q = <T extends HTMLElement>(role: string) => container.querySelector<T>(`[data-role="${role}"]`)!;
  /** The ƒ toggle, expression input and resolved note of the row named `name`. */
  const row = (name: string) => {
    const toggle = () => q<HTMLButtonElement>(`expression-${name}`);
    const input = () => q<HTMLInputElement>(`expr-${name}`);
    const resolved = () => {
      const note = q<HTMLElement>(`expression-line-${name}`).querySelector<HTMLElement>('[data-role="resolved"]')!;
      return note.hidden ? undefined : { text: note.textContent, warning: note.title || undefined };
    };
    const type = (text: string) => {
      input().value = text;
      input().dispatchEvent(new Event('input', { bubbles: true }));
    };
    const on = () => toggle().getAttribute('aria-pressed') === 'true';
    const buttonShown = () => !q(name).classList.contains('hidden');
    return { toggle, input, resolved, type, on, buttonShown };
  };
  /** Choose a native select's value, or a dropdown's option by its label. */
  const select = (role: string, value: string) => {
    const el = q(role);
    if (el instanceof HTMLSelectElement) {
      el.value = value;
      el.dispatchEvent(new Event('change'));
      return;
    }
    el.click();
    [...document.body.querySelectorAll<HTMLElement>('[role="option"]:not([data-parameter])')]
      .find(option => option.querySelector('.truncate')!.textContent === value)!.click();
  };
  const diameter = () => q<HTMLInputElement>('diameter').value;
  const fastener = () => {
    const values = panel.values();
    return 'error' in values ? values : values.fastener;
  };
  return { panel, container, changes, q, row, select, diameter, fastener };
}

afterEach(() => {
  for (const panel of opened.splice(0)) {
    panel.hide();
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  ParamDeclareMode.set(true);
});

describe('Hole panel — the fit row takes an expression', () => {
  it('opens a statement\'s expression in expression mode, the diameter and the ghost following the fit it comes to; reads it back verbatim', () => {
    const { panel, row, diameter, fastener, changes } = openPanel();
    const fit = row('fit');
    panel.showEdit(parsedHole({ type: 'clearance', fit: { expr: "left ? 'close' : 'loose'" } }));
    expect(fit.on()).toBe(true);
    expect(fit.input().value).toBe("left ? 'close' : 'loose'");
    expect(fit.buttonShown()).toBe(false);
    // Before the scope's variables arrive the fit comes to nothing: the
    // tables give no diameter, so the ghost is not drawn — as for a bound
    // name with no value — while the request still carries the expression.
    expect(fit.resolved()).toBeUndefined();
    expect(panel.derivedDiameter()).toBeNull();
    expect(panel.ghostNumbers()).toBeNull();
    expect(fastener()).toEqual({ type: 'clearance', fit: { expr: "left ? 'close' : 'loose'" } });
    panel.setScopeVariables(VARIABLES);
    expect(fit.resolved()).toEqual({ text: 'Close', warning: undefined });
    expect(diameter()).toBe(String(tableDiameter('M6', 'clearance', { fit: 'close' })));
    expect(panel.ghostNumbers()).toMatchObject({ diameter: 6.4 });
    expect(fastener()).toEqual({ type: 'clearance', fit: { expr: "left ? 'close' : 'loose'" } });
    // The variables arriving re-asks the ghost, the seed itself is no change of the user's.
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('ƒ off lands the dropdown on the resolved fit, as a change; ƒ on seeds the chosen fit as source', () => {
    const { panel, row, fastener, changes, diameter } = openPanel();
    const fit = row('fit');
    panel.setScopeVariables(VARIABLES);
    panel.showEdit(parsedHole({ type: 'clearance', fit: { expr: "left ? 'close' : 'loose'" } }));
    changes.mockClear();
    fit.toggle().click();
    expect(fit.on()).toBe(false);
    expect(fit.buttonShown()).toBe(true);
    expect(fastener()).toEqual({ type: 'clearance', fit: 'close' });
    expect(changes).toHaveBeenCalledTimes(1);
    fit.toggle().click();
    expect(fit.input().value).toBe("'close'");
    expect(fit.resolved()).toEqual({ text: 'Close', warning: undefined });
    expect(fastener()).toEqual({ type: 'clearance', fit: { expr: "'close'" } });
    expect(diameter()).toBe('6.4');
  });

  it('typing writes the expression; a value no fit carries warns and draws no ghost; emptied, there is nothing to apply', () => {
    const { panel, row, fastener, diameter } = openPanel();
    const fit = row('fit');
    panel.setScopeVariables(VARIABLES);
    fit.toggle().click();
    fit.type("left ? 'loose' : 'close'");
    expect(fit.resolved()).toEqual({ text: 'Loose', warning: undefined });
    expect(fastener()).toEqual({ type: 'clearance', fit: { expr: "left ? 'loose' : 'close'" } });
    expect(diameter()).toBe('7');
    expect(panel.ghostNumbers()).toMatchObject({ diameter: 7 });
    fit.type('depth');
    expect(fit.resolved()).toEqual({ text: '8', warning: 'depth is 8, which is not one of the options.' });
    expect(fastener()).toEqual({ type: 'clearance', fit: { expr: 'depth' } });
    expect(panel.ghostNumbers()).toBeNull();
    fit.type('  ');
    expect(panel.values()).toEqual({ error: 'Fastener fit needs an expression.' });
  });

  it('Enter in the expression input applies', () => {
    const { panel, row } = openPanel();
    const apply = vi.fn();
    panel.onApply = apply;
    const fit = row('fit');
    fit.toggle().click();
    fit.input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('a fresh dialog opens with every row out of expression mode', () => {
    const { panel, row, fastener } = openPanel();
    panel.setScopeVariables(VARIABLES);
    panel.showEdit(parsedHole({ type: 'tapped', pitch: { expr: 'pitch' } }, { pitch: { expr: 'pitch' }, depth: null, tipAngle: null }));
    expect(row('pitch').on()).toBe(true);
    panel.show();
    expect(row('fit').on()).toBe(false);
    expect(row('pitch').on()).toBe(false);
    expect(row('fasten-pitch').on()).toBe(false);
    expect(fastener()).toEqual({ type: 'clearance', fit: 'normal' });
    panel.setScopeVariables(VARIABLES);
    panel.showEdit(parsedHole({ type: 'clearance', fit: 'close' }, { pitch: 0.75, depth: null, tipAngle: null }));
    expect(row('fasten-pitch').on()).toBe(false);
    expect(panel.fastenPitch()).toBe(0.75);
  });
});

describe('Hole panel — the pitch rows take an expression', () => {
  it('a tapped pitch expression resolves against the size\'s list, warns of a pitch the list lacks, and survives a size change', () => {
    const { panel, row, fastener, diameter, select } = openPanel();
    const pitch = row('pitch');
    panel.showEdit(parsedHole({ type: 'tapped', pitch: { expr: 'pitch' } }));
    expect(panel.holeType).toBe('tapped');
    expect(pitch.on()).toBe(true);
    expect(pitch.resolved()).toBeUndefined();
    expect(panel.ghostNumbers()).toBeNull();
    expect(fastener()).toEqual({ type: 'tapped', pitch: { expr: 'pitch' } });
    panel.setScopeVariables(VARIABLES);
    expect(pitch.resolved()).toEqual({ text: '1 mm', warning: undefined });
    expect(diameter()).toBe('5');
    expect(fastener()).toEqual({ type: 'tapped', pitch: { expr: 'pitch' } });
    // A pitch the list lacks is the row's warning, not a refusal: the file judges it, the ghost waits.
    pitch.type('depth');
    expect(pitch.resolved()).toEqual({ text: '8', warning: 'depth is 8, which is not one of the options.' });
    expect(fastener()).toEqual({ type: 'tapped', pitch: { expr: 'depth' } });
    expect(panel.ghostNumbers()).toBeNull();
    // The size changing refills the lists under the expression, which stays and resolves anew.
    pitch.type('pitch');
    select('size', 'M8');
    expect(pitch.on()).toBe(true);
    expect(pitch.resolved()).toEqual({ text: '1 mm', warning: undefined });
    expect(diameter()).toBe('7');
    expect(fastener()).toEqual({ type: 'tapped', pitch: { expr: 'pitch' } });
    // ƒ off lands on the resolved pitch; the coarse pitch of M8 (1.25) it is not, so the argument is written.
    pitch.toggle().click();
    expect(fastener()).toEqual({ type: 'tapped', pitch: 1 });
    // ƒ on seeds the chosen pitch's number as source.
    pitch.toggle().click();
    expect(pitch.input().value).toBe('1');
    expect(fastener()).toEqual({ type: 'tapped', pitch: { expr: '1' } });
  });

  it('a fasten pitch expression reaches the statement as it is, the tap drill drawn from what it comes to', () => {
    const { panel, row, q } = openPanel();
    const fastenPitch = row('fasten-pitch');
    panel.showEdit(parsedHole({ type: 'clearance', fit: 'close' }, { pitch: { expr: 'fine ? 0.75 : pitch' }, depth: null, tipAngle: null }));
    expect(panel.fastened).toBe(true);
    expect(fastenPitch.on()).toBe(true);
    expect(fastenPitch.input().value).toBe('fine ? 0.75 : pitch');
    expect(panel.fastenPitch()).toEqual({ expr: 'fine ? 0.75 : pitch' });
    expect(panel.fastenDiameter()).toBeNull();
    expect(q<HTMLInputElement>('fasten-diameter').value).toBe('');
    panel.setScopeVariables(VARIABLES);
    expect(fastenPitch.resolved()).toEqual({ text: '1 mm', warning: undefined });
    expect(panel.fastenDiameter()).toBe(5);
    expect(q<HTMLInputElement>('fasten-diameter').value).toBe('5');
    fastenPitch.type('0.75');
    expect(panel.fastenPitch()).toEqual({ expr: '0.75' });
    expect(panel.fastenDiameter()).toBe(5.25);
    fastenPitch.toggle().click();
    expect(panel.fastenPitch()).toBe(0.75);
  });
});
