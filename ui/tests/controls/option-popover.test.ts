// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChoiceImage, OptionPopover, type ChoiceItem, type OptionPopoverOptions } from '../../src/ui/controls';

// The floating listbox on its own: what a list and a grid render, group
// headings, the search box, the keys, what closes it, where it hangs. jsdom
// lays nothing out, so placement is driven by stubbed rectangles.

const SCREWS: ChoiceItem<string>[] = [
  { value: 'm3', label: 'M3', image: '/img/m3.svg', description: '3.4 mm clearance', group: 'Metric', keywords: ['iso'] },
  { value: 'm4', label: 'M4', image: '/img/m4.svg', group: 'Metric' },
  { value: 'pin', label: 'Dowel pin' },
  { value: 'n4', label: '#4', group: 'Imperial', keywords: ['unc'] },
  { value: 'm5', label: 'M5', group: 'Metric' },
  { value: 'n6', label: '#6', group: 'Imperial' },
];

/** Every popover a test opens — closed afterwards, so no document listener outlives its test. */
const opened: OptionPopover<string>[] = [];

afterEach(() => {
  for (const popover of opened.splice(0)) {
    popover.destroy();
  }
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function mount(options: Partial<OptionPopoverOptions<string>> = {}) {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const onChoose = vi.fn();
  const onClose = vi.fn();
  const popover = new OptionPopover<string>({ anchor, items: SCREWS, onChoose, onClose, ...options });
  opened.push(popover);
  const panel = popover.element;
  return {
    anchor, popover, panel, onChoose, onClose,
    options: () => [...panel.querySelectorAll<HTMLElement>('[role="option"]')],
    labels: () => [...panel.querySelectorAll<HTMLElement>('[role="option"]')].map(o => o.querySelector('.truncate')!.textContent),
    search: () => panel.querySelector<HTMLInputElement>('input'),
    focused: () => (document.activeElement as HTMLElement | null)?.querySelector?.('.truncate')?.textContent,
  };
}

function key(target: Element, name: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function rect(box: Partial<DOMRect>): DOMRect {
  return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...box } as DOMRect;
}

describe('OptionPopover rendering', () => {
  it('is on the page body only while open', () => {
    const { popover, panel, onClose } = mount();
    expect(panel.isConnected).toBe(false);
    popover.open();
    expect(popover.isOpen).toBe(true);
    expect(panel.parentElement).toBe(document.body);
    popover.close();
    expect(popover.isOpen).toBe(false);
    expect(panel.isConnected).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders a list: a row per item with image, label and description, the chosen one selected', () => {
    const { popover, panel, options } = mount({ value: 'm4' });
    popover.open();
    expect(panel.querySelector('[role="listbox"]')).not.toBeNull();
    expect(panel.dataset.mode).toBe('list');
    const rows = options();
    expect(rows).toHaveLength(6);
    // Ungrouped first, then groups in first-appearance order.
    expect(rows.map(r => r.querySelector('.truncate')!.textContent)).toEqual(['Dowel pin', 'M3', 'M4', 'M5', '#4', '#6']);
    const m3 = rows[1];
    const img = m3.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/img/m3.svg');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('draggable')).toBe('false');
    expect(img.style.objectFit).toBe('contain');
    expect(m3.textContent).toContain('3.4 mm clearance');
    expect(rows.map(r => r.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false', 'false', 'false']);
    // One image among the items boxes every row; the rows without one show the placeholder.
    expect(rows[0].querySelector('img')).toBeNull();
    expect(rows[0].querySelector(`[${ChoiceImage.PLACEHOLDER}]`)).not.toBeNull();
  });

  it('leaves the boxes out of a list with no images at all', () => {
    const { popover, panel } = mount({ items: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] });
    popover.open();
    expect(panel.querySelector(`[${ChoiceImage.PLACEHOLDER}]`)).toBeNull();
    expect(panel.querySelector('img')).toBeNull();
  });

  it('renders a grid: a cell per item, columns wide, a placeholder where there is no image', () => {
    const { popover, panel, options } = mount({ mode: 'grid', columns: 4 });
    popover.open();
    expect(panel.dataset.mode).toBe('grid');
    expect(panel.dataset.columns).toBe('4');
    const cells = options();
    expect(cells).toHaveLength(6);
    expect(cells[1].querySelector('img')!.getAttribute('src')).toBe('/img/m3.svg');
    expect(cells[1].title).toBe('M3 — 3.4 mm clearance');
    expect(cells[0].querySelector('img')).toBeNull();
    expect(cells[0].querySelector(`[${ChoiceImage.PLACEHOLDER}]`)).not.toBeNull();
  });

  it('clamps columns to 2–6 and defaults to 3', () => {
    expect(mount({ mode: 'grid' }).panel.dataset.columns).toBe('3');
    expect(mount({ mode: 'grid', columns: 1 }).panel.dataset.columns).toBe('2');
    expect(mount({ mode: 'grid', columns: 9 }).panel.dataset.columns).toBe('6');
  });

  it('swaps an image that fails for the placeholder', () => {
    const { popover, options } = mount();
    popover.open();
    const m3 = options()[1];
    m3.querySelector('img')!.dispatchEvent(new Event('error'));
    expect(m3.querySelector('img')).toBeNull();
    expect(m3.querySelector(`[${ChoiceImage.PLACEHOLDER}]`)).not.toBeNull();
  });

  it('puts ungrouped items first under no heading, then a heading per group in first-appearance order', () => {
    const { popover, panel } = mount();
    popover.open();
    const list = panel.querySelector('[role="listbox"]')!;
    const outline = [...list.children].map(el =>
      el.querySelector('[role="option"]') ? `${el.getAttribute('aria-label') ?? '-'}:${el.querySelectorAll('[role="option"]').length}` : el.textContent);
    expect(outline).toEqual(['-:1', 'Metric', 'Metric:3', 'Imperial', 'Imperial:2']);
  });
});

describe('OptionPopover search', () => {
  it('has no search box unless asked', () => {
    const { popover, search } = mount();
    popover.open();
    expect(search()).toBeNull();
  });

  it('filters by label, description and keyword, case-insensitively', () => {
    const { popover, search, labels } = mount({ search: true });
    popover.open();
    type(search()!, 'dowel');
    expect(labels()).toEqual(['Dowel pin']);
    type(search()!, 'CLEARANCE');
    expect(labels()).toEqual(['M3']);
    type(search()!, 'unc');
    expect(labels()).toEqual(['#4']);
    type(search()!, 'm');
    expect(labels()).toEqual(['M3', 'M4', 'M5']);
    type(search()!, '');
    expect(labels()).toHaveLength(6);
  });

  it('says "No matches" and drops the headings when nothing matches', () => {
    const { popover, panel, search, options } = mount({ search: true });
    popover.open();
    type(search()!, 'zzz');
    expect(options()).toHaveLength(0);
    expect(panel.querySelector('[role="listbox"]')!.textContent).toBe('No matches');
  });

  it('focuses the search box when nothing is chosen, the chosen option otherwise', () => {
    const unset = mount({ search: true });
    unset.popover.open();
    expect(document.activeElement).toBe(unset.search());
    unset.popover.close();
    const set = mount({ search: true, value: 'm5' });
    set.popover.open();
    expect(set.focused()).toBe('M5');
  });

  it('sends a typed key on the list to the search box', () => {
    const { popover, search, options } = mount({ search: true, value: 'm3' });
    popover.open();
    expect(document.activeElement).toBe(options()[1]);
    const event = key(options()[1], 'd');
    expect(document.activeElement).toBe(search());
    // Left to the browser, so the letter lands in the box.
    expect(event.defaultPrevented).toBe(false);
  });

  it('goes from the search box to the list on ArrowDown and chooses the first match on Enter', () => {
    const { popover, search, focused, onChoose } = mount({ search: true });
    popover.open();
    type(search()!, 'm');
    key(search()!, 'ArrowDown');
    expect(focused()).toBe('M3');
    search()!.focus();
    key(search()!, 'Enter');
    expect(onChoose).toHaveBeenCalledWith('m3');
  });
});

describe('OptionPopover keyboard', () => {
  it('keeps one option in the tab order and moves it with the arrows, Home and End', () => {
    const { popover, options, focused } = mount();
    popover.open();
    expect(focused()).toBe('Dowel pin');
    key(document.activeElement!, 'ArrowDown');
    key(document.activeElement!, 'ArrowDown');
    expect(focused()).toBe('M4');
    expect(options().filter(o => o.tabIndex === 0).map(o => o.textContent)).toEqual(['M4']);
    key(document.activeElement!, 'ArrowUp');
    expect(focused()).toBe('M3');
    key(document.activeElement!, 'End');
    expect(focused()).toBe('#6');
    key(document.activeElement!, 'ArrowDown');
    expect(focused()).toBe('#6');
    key(document.activeElement!, 'Home');
    expect(focused()).toBe('Dowel pin');
    // A list has one column: sideways arrows stay put.
    key(document.activeElement!, 'ArrowRight');
    expect(focused()).toBe('Dowel pin');
  });

  it('moves in two dimensions in a grid, by rows of the column count', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
    const { popover, focused } = mount({ items, mode: 'grid', columns: 3, value: 'v1' });
    popover.open();
    expect(focused()).toBe('L1');
    key(document.activeElement!, 'ArrowDown');
    expect(focused()).toBe('L4');
    key(document.activeElement!, 'ArrowRight');
    expect(focused()).toBe('L5');
    // The last row is short: down lands on its last cell.
    key(document.activeElement!, 'ArrowDown');
    expect(focused()).toBe('L7');
    key(document.activeElement!, 'ArrowUp');
    expect(focused()).toBe('L4');
    key(document.activeElement!, 'ArrowLeft');
    expect(focused()).toBe('L3');
    key(document.activeElement!, 'ArrowUp');
    expect(focused()).toBe('L0');
  });

  it('starts a new row at each group of a grid', () => {
    const { popover, focused } = mount({ mode: 'grid', columns: 2, value: 'm4' });
    popover.open();
    // Rows: [pin] / [M3 M4] [M5] / [#4 #6].
    key(document.activeElement!, 'ArrowDown');
    expect(focused()).toBe('M5');
    key(document.activeElement!, 'ArrowDown');
    expect(focused()).toBe('#4');
    key(document.activeElement!, 'ArrowUp');
    key(document.activeElement!, 'ArrowUp');
    expect(focused()).toBe('M3');
    key(document.activeElement!, 'ArrowUp');
    expect(focused()).toBe('Dowel pin');
  });

  it.each(['Enter', ' '])('chooses the focused option on %j: once, closed, focus back on the anchor', (name) => {
    const { popover, anchor, onChoose, onClose } = mount();
    popover.open();
    key(document.activeElement!, 'ArrowDown');
    const event = key(document.activeElement!, name);
    expect(event.defaultPrevented).toBe(true);
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith('m3');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(popover.isOpen).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it('closes on Escape without the key reaching a document listener, and returns focus', () => {
    const { popover, anchor, onChoose } = mount({ search: true });
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    try {
      popover.open();
      const event = key(document.activeElement!, 'Escape');
      expect(popover.isOpen).toBe(false);
      expect(heard).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(anchor);
      expect(onChoose).not.toHaveBeenCalled();
      // Closed, it is out of the way: the next Escape is the dialog's.
      key(anchor, 'Escape');
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', heard);
    }
  });

  it('keeps an Escape pressed on the anchor from the anchor\'s own ancestors too', () => {
    const { popover, anchor } = mount();
    const heard = vi.fn();
    document.body.addEventListener('keydown', heard);
    popover.open();
    key(anchor, 'Escape');
    expect(popover.isOpen).toBe(false);
    expect(heard).not.toHaveBeenCalled();
  });

  it('closes on Tab, handing focus to the anchor and leaving the key to the browser', () => {
    const { popover, anchor } = mount();
    popover.open();
    const event = key(document.activeElement!, 'Tab');
    expect(popover.isOpen).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });
});

describe('OptionPopover dismissal', () => {
  it('chooses on a click, once, and closes', () => {
    const { popover, options, onChoose, anchor } = mount();
    popover.open();
    options()[4].querySelector('.truncate')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith('n4');
    expect(popover.isOpen).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it('closes on a press outside, not on one inside or on the anchor', () => {
    const { popover, panel, anchor, onChoose } = mount();
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    popover.open();
    panel.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    anchor.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(popover.isOpen).toBe(true);
    elsewhere.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(popover.isOpen).toBe(false);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('closes on a wheel or scroll outside, not on its own', () => {
    const { popover, panel } = mount();
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    popover.open();
    panel.querySelector('[role="listbox"]')!.dispatchEvent(new Event('wheel', { bubbles: true }));
    panel.querySelector('[role="listbox"]')!.dispatchEvent(new Event('scroll'));
    expect(popover.isOpen).toBe(true);
    elsewhere.dispatchEvent(new Event('wheel', { bubbles: true }));
    expect(popover.isOpen).toBe(false);
    popover.open();
    elsewhere.dispatchEvent(new Event('scroll'));
    expect(popover.isOpen).toBe(false);
  });

  it('lets go of every listener on destroy', () => {
    const { popover, panel, onClose } = mount();
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    popover.open();
    popover.destroy();
    expect(panel.isConnected).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    key(elsewhere, 'Escape');
    document.removeEventListener('keydown', heard);
    expect(heard).toHaveBeenCalledTimes(1);
    elsewhere.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    window.dispatchEvent(new Event('resize'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('OptionPopover placement', () => {
  function place(anchorBox: Partial<DOMRect>, panelBox: Partial<DOMRect>, innerHeight = 600, innerWidth = 800) {
    const m = mount();
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(innerHeight);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(innerWidth);
    vi.spyOn(m.anchor, 'getBoundingClientRect').mockReturnValue(rect(anchorBox));
    vi.spyOn(m.panel, 'getBoundingClientRect').mockReturnValue(rect(panelBox));
    m.popover.open();
    return m;
  }

  it('hangs below the anchor, at least as wide, capped in height', () => {
    const { panel } = place({ top: 100, bottom: 130, left: 40, width: 220 }, { width: 220, height: 200 });
    expect(panel.dataset.placement).toBe('below');
    expect(panel.style.top).toBe('134px');
    expect(panel.style.bottom).toBe('');
    expect(panel.style.left).toBe('40px');
    expect(panel.style.minWidth).toBe('220px');
    expect(panel.style.maxHeight).toBe('320px');
  });

  it('flips above when the window leaves no room below', () => {
    const { panel } = place({ top: 500, bottom: 530, left: 40, width: 220 }, { width: 220, height: 200 });
    expect(panel.dataset.placement).toBe('above');
    expect(panel.style.top).toBe('');
    expect(panel.style.bottom).toBe('104px');
    expect(panel.style.maxHeight).toBe('320px');
  });

  it('stays below, squeezed, when above has even less room', () => {
    const { panel } = place({ top: 60, bottom: 90, left: 40, width: 220 }, { width: 220, height: 300 }, 300);
    expect(panel.dataset.placement).toBe('below');
    expect(panel.style.maxHeight).toBe('198px');
  });

  it('is pulled in from the window\'s right and left edges', () => {
    const right = place({ top: 100, bottom: 130, left: 700, width: 90 }, { width: 300, height: 100 });
    expect(right.panel.style.left).toBe('492px');
    const left = place({ top: 100, bottom: 130, left: -30, width: 90 }, { width: 300, height: 100 });
    expect(left.panel.style.left).toBe('8px');
  });

  it('is placed again when the window resizes', () => {
    const { panel, anchor } = place({ top: 100, bottom: 130, left: 40, width: 220 }, { width: 220, height: 200 });
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect({ top: 500, bottom: 530, left: 40, width: 220 }));
    window.dispatchEvent(new Event('resize'));
    expect(panel.dataset.placement).toBe('above');
  });
});
