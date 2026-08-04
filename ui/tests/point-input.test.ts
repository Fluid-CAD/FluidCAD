// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { PointInput, PointCommit } from '../src/ui/point-input';
import { VariableInfo } from '../src/ui/expression-core';

// jsdom does not implement scrollIntoView; the dropdown calls it when a
// suggestion is highlighted.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

const VARS: VariableInfo[] = [
  { name: 'width', initializer: '50' },
  { name: 'plate', initializer: 'extrude(10)', numeric: false },
];

type Harness = {
  input: PointInput;
  container: HTMLElement;
  x: HTMLInputElement;
  y: HTMLInputElement;
  commits: PointCommit[];
};

function mount(opts: {
  value?: [number, number];
  origin?: [number, number] | null;
  variables?: VariableInfo[];
  numericOnly?: boolean;
} = {}): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const input = new PointInput(container);
  const commits: PointCommit[] = [];
  input.show({
    value: opts.value ?? [10, 20],
    variables: opts.variables ?? VARS,
    origin: opts.origin,
    numericOnly: opts.numericOnly,
    onCommit: (r) => commits.push(r),
  });
  return {
    input,
    container,
    x: container.querySelector('.point-input-x')!,
    y: container.querySelector('.point-input-y')!,
    commits,
  };
}

function type(field: HTMLInputElement, text: string): void {
  field.focus();
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(field: HTMLInputElement, k: string): void {
  field.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

describe('PointInput readout', () => {
  it('shows the live cursor position in both fields', () => {
    const h = mount({ value: [10.004, 20.5] });
    expect(h.x.value).toBe('10');
    expect(h.y.value).toBe('20.5');
  });

  it('tracks the cursor until a field is typed into', () => {
    const h = mount({ value: [10, 20] });
    h.input.updateValue([33, 44]);
    expect(h.x.value).toBe('33');
    expect(h.y.value).toBe('44');

    type(h.x, '100');
    h.input.updateValue([55, 66]);
    expect(h.x.value).toBe('100');
    expect(h.y.value).toBe('66');
  });
});

describe('PointInput commit', () => {
  it('places an exact point when both axes are typed', () => {
    const h = mount();
    type(h.x, '100');
    key(h.x, 'Tab');
    type(h.y, '103');
    key(h.y, 'Enter');

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].xExpr).toBe('100');
    expect(h.commits[0].yExpr).toBe('103');
    expect(h.commits[0].value).toEqual([100, 103]);
    expect(h.commits[0].typed).toBe(true);
    expect(h.input.isVisible).toBe(false);
  });

  it('never rounds a typed value', () => {
    const h = mount({ value: [1.239, 2.341] });
    type(h.x, '123.456');
    key(h.x, 'Tab');
    key(h.y, 'Enter');

    const pick = h.commits[0];
    expect(pick.xExpr).toBe('123.456');
    // The untyped axis still comes from the cursor, rounded to drawing precision.
    expect(pick.yExpr).toBe('2.34');
  });

  it('places at the cursor when Enter is pressed with nothing typed', () => {
    const h = mount({ value: [7, 8] });
    h.x.focus();
    key(h.x, 'Enter');

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].value).toEqual([7, 8]);
    expect(h.commits[0].typed).toBe(false);
  });
});

describe('PointInput axis lock', () => {
  it('pins one axis and leaves the other on the cursor', () => {
    const h = mount({ value: [10, 20] });
    type(h.x, '100');
    key(h.x, 'Tab');

    // Pinning alone must not commit — the click does.
    expect(h.commits).toHaveLength(0);
    expect(h.input.getLocks()).toEqual({ x: 100, y: null });

    const pick = h.input.resolvePick([42, 97.126]);
    expect(pick.xExpr).toBe('100');
    expect(pick.yExpr).toBe('97.13');
    expect(pick.value).toEqual([100, 97.13]);
  });

  it('pins via Enter and moves focus to the free axis', () => {
    const h = mount();
    type(h.x, '100');
    key(h.x, 'Enter');

    expect(h.commits).toHaveLength(0);
    expect(document.activeElement).toBe(h.y);
    expect(h.input.getLocks().x).toBe(100);
  });

  it('resolves an arithmetic expression over variables for the lock', () => {
    const h = mount();
    type(h.x, 'width / 2');
    key(h.x, 'Tab');

    expect(h.input.getLocks().x).toBe(25);
    const pick = h.input.resolvePick([1, 2]);
    expect(pick.xExpr).toBe('width / 2');
    expect(pick.value).toEqual([25, 2]);
  });

  it('reports no lock for an axis whose value is not statically resolvable', () => {
    const h = mount();
    // `plate` holds a feature result, so the expression has no numeric value.
    type(h.x, 'plate * 2');
    key(h.x, 'Tab');

    // The expression is still committed, it just cannot drive a guide line.
    expect(h.input.getLocks().x).toBeNull();
    expect(h.input.resolvePick([1, 2]).xExpr).toBe('plate * 2');
  });
});

