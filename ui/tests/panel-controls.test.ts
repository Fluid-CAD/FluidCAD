// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ResultKindEffect, ResultKindTabs, ThinControl } from '../src/interactive/create-feature/panel-controls';

// The Solid / Surface row the four profile dialogs share, and what a
// surface does to the rest of a dialog: the operation row, the scope row,
// the thin-wall control and a dialog's own solid-only controls.

afterEach(() => {
  document.body.innerHTML = '';
});

function host(): HTMLDivElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** The thin control's toggle row and its checkbox. */
function thinParts(container: HTMLElement) {
  const checkbox = container.querySelector<HTMLInputElement>('[data-role="thin"]')!;
  return { checkbox, toggle: checkbox.closest('label')! };
}

describe('ResultKindTabs', () => {
  it('offers Solid and Surface, Solid first and chosen', () => {
    const el = host();
    const tabs = new ResultKindTabs(el);
    const buttons = [...el.querySelectorAll('button')];
    expect(buttons.map(b => b.textContent)).toEqual(['Solid', 'Surface']);
    expect(buttons[0].title).toBe('Make a solid');
    expect(buttons[1].title).toContain('.surface()');
    expect(tabs.kind).toBe('solid');
  });

  it('reports a click, and takes a programmatic choice without one', () => {
    const el = host();
    const tabs = new ResultKindTabs(el);
    let changes = 0;
    tabs.onChange = () => changes++;
    el.querySelectorAll('button')[1].click();
    expect(tabs.kind).toBe('surface');
    expect(changes).toBe(1);
    tabs.setKind('solid');
    expect(tabs.kind).toBe('solid');
    expect(changes).toBe(1);
    tabs.setKind('surface');
    tabs.reset();
    expect(tabs.kind).toBe('solid');
  });
});

describe('ResultKindEffect', () => {
  /** A dialog's controls and a `syncControls()` in the order the dialogs run it. */
  function dialog() {
    const opTabsHost = host();
    const drill = host();
    const thinHost = host();
    const thin = new ThinControl(thinHost);
    const scope = { visible: true, setVisible(visible: boolean) { this.visible = visible; } };
    const effect = new ResultKindEffect({ opTabsHost, thin, scope, solidOnly: [drill] });
    const state = { op: 'add' as 'add' | 'new', faceProfile: false };
    const sync = (kind: 'solid' | 'surface') => {
      thin.setBlocked(state.faceProfile, 'A face cannot be extruded thin');
      scope.setVisible(state.op !== 'new');
      effect.apply(kind);
    };
    return { opTabsHost, drill, thinHost, thin, scope, state, sync, effect };
  }

  it('hides the operation row, the scope row and the solid-only controls for a surface, and brings them back for a solid', () => {
    const { opTabsHost, drill, scope, sync } = dialog();
    sync('surface');
    expect(opTabsHost.style.display).toBe('none');
    expect(drill.style.display).toBe('none');
    expect(scope.visible).toBe(false);
    sync('solid');
    expect(opTabsHost.style.display).toBe('');
    expect(drill.style.display).toBe('');
    expect(scope.visible).toBe(true);
  });

  it('blocks the thin control with its reason for a surface, unchecking it, and lifts the block for a solid', () => {
    const { thinHost, sync } = dialog();
    const { checkbox, toggle } = thinParts(thinHost);
    checkbox.checked = true;
    sync('surface');
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(false);
    expect(toggle.title).toBe('A surface has no walls to thicken');
    sync('solid');
    expect(checkbox.disabled).toBe(false);
    expect(toggle.title).toBe('');
  });

  it("leaves the dialog's own rules standing for a solid", () => {
    const { thinHost, scope, state, sync, effect, thin, drill } = dialog();
    const { checkbox, toggle } = thinParts(thinHost);
    state.faceProfile = true;
    state.op = 'new';
    sync('surface');
    sync('solid');
    expect(checkbox.disabled).toBe(true);
    expect(toggle.title).toBe('A face cannot be extruded thin');
    expect(scope.visible).toBe(false);

    // A dialog's own block outlives the surface's being lifted, in either order.
    effect.apply('surface');
    thin.setBlocked(false, '');
    expect(checkbox.disabled).toBe(true);
    expect(toggle.title).toBe('A surface has no walls to thicken');
    effect.apply('solid');
    expect(checkbox.disabled).toBe(false);

    // A dialog's own hiding of a solid-only control stays under the effect.
    drill.classList.add('hidden');
    effect.apply('surface');
    effect.apply('solid');
    expect(drill.classList.contains('hidden')).toBe(true);
  });
});
