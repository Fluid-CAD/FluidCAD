// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { closeSectionMenu, isSectionMenuOpen, showSectionMenu } from '../src/interactive/section-view/section-menu';

function mount(): { host: HTMLElement; anchor: HTMLButtonElement } {
  const host = document.createElement('div');
  const anchor = document.createElement('button');
  host.appendChild(anchor);
  document.body.appendChild(host);
  return { host, anchor };
}

function rows(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('button')];
}

afterEach(() => {
  closeSectionMenu();
  document.body.innerHTML = '';
});

describe('showSectionMenu', () => {
  it('lists None, every view (disabled ones with their reason) and the create row', () => {
    const { host, anchor } = mount();
    const onSelect = vi.fn();
    const onNew = vi.fn();
    const menu = showSectionMenu(host, anchor, {
      entries: [
        { key: 'a', label: 'A-A' },
        { key: 'b', label: 'Broken', disabledReason: 'did not build' },
      ],
      activeKey: 'a',
      onSelect,
      onNew,
      canCreate: true,
    });
    const labels = rows(menu).map(r => r.textContent?.trim());
    expect(labels).toEqual(['None', 'A-A', 'Broken', 'New section view…']);
    expect(rows(menu).map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', null]);
    expect(rows(menu)[2].disabled).toBe(true);
    expect(rows(menu)[2].title).toBe('did not build');
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
    expect(isSectionMenuOpen()).toBe(true);

    rows(menu)[1].click();
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(isSectionMenuOpen()).toBe(false);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
  });

  it('None selects null, the create row fires onNew, and a read-only host has no create row', () => {
    const { host, anchor } = mount();
    const onSelect = vi.fn();
    const onNew = vi.fn();
    let menu = showSectionMenu(host, anchor, { entries: [], activeKey: null, onSelect, onNew, canCreate: true });
    rows(menu)[0].click();
    expect(onSelect).toHaveBeenCalledWith(null);

    menu = showSectionMenu(host, anchor, { entries: [], activeKey: null, onSelect, onNew, canCreate: true });
    rows(menu)[1].click();
    expect(onNew).toHaveBeenCalledTimes(1);

    menu = showSectionMenu(host, anchor, { entries: [{ key: 'a', label: 'A-A' }], activeKey: null, onSelect, onNew, canCreate: false });
    expect(rows(menu).map(r => r.textContent?.trim())).toEqual(['None', 'A-A']);
  });

  it('opens to the left of the anchor, top-aligned, and only one menu at a time', () => {
    const { host, anchor } = mount();
    host.getBoundingClientRect = () => ({ top: 100, left: 0, right: 800, bottom: 700, width: 800, height: 600, x: 0, y: 100, toJSON: () => ({}) });
    anchor.getBoundingClientRect = () => ({ top: 200, left: 750, right: 782, bottom: 232, width: 32, height: 32, x: 750, y: 200, toJSON: () => ({}) });
    const first = showSectionMenu(host, anchor, { entries: [], activeKey: null, onSelect: () => {}, onNew: () => {}, canCreate: false });
    expect(first.style.top).toBe('100px');
    expect(first.style.right).toBe(`${800 - 750 + 6}px`);
    const second = showSectionMenu(host, anchor, { entries: [], activeKey: null, onSelect: () => {}, onNew: () => {}, canCreate: false });
    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);
  });
});