describe('PointInput variables', () => {
  it('uses an existing variable as the coordinate expression', () => {
    const h = mount();
    type(h.x, 'width');
    key(h.x, 'Tab');

    const pick = h.input.resolvePick([1, 2]);
    expect(pick.xExpr).toBe('width');
    expect(pick.newVariables).toEqual([]);
    expect(h.input.getLocks().x).toBe(50);
  });

  it('accepts the highlighted suggestion and advances on Tab', () => {
    const h = mount();
    type(h.x, 'wid');
    key(h.x, 'Tab');

    expect(h.x.value).toBe('width');
    expect(h.input.getLocks().x).toBe(50);
    expect(document.activeElement).toBe(h.y);
  });

  it('hides non-numeric bindings from the suggestions', () => {
    const h = mount();
    type(h.x, 'pla');
    // `plate` holds a feature result, not a value — it stays out of the list
    // even though it matches. Only the "declare pla" offer is left.
    expect(h.container.querySelector('.point-dropdown')!.textContent).not.toContain('plate');
  });

  it('declares a new variable per axis', () => {
    const h = mount();
    type(h.x, 'cx = 100');
    key(h.x, 'Tab');
    type(h.y, 'cy = 103');
    key(h.y, 'Enter');

    const pick = h.commits[0];
    expect(pick.xExpr).toBe('cx');
    expect(pick.yExpr).toBe('cy');
    expect(pick.newVariables).toEqual([
      { name: 'cx', initializer: '100' },
      { name: 'cy', initializer: '103' },
    ]);
  });

  it('refuses a name that is already defined and keeps the pill open', () => {
    const h = mount();
    type(h.x, 'width = 10');
    key(h.x, 'Enter');

    expect(h.commits).toHaveLength(0);
    expect(h.input.isVisible).toBe(true);
    expect(h.container.querySelector('.point-error')!.textContent)
      .toContain("'width' is already defined");
  });

  it('rejects non-numeric text when numericOnly is set', () => {
    const h = mount({ numericOnly: true });
    type(h.x, 'width');
    key(h.x, 'Enter');

    expect(h.commits).toHaveLength(0);
    expect(h.container.querySelector('.point-error')!.textContent)
      .toContain('numeric');
  });
});

