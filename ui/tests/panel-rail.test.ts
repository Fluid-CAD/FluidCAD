// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PanelRail, type PanelRailHandlers } from '../src/ui/panel-rail';

// The rail that replaced the top bar's hamburger: a latch per docked surface.
// What matters is that the latch always reflects the surface rather than a
// remembered click — the pane and the panels are toggled from the keyboard and
// the desktop menu too — and that a host without a code editor gets no button
// for one.

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
});
