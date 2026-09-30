// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { HolePanel } from '../src/interactive/create-feature/hole/hole-panel';
import type { ParsedFeatureStatement } from '../src/api';
import './dom-reset';

// The Hole dialog's form: what each style, hole type and termination writes
// into the request, and the derived diameter the fastener tables give.

const opened: HolePanel[] = [];

function openPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new HolePanel(container);
  panel.show();
  opened.push(panel);
  const select = (role: string, value: string) => {
    const el = container.querySelector<HTMLSelectElement>(`[data-role="${role}"]`)!;
    el.value = value;
    el.dispatchEvent(new Event('change'));
  };
  const type = (role: string, value: string) => {
    const el = container.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
    el.value = value;
    el.dispatchEvent(new Event('input'));
  };
  const input = (role: string) => container.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
  const tab = (rowRole: string, label: string) => {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(`[data-role="${rowRole}"] button`)];
    buttons.find(button => button.textContent === label)!.click();
  };
  const hidden = (role: string) => container.querySelector<HTMLElement>(`[data-role="${role}"]`)!.classList.contains('hidden');
  return { panel, container, select, type, input, tab, hidden };
}

// An open feature panel stays registered for Escape until it hides — leave
// none behind for the next file's dialogs.
afterEach(() => {
  for (const panel of opened.splice(0)) {
    panel.hide();
  }
});

describe('Hole panel', () => {
  it('opens on a normal-fit M6 clearance hole through all, with the table diameter read-only', () => {
    const { panel, input, hidden } = openPanel();
    expect(panel.values()).toEqual({
      size: { kind: 'fastener', label: 'M6' },
      fastener: { type: 'clearance', fit: 'normal' },
      style: null,
      depth: null,
      tipAngle: null,
      newVariables: undefined,
    });
    expect(input('diameter').value).toBe('6.6');
    expect(input('diameter').readOnly).toBe(true);
    expect(hidden('pitch-row')).toBe(true);
    expect(hidden('blind-rows')).toBe(true);
    expect(panel.armedSlot).toBe('placements');
  });

  it('follows the fit and the size, and switches to the tap drill for a tapped hole', () => {
    const { panel, select, input } = openPanel();
    select('fit', 'close');
    expect(input('diameter').value).toBe('6.4');
    select('size', 'M8');
    expect(input('diameter').value).toBe('8.4');
    select('type', 'tapped');
    expect(input('diameter').value).toBe('6.8');
    expect(panel.values()).toMatchObject({ size: { kind: 'fastener', label: 'M8' }, fastener: { type: 'tapped', pitch: null } });
    select('pitch', '1');
    expect(input('diameter').value).toBe('7');
    expect(panel.values()).toMatchObject({ fastener: { type: 'tapped', pitch: 1 } });
  });

  it('takes a typed diameter for a drilled hole and refuses a bad one', () => {
    const { panel, select, type, input, hidden } = openPanel();
    select('type', 'drilled');
    expect(input('diameter').readOnly).toBe(false);
    expect(hidden('standard-row')).toBe(true);
    type('diameter', '4.2');
    expect(panel.values()).toMatchObject({ size: { kind: 'diameter', value: 4.2 }, fastener: null });
    type('diameter', '0');
    expect(panel.values()).toEqual({ error: 'Enter a positive diameter.' });
  });

  it('writes table counterbores implicitly and edited ones explicitly', () => {
    const { panel, tab, type, hidden } = openPanel();
    tab('style-tabs', 'Counterbore');
    expect(hidden('cbore-rows')).toBe(false);
    expect(panel.values()).toMatchObject({ style: { kind: 'counterbore', diameter: null, depth: null } });
    type('cbore-depth', '7.5');
    expect(panel.values()).toMatchObject({ style: { kind: 'counterbore', diameter: 11, depth: 7.5 } });
  });

  it('always writes a drilled hole\'s countersink explicitly', () => {
    const { panel, tab, select, type } = openPanel();
    tab('style-tabs', 'Countersink');
    select('type', 'drilled');
    type('diameter', '5');
    type('csink-diameter', '10');
    expect(panel.values()).toMatchObject({ style: { kind: 'countersink', diameter: 10, angle: 90 } });
  });

  it('carries the blind depth and the drill point, with 0 meaning a flat bottom', () => {
    const { panel, select, type, hidden } = openPanel();
    select('termination', 'blind');
    expect(hidden('blind-rows')).toBe(false);
    type('depth', '12');
    expect(panel.values()).toMatchObject({ depth: 12, tipAngle: 118 });
    type('tip-angle', '0');
    expect(panel.values()).toMatchObject({ depth: 12, tipAngle: null });
    type('depth', '-1');
    expect(panel.values()).toEqual({ error: 'Enter a positive depth.' });
  });

  it('switches to the inch catalog with the standard dropdown', () => {
    const { panel, select, input } = openPanel();
    select('standard', 'inch');
    expect(panel.sizeLabel).toBe('1/4');
    // 0.266 in in a millimetre document.
    expect(input('diameter').value).toBe('6.76');
  });

  it('prefills from a parsed statement in edit mode', () => {
    const { panel, input, hidden } = openPanel();
    const parsed: Extract<ParsedFeatureStatement, { feature: 'hole' }> = {
      feature: 'hole',
      size: { kind: 'fastener', label: '#10' },
      fastener: { type: 'clearance', fit: 'loose' },
      style: { kind: 'countersink', diameter: null, angle: null },
      depth: 8,
      tipAngle: null,
      placementTexts: ['bolt'],
      placementRefs: [{ line: 4, column: 0 }],
      scopeTexts: [],
      scopeRefs: [],
    };
    panel.showEdit(parsed);
    expect(panel.holeType).toBe('clearance');
    expect(panel.sizeLabel).toBe('#10');
    expect(panel.style).toBe('countersink');
    expect(hidden('csink-rows')).toBe(false);
    expect(input('standard').value).toBe('inch');
    expect(panel.values()).toMatchObject({
      size: { kind: 'fastener', label: '#10' },
      fastener: { type: 'clearance', fit: 'loose' },
      style: { kind: 'countersink', diameter: null, angle: null },
      depth: 8,
      tipAngle: null,
    });
  });

  it('draws the section with the focused field\'s dimension', () => {
    const { container, input, select } = openPanel();
    const illustration = () => container.querySelector('[data-role="illustration"] svg')!.outerHTML;
    expect(illustration()).toContain('⌀');
    select('termination', 'blind');
    input('depth').dispatchEvent(new Event('focus'));
    expect(illustration()).toContain('>depth<');
    input('depth').dispatchEvent(new Event('blur'));
    expect(illustration()).not.toContain('>depth<');
  });
});