describe('PointInput relative mode', () => {
  it('stays absolute without an origin to measure from', () => {
    const h = mount({ origin: null });
    h.input.setRelative(true);
    // The labels are the only state indicator now, so they must not claim
    // relative when there is nothing to be relative to.
    expect(h.container.querySelector('.point-label-x')!.textContent).toBe('X');
    expect(h.input.resolvePick([1, 2]).relative).toBeUndefined();
  });

  it('shows offsets from the origin and commits them as a delta', () => {
    const h = mount({ value: [130, 45], origin: [100, 40] });
    h.input.setRelative(true);

    expect(h.x.value).toBe('30');
    expect(h.y.value).toBe('5');
    expect(h.container.querySelector('.point-label-x')!.textContent).toBe('ΔX');

    type(h.x, '20');
    key(h.x, 'Tab');
    type(h.y, '5');
    key(h.y, 'Enter');

    const pick = h.commits[0];
    expect(pick.relative).toEqual({ dx: '20', dy: '5' });
    // The absolute position still resolves, for the geometry preview.
    expect(pick.value).toEqual([120, 45]);
  });

  it('opens already relative when the viewport toggle is on', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const input = new PointInput(container);
    input.show({
      value: [130, 45], variables: [], origin: [100, 40], relative: true, onCommit: () => {},
    });
    expect(container.querySelector<HTMLInputElement>('.point-input-x')!.value).toBe('30');
  });

  // The pill is docked, so its own buttons are reachable again — this is the
  // whole reason it stopped following the cursor.
  it('toggles from its own button and reports the change', () => {
    const h = mount({ value: [130, 45], origin: [100, 40] });
    const reported: boolean[] = [];
    h.input.onRelativeToggle = (r) => reported.push(r);

    const relBtn = h.container.querySelector<HTMLButtonElement>('.point-rel-btn')!;
    expect(h.container.querySelector('.point-rel-wrap')!.classList).not.toContain('hidden');

    relBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(reported).toEqual([true]);
    expect(h.x.value).toBe('30');

    relBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(reported).toEqual([true, false]);
    expect(h.x.value).toBe('130');
  });

  it('hides its own button when there is no origin', () => {
    const h = mount({ origin: null });
    expect(h.container.querySelector('.point-rel-wrap')!.classList).toContain('hidden');
  });

  it('clears pinned axes when the frame of reference flips', () => {
    const h = mount({ value: [130, 45], origin: [100, 40] });
    type(h.x, '120');
    key(h.x, 'Tab');
    expect(h.input.getLocks().x).toBe(120);

    h.input.setRelative(true);
    expect(h.input.getLocks().x).toBeNull();
  });
});

describe('PointInput keyboard entry', () => {
  it('opens the X field on a digit and seeds it with that keystroke', () => {
    const h = mount();
    const consumed = h.input.handleTriggerKey(
      new KeyboardEvent('keydown', { key: '1', cancelable: true }),
    );

    expect(consumed).toBe(true);
    expect(document.activeElement).toBe(h.x);
    expect(h.x.value).toBe('1');
  });

  // Coordinates are expressions, so a variable name has to be typeable
  // straight in — not only digits.
  it.each(['-', '.', 'w', 'c'])('opens on %s', (k) => {
    const h = mount();
    expect(h.input.handleTriggerKey(new KeyboardEvent('keydown', { key: k, cancelable: true })))
      .toBe(true);
    expect(h.x.value).toBe(k);
  });

  it('leaves Space and the bare modifiers alone', () => {
    // Space cycles the polyline mode; the modifiers drive ortho overrides.
    for (const key of [' ', 'Shift', 'Control', 'Meta', 'Alt']) {
      const h = mount();
      expect(h.input.handleTriggerKey(new KeyboardEvent('keydown', { key }))).toBe(false);
    }
  });

  it('ignores modifier chords, repeats and non-printable keys', () => {
    const h = mount();
    const ignored = [
      new KeyboardEvent('keydown', { key: '1', ctrlKey: true }),
      new KeyboardEvent('keydown', { key: '1', repeat: true }),
      new KeyboardEvent('keydown', { key: 'Enter' }),
      new KeyboardEvent('keydown', { key: 'ArrowLeft' }),
      new KeyboardEvent('keydown', { key: 'F2' }),
    ];
    for (const e of ignored) {
      expect(h.input.handleTriggerKey(e)).toBe(false);
    }
    expect(document.activeElement).not.toBe(h.x);
  });

  it('yields to another focused field', () => {
    const h = mount();
    const other = document.createElement('input');
    document.body.appendChild(other);
    const e = new KeyboardEvent('keydown', { key: '1', cancelable: true });
    Object.defineProperty(e, 'target', { value: other });

    expect(h.input.handleTriggerKey(e)).toBe(false);
  });
});

describe('PointInput escape', () => {
  it('drops typing and locks on the first press, then declines the second', () => {
    const h = mount({ value: [10, 20] });
    type(h.x, '100');
    key(h.x, 'Tab');

    expect(h.input.handleEscape()).toBe(true);
    expect(h.input.getLocks()).toEqual({ x: null, y: null });
    expect(h.input.isVisible).toBe(true);
    expect(h.x.value).toBe('10');

    // Clean pill: the tool gets the Escape instead.
    expect(h.input.handleEscape()).toBe(false);
  });
});
