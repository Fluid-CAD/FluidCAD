// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyPanel } from '../src/interactive/create-feature/copy-panel';
import { LoftPanel } from '../src/interactive/create-feature/loft-panel';
import { PlanePanel } from '../src/interactive/create-feature/plane-panel';
import { RepeatPanel } from '../src/interactive/create-feature/repeat-panel';
import { SplitPanel } from '../src/interactive/create-feature/split-panel';
import { ModifyPanel } from '../src/interactive/modify-pick/modify-panel';
import type { VariableInfo } from '../src/ui/expression-core';
import './dom-reset';

// The split, repeat, copy, shell, plane and loft dialogs' typed-in rows take
// an expression under their ƒ the way the extrude's drill row does: a
// statement holding one (`{ keep: flag ? 'front' : 'back' }`, `centered:
// flag`, `.join(smooth ? 'tangent' : 'arc')`, `axes: side`,
// `.startCondition(kind, 1)`) opens the row in that mode with what it comes
// to beside it; left alone the row reads the expression back as it was; ƒ off
// lands the control on the resolved value, as a change; ƒ on seeds the input
// with the control's own value as source; typing writes the text, and an
// emptied input leaves the dialog nothing to write. A reference in the slot
// (`{ keep: side }`) seeds as the expression of its name — the same text,
// written bare either way.

const VARIABLES: VariableInfo[] = [
  { name: 'flag', initializer: "param('Flag', false, 'checkbox')", numeric: true, value: false },
  { name: 'smooth', initializer: 'true', numeric: true, value: true },
  { name: 'count', initializer: '7', numeric: true, value: 7 },
  { name: 'side', initializer: "'front'", numeric: false, value: 'front' },
  { name: 'frame', initializer: "'world'", numeric: false, value: 'world' },
];

const opened: { hide(): void }[] = [];

afterEach(() => {
  for (const panel of opened.splice(0)) {
    panel.hide();
  }
  document.body.innerHTML = '';
  document.dispatchEvent(new Event('pointerdown'));
});

/** The ƒ toggle, expression input and resolved note of the row named `name`, wherever it was built. */
function rowOf(root: HTMLElement, name: string) {
  const q = <T extends HTMLElement>(role: string) => root.querySelector<T>(`[data-role="${role}"]`)!;
  const toggle = () => q<HTMLButtonElement>(`expression-${name}`);
  const input = () => q<HTMLInputElement>(`expr-${name}`);
  const pressed = () => toggle().getAttribute('aria-pressed') === 'true';
  const resolved = () => {
    const note = q<HTMLElement>(`expression-line-${name}`).querySelector<HTMLElement>('[data-role="resolved"]')!;
    return note.hidden ? undefined : { text: note.textContent, warning: note.title || undefined };
  };
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const enter = () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const shown = (el: HTMLElement) => el.closest('.hidden') === null;
  return { q, toggle, input, pressed, resolved, type, enter, shown };
}

function mount<T extends { hide(): void }>(build: (container: HTMLElement) => T) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = build(container);
  opened.push(panel);
  return { container, panel };
}

