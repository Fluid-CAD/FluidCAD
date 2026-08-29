// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelRail, type PanelRailHandlers } from '../src/ui/panel-rail';

// The rail that replaced the top bar's hamburger: a latch per docked surface.
// What matters is that the latch always reflects the surface rather than a
// remembered click — the pane and the panels are toggled from the keyboard and
// the desktop menu too — that a host without a code editor gets no button for
// one, and that a narrow window drops the bar for floating circles without the
// shell left behind eating the scene's drags.

/**
 * Stands in for the float media query, which jsdom never matches on its own.
 * Returns a setter that fires `change` the way a real resize past the
 * breakpoint would.
 */
function stubFloatQuery(initial: boolean): (matches: boolean) => void {
  const listeners: (() => void)[] = [];
  const query = {
    matches: initial,
    addEventListener: (_: string, fn: () => void) => { listeners.push(fn); },
    removeEventListener: () => undefined,
  };
  vi.stubGlobal('matchMedia', () => query);
  return (matches: boolean) => {
    query.matches = matches;
    listeners.forEach((fn) => fn());
  };
}

afterEach(() => vi.unstubAllGlobals());

function mount(handlers: Partial<PanelRailHandlers> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let treeVisible = false;
  let editorOpen = false;
  const rail = new PanelRail(container, {
    onToggleTree: () => { treeVisible = !treeVisible; },
    isTreeVisible: () => treeVisible,
    onToggleEditor: () => { editorOpen = !editorOpen; },
    isEditorOpen: () => editorOpen,
    ...handlers,
  });
  const buttons = () => [...container.querySelectorAll('button')];
  return {
    container,
    rail,
    shell: () => container.firstElementChild as HTMLElement,
    buttons,
    button: (label: string) =>
      buttons().find((b) => b.getAttribute('aria-label') === label)!,
    setEditorOpen: (open: boolean) => { editorOpen = open; },
  };
}

describe('panel rail', () => {
  it('offers one button per surface, editor first', () => {
    const h = mount();
    expect(h.buttons().map((b) => b.getAttribute('aria-label')))
      .toEqual(['Code editor', 'Feature tree']);
  });

  it('drops the editor button on a host that has no editor', () => {
    const h = mount({ onToggleEditor: undefined, isEditorOpen: undefined });
    expect(h.buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Feature tree']);
  });

  it('latches a button when its surface opens, and releases it again', () => {
    const h = mount();
    const tree = h.button('Feature tree');
    expect(tree.getAttribute('aria-pressed')).toBe('false');

    tree.click();
    expect(tree.className).toContain('btn-primary');
    expect(tree.getAttribute('aria-pressed')).toBe('true');

    tree.click();
    expect(tree.className).not.toContain('btn-primary');
    expect(tree.getAttribute('aria-pressed')).toBe('false');
  });

  it('follows a toggle it did not make (Ctrl+B, the desktop menu) on sync', () => {
    const h = mount();
    h.setEditorOpen(true);
    expect(h.button('Code editor').getAttribute('aria-pressed')).toBe('false');

    h.rail.sync();
    expect(h.button('Code editor').getAttribute('aria-pressed')).toBe('true');
  });

  it('renames the tree button for the workbench the scene mounted', () => {
    let kind = 'part';
    const h = mount({ treeLabel: () => (kind === 'assembly' ? 'Parts' : 'Feature tree') });
    expect(h.button('Feature tree').parentElement!.dataset.tip).toBe('Feature tree');

    kind = 'assembly';
    h.rail.sync();
    expect(h.button('Parts').parentElement!.dataset.tip).toBe('Parts');
  });

  it('publishes the width everything docked to its right clears', () => {
    // The editor pane reads it directly and --fluidcad-scene-left folds it in
    // for the scene and its overlays; unpublished, they all sit under the rail.
    document.documentElement.style.removeProperty('--fluidcad-rail-width');
    mount();
    expect(document.documentElement.style.getPropertyValue('--fluidcad-rail-width')).toBe('48px');
  });

  it('never lets a click hold focus (a latch would lose its styling)', () => {
    const h = mount();
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    h.button('Feature tree').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('calls the handler exactly once per click', () => {
    const onToggleTree = vi.fn();
    const h = mount({ onToggleTree, isTreeVisible: () => false });
    h.button('Feature tree').click();
    expect(onToggleTree).toHaveBeenCalledTimes(1);
  });

  it('floats the buttons as circles once the window is too narrow for a bar', () => {
    stubFloatQuery(true);
    const h = mount();
    expect(h.shell().className).not.toContain('panel-bg');
    expect(h.shell().className).not.toContain('bottom-0');
    for (const button of h.buttons()) {
      expect(button.className).toContain('btn-circle');
    }
  });

  it('hands the scene back the drags the floating shell covers', () => {
    // Docked it is real chrome and nothing is behind it; floating, everything
    // between the circles is scene.
    stubFloatQuery(true);
    const h = mount();
    expect(h.shell().className).toContain('pointer-events-none');
    expect(h.button('Feature tree').parentElement!.className).toContain('pointer-events-auto');
  });

  it('swaps shape when the window crosses the breakpoint, latches intact', () => {
    const setFloating = stubFloatQuery(false);
    const h = mount();
    h.button('Feature tree').click();
    expect(h.button('Feature tree').className).toContain('btn-square');

    setFloating(true);
    expect(h.button('Feature tree').className).toContain('btn-circle');
    expect(h.button('Feature tree').getAttribute('aria-pressed')).toBe('true');
    expect(h.button('Code editor').className).toContain('panel-bg');
  });
});
