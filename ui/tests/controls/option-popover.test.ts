// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChoiceImage, OptionPopover, type ChoiceItem, type OptionPopoverOptions, type ParameterChoice } from '../../src/ui/controls';

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
  // A dismissing press holds its click back until the next press: none is pending for the next test.
  document.dispatchEvent(new Event('pointerdown'));
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

  it('lets go of the page once its panel is taken off it: it answers neither the next Escape nor the next press', () => {
    // Asserted on the popover alone: the suite shares one document, and what
    // another file left listening there is not this test's to vouch for.
    const { popover, onClose } = mount();
    popover.open();
    // The page was rebuilt under it — as a test file's reset does to one left open.
    document.body.innerHTML = '';
    const elsewhere = document.body.appendChild(document.createElement('button'));
    const stop = vi.spyOn(KeyboardEvent.prototype, 'stopPropagation');
    key(elsewhere, 'Escape');
    expect(popover.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    popover.open();
    document.body.innerHTML = '';
    const next = document.body.appendChild(document.createElement('button'));
    const listened = vi.spyOn(document, 'addEventListener');
    next.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(popover.isOpen).toBe(false);
    // No click is held back for a press that dismissed nothing on show.
    expect(listened.mock.calls.filter(([type]) => type === 'click')).toEqual([]);
  });

  it('keeps every key pressed in the popover from the page — a letter over an option is no shortcut', () => {
    const { popover, options } = mount();
    const heard = vi.fn();
    window.addEventListener('keydown', heard);
    try {
      popover.open();
      for (const name of ['e', 'ArrowDown', 'Home', 'x']) {
        key(document.activeElement!, name);
      }
      expect(popover.isOpen).toBe(true);
      expect(options().length).toBeGreaterThan(0);
      expect(heard).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', heard);
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

  it('keeps the press that dismisses it from what is under it, through its click, and lets the next one through', () => {
    const { popover } = mount();
    const under = document.createElement('div');
    document.body.appendChild(under);
    const heard: string[] = [];
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      under.addEventListener(type, () => heard.push(type));
    }
    const press = () => {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        under.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      }
    };
    popover.open();
    press();
    expect(popover.isOpen).toBe(false);
    expect(heard).toEqual([]);
    press();
    expect(heard).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  it('is opaque: it opens over a dialog whose rows would read through panel-bg', () => {
    const { panel } = mount();
    expect(panel.classList.contains('bg-base-200')).toBe(true);
    expect(panel.classList.contains('panel-bg')).toBe(false);
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

  it('keeps the width it opened at when a search narrows the list', () => {
    const m = mount({ mode: 'grid', columns: 3, search: true });
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440);
    vi.spyOn(m.anchor, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 130, left: 1201, width: 206 }));
    vi.spyOn(m.panel, 'getBoundingClientRect').mockReturnValue(rect({ width: 274, height: 230 }));
    m.popover.open();
    expect(m.panel.style.minWidth).toBe('274px');
    expect(m.panel.style.left).toBe('1158px');
    m.search()!.value = 'nothing-here';
    m.search()!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(m.options()).toHaveLength(0);
    expect(m.panel.style.minWidth).toBe('274px');
    expect(m.panel.style.left).toBe('1158px');
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

describe('OptionPopover multiple', () => {
  // Shown order: the ungrouped pin, then Metric (M3, M4, M5), then Imperial (#4, #6).
  function mountMulti(values: string[] = [], options: { mode?: 'list' | 'grid'; search?: boolean } = {}) {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const onToggle = vi.fn();
    const onClose = vi.fn();
    const popover = new OptionPopover<string>({ anchor, items: SCREWS, multiple: true, values, onToggle, onClose, ...options });
    opened.push(popover);
    const panel = popover.element;
    const rows = () => [...panel.querySelectorAll<HTMLElement>('[role="option"]')];
    return {
      anchor, popover, panel, onToggle, onClose, options: rows,
      selected: () => rows().map(o => o.getAttribute('aria-selected')),
      checked: () => rows().map(o => !o.querySelector('[data-role="check"]')!.classList.contains('invisible')),
      search: () => panel.querySelector<HTMLInputElement>('input'),
    };
  }

  it('is a multiselectable listbox whose chosen options are selected and checked', () => {
    const { popover, panel, selected, checked, options } = mountMulti(['m4', 'n6']);
    popover.open();

    expect(panel.querySelector('[role="listbox"]')!.getAttribute('aria-multiselectable')).toBe('true');
    expect(selected()).toEqual(['false', 'false', 'true', 'false', 'false', 'true']);
    expect(checked()).toEqual([false, false, true, false, false, true]);
    expect(options()[2].className).toContain('bg-primary/15');
    expect(options()[0].className).not.toContain('bg-primary/15');
    // Every option carries the mark, so the labels stay in one column.
    expect(options().every(o => o.querySelector('[data-role="check"]')?.getAttribute('aria-hidden') === 'true')).toBe(true);
    // Focus opens on the first chosen one.
    expect(document.activeElement).toBe(options()[2]);
  });

  it('a single popover is no multiselectable listbox and draws no check mark', () => {
    const { popover, panel } = mount({ value: 'm4' });
    popover.open();

    expect(panel.querySelector('[role="listbox"]')!.hasAttribute('aria-multiselectable')).toBe(false);
    expect(panel.querySelector('[data-role="check"]')).toBeNull();
  });

  it('a click toggles its option and the popover stays open', () => {
    const { popover, onToggle, onClose, selected, checked, options, anchor } = mountMulti(['m4']);
    popover.open();

    options()[0].click();
    expect(onToggle).toHaveBeenLastCalledWith('pin');
    expect(selected()).toEqual(['true', 'false', 'true', 'false', 'false', 'false']);
    expect(checked()).toEqual([true, false, true, false, false, false]);

    options()[2].click();
    expect(onToggle).toHaveBeenLastCalledWith('m4');
    expect(selected()).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
    expect(options()[2].className).not.toContain('bg-primary/15');

    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(popover.isOpen).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(anchor);
  });

  it('Enter and Space toggle the focused option and the popover stays open', () => {
    const { popover, onToggle, selected, options } = mountMulti();
    popover.open();

    expect(key(options()[0], 'Enter').defaultPrevented).toBe(true);
    expect(selected()[0]).toBe('true');
    key(options()[0], 'ArrowDown');
    expect(document.activeElement).toBe(options()[1]);
    expect(key(options()[1], ' ').defaultPrevented).toBe(true);
    key(options()[1], ' ');

    expect(onToggle.mock.calls.map(call => call[0])).toEqual(['pin', 'm3', 'm3']);
    expect(selected()).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
    expect(popover.isOpen).toBe(true);
    // The arrows go on from the option just toggled.
    expect(document.activeElement).toBe(options()[1]);
  });

  it('a search keeps what was toggled: Enter in the box toggles the first match, and clearing it shows every mark', () => {
    const { popover, onToggle, selected, search } = mountMulti(['pin'], { search: true });
    popover.open();

    type(search()!, 'm5');
    key(search()!, 'Enter');
    expect(onToggle).toHaveBeenLastCalledWith('m5');
    expect(popover.isOpen).toBe(true);
    expect(selected()).toEqual(['true']);

    type(search()!, '');
    expect(selected()).toEqual(['true', 'false', 'false', 'true', 'false', 'false']);

    // The first match, not the chosen one further down the matches.
    type(search()!, 'm');
    key(search()!, 'Enter');
    expect(onToggle).toHaveBeenLastCalledWith('m3');
    expect(selected()).toEqual(['true', 'false', 'true']);
  });

  it('a grid cell carries the check mark in its corner', () => {
    const { popover, options, checked } = mountMulti(['m3'], { mode: 'grid' });
    popover.open();

    expect(options()[1].className).toContain('relative');
    expect(options()[1].querySelector('[data-role="check"]')!.getAttribute('class')).toContain('absolute');
    expect(checked()).toEqual([false, true, false, false, false, false]);
  });

  it('Escape and a press elsewhere close it, focus back on the anchor after Escape', () => {
    const first = mountMulti(['m3']);
    first.popover.open();
    key(first.options()[1], 'Escape');
    expect(first.popover.isOpen).toBe(false);
    expect(first.onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(first.anchor);
    expect(first.onToggle).not.toHaveBeenCalled();

    const second = mountMulti();
    second.popover.open();
    second.options()[0].click();
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    elsewhere.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(second.popover.isOpen).toBe(false);
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('OptionPopover parameters', () => {
  const P = { letter: 'P', title: 'Parameter — param()', colors: 'bg-primary/20 text-primary border-primary/40' };
  const G = { letter: 'G', title: 'Project parameter', colors: 'bg-accent/20 text-accent border-accent/40' };
  const PARAMS: ParameterChoice[] = [
    { name: 'holeSize', chip: P, value: 'M5' },
    { name: 'stock', chip: G, label: 'Stock size', labelTitle: 'shop.params.js', value: "'m8'", warning: "stock is 'm8', which is not one of the options." },
    { name: 'kind', chip: P },
  ];

  function withParams(
    source = vi.fn((query: string, _matched: number) => PARAMS.filter(p => p.name.includes(query))),
    options: Partial<OptionPopoverOptions<string>> = {},
  ) {
    const onChooseParameter = vi.fn();
    const m = mount({ search: true, parameters: source, onChooseParameter, ...options });
    return { ...m, source, onChooseParameter, parameters: () => [...m.panel.querySelectorAll<HTMLElement>('[data-parameter]')] };
  }

  it('lists the parameters under their heading after the options, each as the expression dropdowns draw a row', () => {
    const { popover, panel, parameters, options } = withParams();
    popover.open();
    const list = panel.querySelector('[role="listbox"]')!;
    const headings = [...list.children].filter(el => el.getAttribute('role') === 'presentation' && !el.querySelector('[role="option"]')).map(el => el.textContent);
    expect(headings).toEqual(['Metric', 'Imperial', 'Parameters']);
    const group = panel.querySelector<HTMLElement>('[data-role="parameters"]')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Parameters');
    expect(list.lastElementChild).toBe(group);
    expect(options()).toHaveLength(9);
    const rows = parameters();
    expect(rows.map(r => r.dataset.parameter)).toEqual(['holeSize', 'stock', 'kind']);
    const [hole, stock, kind] = rows;
    expect(hole.getAttribute('role')).toBe('option');
    expect(hole.dataset.new).toBeUndefined();
    const chip = hole.querySelector<HTMLElement>('[data-role="chip"]')!;
    expect(chip.textContent).toBe('P');
    expect(chip.title).toBe('Parameter — param()');
    expect(chip.className).toContain('bg-primary/20 text-primary border-primary/40');
    expect(chip.className).toContain('rounded border text-[10px] font-semibold');
    expect(hole.querySelector('[data-role="parameter"]')!.textContent).toBe('holeSize');
    expect(hole.querySelector('[data-role="parameter"]')!.className).toContain('font-mono');
    expect(hole.querySelector<HTMLElement>('[data-role="resolved"]')!.textContent).toBe('M5');
    expect(hole.querySelector<HTMLElement>('[data-role="resolved"]')!.className).toContain('text-base-content/50');
    expect(hole.querySelector('[data-role="parameter-label"]')).toBeNull();
    expect(hole.querySelector('[data-role="new"]')).toBeNull();
    // A project parameter's label after its name, the file its tooltip; a value no option carries in the warning colour.
    expect(stock.querySelector<HTMLElement>('[data-role="chip"]')!.textContent).toBe('G');
    expect(stock.querySelector<HTMLElement>('[data-role="parameter-label"]')!.textContent).toBe('Stock size');
    expect(stock.querySelector<HTMLElement>('[data-role="parameter-label"]')!.title).toBe('shop.params.js');
    const raw = stock.querySelector<HTMLElement>('[data-role="resolved"]')!;
    expect(raw.textContent).toBe("'m8'");
    expect(raw.className).toContain('text-warning');
    expect(raw.title).toBe("stock is 'm8', which is not one of the options.");
    // Nothing known to show beside the name.
    expect(kind.querySelector('[data-role="resolved"]')).toBeNull();
  });

  it('asks the source for each search, with how many options matched, and drops the group when it answers none', () => {
    const { popover, panel, search, source, parameters, options } = withParams();
    popover.open();
    expect(source).toHaveBeenLastCalledWith('', 6);
    type(search()!, ' hole ');
    expect(source).toHaveBeenLastCalledWith('hole', 0);
    expect(options().filter(o => !o.dataset.parameter)).toEqual([]);
    expect(parameters().map(r => r.dataset.parameter)).toEqual(['holeSize']);
    expect(panel.querySelector('[role="listbox"]')!.textContent).not.toContain('No matches');
    type(search()!, 'm');
    expect(source).toHaveBeenLastCalledWith('m', 3);
    type(search()!, 'zzz');
    expect(parameters()).toEqual([]);
    expect(panel.querySelector('[data-role="parameters"]')).toBeNull();
    expect(panel.querySelector('[role="listbox"]')!.textContent).toBe('No matches');
  });

  it('shows the group only while the source lists something, and never without a source', () => {
    const none = withParams(vi.fn(() => []));
    none.popover.open();
    expect(none.panel.querySelector('[data-role="parameters"]')).toBeNull();
    expect(none.options()).toHaveLength(6);
    const plain = mount({ search: true });
    plain.popover.open();
    expect(plain.panel.querySelector('[data-role="parameters"]')).toBeNull();
  });

  it('marks the bound parameter selected and focuses it on open; an offer to declare wears the badge and is never selected', () => {
    const offer: ParameterChoice = { name: 'boltSize', chip: P, isNew: true, value: 'M4' };
    const { popover, parameters, options } = withParams(vi.fn(() => [PARAMS[0], offer]), { bound: 'holeSize' });
    popover.open();
    const [hole, fresh] = parameters();
    expect(hole.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(hole);
    expect(options().filter(o => !o.dataset.parameter).map(o => o.getAttribute('aria-selected'))).toEqual(Array(6).fill('false'));
    expect(fresh.dataset.new).toBe('true');
    expect(fresh.getAttribute('aria-selected')).toBe('false');
    expect(fresh.querySelector('[data-role="new"]')!.textContent).toBe('new');
    expect(fresh.querySelector('[data-role="resolved"]')!.textContent).toBe('M4');
    // Bound to a name the source lists as an offer only: nothing is selected.
    const unlisted = withParams(vi.fn(() => [offer]), { bound: 'boltSize' });
    unlisted.popover.open();
    expect(unlisted.parameters()[0].getAttribute('aria-selected')).toBe('false');
  });

  it('chooses a parameter on a click or Enter: closed, focus back on the anchor, the choice handed on, no option chosen', () => {
    const { popover, parameters, onChooseParameter, onChoose, onClose, anchor, search } = withParams();
    popover.open();
    parameters()[0].click();
    expect(onChooseParameter).toHaveBeenCalledTimes(1);
    expect(onChooseParameter).toHaveBeenCalledWith(PARAMS[0]);
    expect(onChoose).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(popover.isOpen).toBe(false);
    expect(document.activeElement).toBe(anchor);
    popover.open();
    // Nothing chosen: the search box has the focus; ArrowDown reaches the list, End its last row — a parameter.
    expect(document.activeElement).toBe(search());
    key(search()!, 'ArrowDown');
    key(document.activeElement!, 'End');
    expect((document.activeElement as HTMLElement).dataset.parameter).toBe('kind');
    key(document.activeElement!, 'Enter');
    expect(onChooseParameter).toHaveBeenLastCalledWith(PARAMS[2]);
    expect(popover.isOpen).toBe(false);
  });

  it('commits the offer typed in the search box on Enter, as the first match', () => {
    const offer: ParameterChoice = { name: 'boltSize', chip: P, isNew: true, value: 'M4' };
    const { popover, search, onChooseParameter } = withParams(vi.fn((query: string) => query === 'boltSize' ? [offer] : []));
    popover.open();
    type(search()!, 'boltSize');
    key(search()!, 'Enter');
    expect(onChooseParameter).toHaveBeenCalledWith(offer);
    expect(popover.isOpen).toBe(false);
  });

  it('walks from the options into the parameters with the arrows, from a grid too', () => {
    const { popover, focused } = withParams(undefined, { mode: 'grid', columns: 2, value: 'n6' });
    popover.open();
    expect(focused()).toBe('#6');
    key(document.activeElement!, 'ArrowDown');
    expect((document.activeElement as HTMLElement).dataset.parameter).toBe('holeSize');
    key(document.activeElement!, 'ArrowDown');
    expect((document.activeElement as HTMLElement).dataset.parameter).toBe('stock');
    key(document.activeElement!, 'ArrowRight');
    expect((document.activeElement as HTMLElement).dataset.parameter).toBe('kind');
    key(document.activeElement!, 'Home');
    expect(focused()).toBe('Dowel pin');
    key(document.activeElement!, 'End');
    expect((document.activeElement as HTMLElement).dataset.parameter).toBe('kind');
    key(document.activeElement!, 'ArrowDown');
    expect((document.activeElement as HTMLElement).dataset.parameter).toBe('kind');
  });

  it('closes a popover of several on a parameter choice, nothing toggled, no check mark on the row', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const onToggle = vi.fn();
    const onChooseParameter = vi.fn();
    const popover = new OptionPopover<string>({
      anchor, items: SCREWS, multiple: true, values: ['m3'], parameters: () => PARAMS, bound: 'kind', onToggle, onChooseParameter,
    });
    opened.push(popover);
    popover.open();
    const row = popover.element.querySelector<HTMLElement>('[data-parameter="holeSize"]')!;
    expect(row.querySelector('[data-role="check"]')).toBeNull();
    expect(popover.element.querySelector<HTMLElement>('[data-parameter="kind"]')!.getAttribute('aria-selected')).toBe('true');
    row.click();
    expect(onChooseParameter).toHaveBeenCalledWith(PARAMS[0]);
    expect(onToggle).not.toHaveBeenCalled();
    expect(popover.isOpen).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });
});