describe('the split dialog\'s Keep dropdown', () => {
  function openPanel() {
    const { container, panel } = mount(c => new SplitPanel(c));
    const changes = vi.fn();
    const applies = vi.fn();
    panel.onChange = changes;
    panel.onApply = applies;
    panel.setScopeVariables(VARIABLES);
    const row = rowOf(container, 'keep');
    const select = () => row.q<HTMLSelectElement>('keep');
    const keep = () => {
      const values = panel.values();
      return 'error' in values ? values : values.keep;
    };
    return { panel, changes, applies, select, keep, ...row };
  }

  it('opens a statement\'s expression in expression mode with the option it comes to, and reads it back verbatim', () => {
    const { panel, pressed, input, select, resolved, shown, keep, changes } = openPanel();
    panel.showEdit({ keep: { expr: "flag ? 'back' : 'front'" }, planeLabel: "'xy'" });
    expect(pressed()).toBe(true);
    expect(input().value).toBe("flag ? 'back' : 'front'");
    expect(shown(input())).toBe(true);
    expect(shown(select())).toBe(false);
    expect(select().value).toBe('front');
    expect(resolved()).toEqual({ text: 'Front side', warning: undefined });
    expect(keep()).toEqual({ expr: "flag ? 'back' : 'front'" });
    expect(changes).not.toHaveBeenCalled();
  });

  it('seeds a reference as the expression of its name, and warns of a value that is no option\'s', () => {
    const { panel, input, resolved, keep, type } = openPanel();
    panel.showEdit({ keep: { ref: 'side' }, planeLabel: "'xy'" });
    expect(input().value).toBe('side');
    expect(resolved()).toEqual({ text: 'Front side', warning: undefined });
    expect(keep()).toEqual({ expr: 'side' });
    type('count');
    expect(resolved()).toEqual({ text: '7', warning: 'count is 7, which is not one of the options.' });
    expect(keep()).toEqual({ expr: 'count' });
  });

  it('ƒ off lands the dropdown on the resolved option, as a change; ƒ on seeds the chosen option as source', () => {
    const { panel, toggle, input, select, shown, keep, changes } = openPanel();
    panel.showEdit({ keep: { expr: "flag ? 'back' : 'front'" }, planeLabel: "'xy'" });
    toggle().click();
    expect(shown(select())).toBe(true);
    expect(keep()).toBe('front');
    expect(changes).toHaveBeenCalledTimes(1);
    select().value = 'back';
    select().dispatchEvent(new Event('change'));
    expect(keep()).toBe('back');
    toggle().click();
    expect(shown(input())).toBe(true);
    expect(input().value).toBe("'back'");
    expect(keep()).toEqual({ expr: "'back'" });
  });

  it('typing writes the text, Enter applies, and an emptied input leaves nothing to write; a fresh dialog opens on Both', () => {
    const { panel, toggle, type, enter, keep, applies, pressed } = openPanel();
    panel.show();
    expect(keep()).toBe('both');
    toggle().click();
    type('side');
    expect(keep()).toEqual({ expr: 'side' });
    enter();
    expect(applies).toHaveBeenCalledTimes(1);
    type(' ');
    expect(keep()).toEqual({ error: 'Keep needs an expression.' });
    panel.show();
    expect(pressed()).toBe(false);
    expect(keep()).toBe('both');
  });

  it('a click on the row\'s label text still opens the dropdown\'s label target, not the ƒ toggle beside it', () => {
    const { panel, select, pressed } = openPanel();
    panel.show();
    const label = select().closest('label')!;
    expect(label.htmlFor).toBe(select().id);
    label.querySelector('span')!.click();
    expect(pressed()).toBe(false);
  });
});

/** The edit-mode seed of a linear repeat or copy along the X axis, the centered flag as given. */
const linear = (centered: boolean | { expr: string }) => ({
  kind: 'linear' as const, directions: [{ count: 3, value: 20 }], spacingMode: 'offset' as const, centered,
  count: null, sweep: null, axisLabels: ["'x'"],
});

