// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopBarActions } from '../src/ui/top-bar-actions';

// A host's own top-bar button changed in place (ui-packages-plan N4, U6):
// `setAction` turns Share into Publish — icon, tooltip, handler and the
// collapsed menu's row — and back, without a second button.

const SHARE_ICON = '<svg data-icon="share"></svg>';
const PUBLISH_ICON = '<svg data-icon="publish"></svg>';

afterEach(() => {
  delete (window as any).matchMedia;
  document.body.innerHTML = '';
});

function mount(collapsed = false) {
  if (collapsed) {
    (window as any).matchMedia = () => ({ matches: true, addEventListener() {} });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const bar = new TopBarActions(container, {});
  const onShare = vi.fn();
  const onPublish = vi.fn();
  const share = { icon: SHARE_ICON, title: 'Share this model in the FluidCAD viewer', label: 'Share', onClick: onShare };
  const publish = { icon: PUBLISH_ICON, title: 'Publish this package on the hub', label: 'Publish', look: 'accent' as const, onClick: onPublish };
  const button = bar.addAction(share);
  return { container, bar, button, share, publish, onShare, onPublish };
}

describe('TopBarActions.setAction', () => {
  it('swaps the icon, the tooltip and the handler, both ways', () => {
    const h = mount();
    expect(h.button.title).toBe('Share this model in the FluidCAD viewer');
    expect(h.button.querySelector('[data-icon="share"]')).not.toBeNull();

    expect(h.button.querySelector('[data-ref="action-label"]')).toBeNull();
    expect(h.button.classList.contains('btn-square')).toBe(true);

    h.bar.setAction(h.button, h.publish);
    expect(h.button.title).toBe('Publish this package on the hub');
    expect(h.button.getAttribute('aria-label')).toBe('Publish this package on the hub');
    expect(h.button.querySelector('[data-icon="publish"]')).not.toBeNull();
    expect(h.button.querySelector('[data-icon="share"]')).toBeNull();
    // Publish is the word alone in a bordered accent button (its icon is kept, hidden, for the menu row); Share stays the icon alone.
    expect(h.button.querySelector('[data-ref="action-label"]')!.textContent).toBe('Publish');
    expect(h.button.classList.contains('btn-square')).toBe(false);
    expect(h.button.classList.contains('btn-outline')).toBe(true);
    expect(h.button.classList.contains('btn-accent')).toBe(true);
    expect(h.button.firstElementChild!.classList.contains('hidden')).toBe(true);
    h.button.click();
    expect(h.onPublish).toHaveBeenCalledTimes(1);
    expect(h.onShare).not.toHaveBeenCalled();

    h.bar.setAction(h.button, h.share);
    expect(h.button.title).toBe('Share this model in the FluidCAD viewer');
    expect(h.button.querySelector('[data-icon="share"]')).not.toBeNull();
    expect(h.button.querySelector('[data-ref="action-label"]')).toBeNull();
    expect(h.button.classList.contains('btn-square')).toBe(true);
    expect(h.button.classList.contains('btn-accent')).toBe(false);
    expect(h.button.firstElementChild!.classList.contains('hidden')).toBe(false);
    h.button.click();
    expect(h.onShare).toHaveBeenCalledTimes(1);
    expect(h.onPublish).toHaveBeenCalledTimes(1);
    // Still the one button in the host's slot.
    expect(h.button.parentElement!.querySelectorAll('button')).toHaveLength(1);
  });

  it('an action without a label on the bar falls back to its title in the menu row', () => {
    const h = mount(true);
    h.bar.setAction(h.button, { icon: PUBLISH_ICON, title: 'Publish this package on the hub', onClick: h.onPublish });
    h.container.querySelector<HTMLButtonElement>('button[title="Actions"]')!.click();
    expect(h.container.querySelector('[data-panel="menu"] button span.flex-1')!.textContent).toBe('Publish this package on the hub');
  });

  it('the collapsed menu lists the new row, and an open menu closes on the swap', () => {
    const h = mount(true);
    const menuBtn = h.container.querySelector<HTMLButtonElement>('button[title="Actions"]')!;
    expect(menuBtn.classList.contains('hidden')).toBe(false);
    menuBtn.click();
    const rowLabels = () => [...h.container.querySelectorAll('[data-panel="menu"] button span.flex-1')].map((el) => el.textContent);
    expect(rowLabels()[0]).toBe('Share');

    h.bar.setAction(h.button, h.publish);
    expect(h.container.querySelector('[data-panel="menu"]')).toBeNull();
    menuBtn.click();
    expect(rowLabels()[0]).toBe('Publish');
    const row = h.container.querySelector<HTMLButtonElement>('[data-panel="menu"] button')!;
    expect(row.querySelector('[data-icon="publish"]')).not.toBeNull();
    row.click();
    expect(h.onPublish).toHaveBeenCalledTimes(1);
    expect(h.container.querySelector('[data-panel="menu"]')).toBeNull();

    h.bar.setAction(h.button, h.share);
    menuBtn.click();
    expect(rowLabels()[0]).toBe('Share');
  });

  it('refuses a button it did not add', () => {
    const h = mount();
    expect(() => h.bar.setAction(document.createElement('button'), h.publish)).toThrow(/addAction/);
  });
});