describe('the repeat dialog\'s Centered toggle', () => {
  function openPanel() {
    const { container, panel } = mount(c => new RepeatPanel(c));
    const changes = vi.fn();
    const applies = vi.fn();
    panel.onChange = changes;
    panel.onApply = applies;
    panel.setScopeVariables(VARIABLES);
    const row = rowOf(container, 'centered');
    const box = () => row.q<HTMLInputElement>('centered');
    const centered = () => {
      const values = panel.values();
      return 'error' in values ? values : values.kind === 'linear' ? values.centered : values.kind;
    };
    const line = () => row.q<HTMLElement>('expression-line-centered');
    const setKind = (kind: string) => {
      const select = row.q<HTMLSelectElement>('kind');
      select.value = kind;
      select.dispatchEvent(new Event('change'));
    };
    return { panel, changes, applies, box, centered, line, setKind, ...row };
  }

  it('opens a statement\'s expression in expression mode with the flag it comes to, and reads it back verbatim', () => {
    const { panel, pressed, input, box, resolved, shown, centered, changes } = openPanel();
    panel.showEdit({ ...linear({ expr: '!flag' }), angle: null, planeLabel: null });
    expect(pressed()).toBe(true);
    expect(input().value).toBe('!flag');
    expect(shown(box())).toBe(false);
    expect(box().disabled).toBe(true);
    expect(box().checked).toBe(true);
    expect(resolved()).toEqual({ text: 'true', warning: undefined });
    expect(centered()).toEqual({ expr: '!flag' });
    expect(changes).not.toHaveBeenCalled();
  });

  it('ƒ off lands the box on the resolved flag, as a change; ƒ on seeds the box\'s flag as source; typing writes the text', () => {
    const { panel, toggle, input, box, shown, centered, changes, type, enter, applies } = openPanel();
    panel.showEdit({ ...linear({ expr: '!flag' }), angle: null, planeLabel: null });
    toggle().click();
    expect(shown(box())).toBe(true);
    expect(box().disabled).toBe(false);
    expect(centered()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    toggle().click();
    expect(input().value).toBe('true');
    type('count > 4');
    expect(centered()).toEqual({ expr: 'count > 4' });
    enter();
    expect(applies).toHaveBeenCalledTimes(1);
    type('');
    expect(centered()).toEqual({ error: 'Centered needs an expression.' });
  });

  it('the expression line hides with the row on the kinds that take no centering, and comes back with it', () => {
    const { panel, line, setKind, shown, centered } = openPanel();
    panel.showEdit({ ...linear({ expr: 'flag' }), angle: null, planeLabel: null });
    expect(shown(line())).toBe(true);
    setKind('circular');
    expect(shown(line())).toBe(false);
    expect(centered()).toBe('circular');
    setKind('linear');
    expect(shown(line())).toBe(true);
    expect(centered()).toEqual({ expr: 'flag' });
    // A fresh dialog opens with the box, the mode off, and the line stays down.
    panel.show();
    expect(shown(line())).toBe(false);
    expect(centered()).toBe(false);
  });
});

describe('the copy dialog\'s Centered toggle', () => {
  function openPanel() {
    const { container, panel } = mount(c => new CopyPanel(c));
    const changes = vi.fn();
    panel.onChange = changes;
    panel.setScopeVariables(VARIABLES);
    const row = rowOf(container, 'centered');
    const box = () => row.q<HTMLInputElement>('centered');
    const centered = () => {
      const values = panel.values();
      return 'error' in values ? values : values.kind === 'linear' ? values.centered : values.kind;
    };
    return { panel, changes, box, centered, ...row };
  }

  it('opens a statement\'s expression in expression mode, reads it back, lands the box on ƒ off and seeds it on ƒ on', () => {
    const { panel, pressed, input, box, resolved, shown, centered, changes, toggle, type } = openPanel();
    panel.showEdit({ ...linear({ expr: 'smooth' }), skip: null });
    expect(pressed()).toBe(true);
    expect(input().value).toBe('smooth');
    expect(shown(box())).toBe(false);
    expect(resolved()).toEqual({ text: 'true', warning: undefined });
    expect(centered()).toEqual({ expr: 'smooth' });
    expect(changes).not.toHaveBeenCalled();
    toggle().click();
    expect(shown(box())).toBe(true);
    expect(box().checked).toBe(true);
    expect(centered()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    box().checked = false;
    box().dispatchEvent(new Event('change'));
    toggle().click();
    expect(input().value).toBe('false');
    type('count');
    expect(resolved()).toEqual({ text: '7', warning: 'count is 7, which is not true or false.' });
    expect(centered()).toEqual({ expr: 'count' });
    panel.show();
    expect(pressed()).toBe(false);
    expect(centered()).toBe(false);
  });
});

describe('the plane dialog\'s Axes tabs', () => {
  function openPanel() {
    const { container, panel } = mount(c => new PlanePanel(c));
    const changes = vi.fn();
    const applies = vi.fn();
    panel.onChange = changes;
    panel.onApply = applies;
    panel.setScopeVariables(VARIABLES);
    const row = rowOf(container, 'axes');
    const tabs = () => row.q<HTMLElement>('axes-tabs');
    const tab = (label: string) => [...tabs().querySelectorAll('button')].find(b => b.textContent === label)!;
    const axes = () => {
      const values = panel.values();
      return 'error' in values ? values : values.rotationAxes;
    };
    const titleX = () => row.q<HTMLInputElement>('rotate-x').title;
    return { panel, changes, applies, tabs, tab, axes, titleX, ...row };
  }

  /** The edit-mode seed of an offset plane off XY, the axes as given. */
  const edited = (rotationAxes: 'local' | 'world' | { expr: string } | { ref: string }) => ({
    type: 'offset' as const, offset: 10, rotateX: 15, rotateY: null, rotateZ: null, rotationAxes, position: null,
  });

  it('opens a statement\'s expression in expression mode with the tab it comes to, the tooltips following', () => {
    const { panel, pressed, input, tabs, resolved, shown, axes, titleX, changes } = openPanel();
    panel.showEdit(edited({ expr: "flag ? 'local' : 'world'" }));
    expect(pressed()).toBe(true);
    expect(input().value).toBe("flag ? 'local' : 'world'");
    expect(shown(tabs())).toBe(false);
    expect(resolved()).toEqual({ text: 'World', warning: undefined });
    expect(axes()).toEqual({ expr: "flag ? 'local' : 'world'" });
    expect(titleX()).toBe('Rotation around the world X axis');
    expect(changes).not.toHaveBeenCalled();
  });

  it('a reference seeds as its name; an unresolvable value warns and the tooltips say so', () => {
    const { panel, input, resolved, axes, type, titleX } = openPanel();
    panel.showEdit(edited({ ref: 'frame' }));
    expect(input().value).toBe('frame');
    expect(resolved()).toEqual({ text: 'World', warning: undefined });
    expect(axes()).toEqual({ expr: 'frame' });
    type('count');
    expect(resolved()).toEqual({ text: '7', warning: 'count is 7, which is not one of the options.' });
    expect(titleX()).toBe('Rotation around the X axis of the axes the expression names');
    expect(axes()).toEqual({ expr: 'count' });
  });

  it('ƒ off lands the tabs on the resolved choice, as a change; ƒ on seeds the current tab as source; Enter applies', () => {
    const { panel, toggle, input, tabs, tab, shown, axes, changes, enter, applies, type } = openPanel();
    panel.showEdit(edited({ expr: "flag ? 'local' : 'world'" }));
    toggle().click();
    expect(shown(tabs())).toBe(true);
    expect(axes()).toBe('world');
    expect(changes).toHaveBeenCalledTimes(1);
    tab('Local').click();
    expect(axes()).toBe('local');
    toggle().click();
    expect(input().value).toBe("'local'");
    expect(axes()).toEqual({ expr: "'local'" });
    enter();
    expect(applies).toHaveBeenCalledTimes(1);
    type('');
    expect(axes()).toEqual({ error: 'Axes needs an expression.' });
    panel.show();
    expect(axes()).toBe('local');
  });
});

describe('the loft dialog\'s condition types', () => {
  function openPanel() {
    const { container, panel } = mount(c => new LoftPanel(c));
    const changes = vi.fn();
    const applies = vi.fn();
    panel.onChange = changes;
    panel.onApply = applies;
    panel.setScopeVariables(VARIABLES);
    const start = rowOf(container, 'start-type');
    const end = rowOf(container, 'end-type');
    const select = (which: 'start' | 'end') => container.querySelector<HTMLSelectElement>(`[data-role="${which}-condition"] [data-role="type"]`)!;
    const magnitude = (which: 'start' | 'end') => container.querySelector<HTMLInputElement>(`[data-role="${which}-condition"] [data-role="magnitude"]`)!;
    const conditions = () => {
      const values = panel.values();
      return 'error' in values ? values : { start: values.startCondition, end: values.endCondition };
    };
    return { panel, changes, applies, start, end, select, magnitude, conditions };
  }

  it('opens a statement\'s expression on each end in expression mode, the magnitude in reach, and reads both back verbatim', () => {
    const { panel, start, end, select, magnitude, conditions, changes } = openPanel();
    panel.showEdit({
      op: 'add', thin: null,
      startCondition: { type: { expr: "smooth ? 'tangent' : 'normal'" }, magnitude: 2 },
      endCondition: { type: { ref: 'kind' }, magnitude: 'strength' },
    });
    expect(start.pressed()).toBe(true);
    expect(start.input().value).toBe("smooth ? 'tangent' : 'normal'");
    expect(start.shown(select('start'))).toBe(false);
    expect(start.resolved()).toEqual({ text: 'Tangent', warning: undefined });
    expect(magnitude('start').classList.contains('hidden')).toBe(false);
    expect(end.pressed()).toBe(true);
    expect(end.input().value).toBe('kind');
    // An unknown name resolves to nothing: no note, and the magnitude stays in reach all the same.
    expect(end.resolved()).toBeUndefined();
    expect(magnitude('end').classList.contains('hidden')).toBe(false);
    expect(conditions()).toEqual({
      start: { type: { expr: "smooth ? 'tangent' : 'normal'" }, magnitude: 2 },
      end: { type: { expr: 'kind' }, magnitude: 'strength' },
    });
    expect(changes).not.toHaveBeenCalled();
  });

  it('an expression coming to none reads as a condition the preview drops; ƒ off lands the select on None and hides the magnitude', () => {
    const { panel, start, select, magnitude, conditions, changes } = openPanel();
    panel.showEdit({
      op: 'add', thin: null, startCondition: { type: { expr: "flag ? 'normal' : 'none'" }, magnitude: 1 }, endCondition: null,
    });
    expect(start.resolved()).toEqual({ text: 'None', warning: undefined });
    expect(conditions()).toEqual({ start: { type: { expr: "flag ? 'normal' : 'none'" }, magnitude: 1 }, end: null });
    start.toggle().click();
    expect(select('start').value).toBe('none');
    expect(magnitude('start').classList.contains('hidden')).toBe(true);
    expect(conditions()).toEqual({ start: null, end: null });
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('ƒ on seeds the chosen type as source; typing writes the text, Enter applies, and an emptied input leaves nothing to write', () => {
    const { panel, end, select, magnitude, conditions, applies } = openPanel();
    panel.show();
    select('end').value = 'normal';
    select('end').dispatchEvent(new Event('change'));
    expect(conditions()).toEqual({ start: null, end: { type: 'normal', magnitude: 1 } });
    end.toggle().click();
    expect(end.input().value).toBe("'normal'");
    expect(magnitude('end').classList.contains('hidden')).toBe(false);
    end.type("smooth ? 'tangent' : 'normal'");
    expect(end.resolved()).toEqual({ text: 'Tangent', warning: undefined });
    expect(conditions()).toEqual({ start: null, end: { type: { expr: "smooth ? 'tangent' : 'normal'" }, magnitude: 1 } });
    end.enter();
    expect(applies).toHaveBeenCalledTimes(1);
    end.type('');
    expect(conditions()).toEqual({ error: 'End condition needs an expression.' });
    panel.show();
    expect(end.pressed()).toBe(false);
    expect(conditions()).toEqual({ start: null, end: null });
  });
});

describe('the shell dialog\'s Join type dropdown', () => {
  function openPanel() {
    const { container, panel } = mount(c => Object.assign(new ModifyPanel(c), { hide: () => {} }));
    const changes = vi.fn();
    const applies = vi.fn();
    panel.onJoinChange = changes;
    panel.onApply = applies;
    panel.setScopeVariables(VARIABLES);
    panel.setVisible(true);
    panel.setJoinVisible(true);
    const row = rowOf(container, 'join');
    const select = () => row.q<HTMLSelectElement>('join');
    return { panel, changes, applies, select, ...row };
  }

  it('opens a statement\'s expression in expression mode with the option it comes to, and reads it back verbatim', () => {
    const { panel, pressed, input, select, resolved, shown, changes } = openPanel();
    panel.setJoin({ expr: "smooth ? 'tangent' : 'arc'" });
    expect(pressed()).toBe(true);
    expect(input().value).toBe("smooth ? 'tangent' : 'arc'");
    expect(shown(select())).toBe(false);
    expect(select().value).toBe('tangent');
    expect(resolved()).toEqual({ text: 'Tangent', warning: undefined });
    expect(panel.readJoin()).toEqual({ value: { expr: "smooth ? 'tangent' : 'arc'" } });
    expect(changes).not.toHaveBeenCalled();
  });

  it('ƒ off lands the dropdown on the resolved option, as a change; ƒ on seeds the chosen option; typing writes, Enter applies', () => {
    const { panel, toggle, input, select, shown, changes, type, enter, applies } = openPanel();
    panel.setJoin({ expr: "smooth ? 'tangent' : 'arc'" });
    toggle().click();
    expect(shown(select())).toBe(true);
    expect(panel.readJoin()).toEqual({ value: 'tangent' });
    expect(changes).toHaveBeenCalledTimes(1);
    select().value = 'intersection';
    select().dispatchEvent(new Event('change'));
    toggle().click();
    expect(input().value).toBe("'intersection'");
    type('side');
    expect(panel.readJoin()).toEqual({ value: { expr: 'side' } });
    enter();
    expect(applies).toHaveBeenCalledTimes(1);
    type('  ');
    expect(panel.readJoin()).toEqual({ error: 'Join type needs an expression.' });
    // The join expression's input owns Enter, so the dialog's document-level Enter leaves it alone.
    expect(panel.ownsFocus(input())).toBe(true);
    // A fresh arming seeds the default, the mode off.
    panel.setJoin('arc');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(panel.readJoin()).toEqual({ value: 'arc' });
  });
});
