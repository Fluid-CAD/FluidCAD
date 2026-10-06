// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChoiceImage, RadioGroup, type ChoiceItem, type RadioDisplay, type RadioGroupOptions } from '../../src/ui/controls';

// The radio group in each of its displays: what it renders, that it is one
// radio group to the keyboard whatever it looks like, and that only a
// user's action reaches onChange.

const HEADS: ChoiceItem<string>[] = [
  { value: 'plain', label: 'Plain', image: '/img/plain.svg', description: 'No recess' },
  { value: 'cbore', label: 'Counterbore', image: '/img/cbore.svg' },
  { value: 'csink', label: 'Countersink' },
];
const DISPLAYS: RadioDisplay[] = ['list', 'inline', 'buttons', 'cards'];

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(options: Partial<RadioGroupOptions<string>> = {}) {
  const group = new RadioGroup<string>({ items: HEADS, ...options });
  document.body.appendChild(group.element);
  const onChange = vi.fn();
  group.onChange = onChange;
  const radios = () => [...group.element.querySelectorAll<HTMLElement>('input[type="radio"], [role="radio"]')];
  const isChecked = (radio: HTMLElement) =>
    radio instanceof HTMLInputElement ? radio.checked : radio.getAttribute('aria-checked') === 'true';
  return {
    group, onChange, el: group.element, radios,
    /** The value at each radio that shows chosen. */
    checked: () => radios().flatMap((radio, i) => (isChecked(radio) ? [HEADS[i].value] : [])),
    tabStops: () => radios().flatMap((radio, i) => (radio.tabIndex === 0 ? [HEADS[i].value] : [])),
    clear: () => [...group.element.querySelectorAll('button')].find(b => b.textContent === 'Clear'),
  };
}

function key(target: Element, name: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('RadioGroup displays', () => {
  it('stacks native radios in a list, each in its label, with thumbnail and description', () => {
    const { el, radios } = mount({ label: 'Head' });
    expect(el.getAttribute('role')).toBe('radiogroup');
    expect(el.getAttribute('aria-label')).toBe('Head');
    expect(el.dataset.display).toBe('list');
    const inputs = radios() as HTMLInputElement[];
    expect(inputs.map(input => input.tagName)).toEqual(['INPUT', 'INPUT', 'INPUT']);
    expect(new Set(inputs.map(input => input.name)).size).toBe(1);
    const rows = inputs.map(input => input.closest('label')!);
    expect(rows.map(row => row.querySelector('.truncate')!.textContent)).toEqual(['Plain', 'Counterbore', 'Countersink']);
    expect(rows[0].querySelector('img')!.getAttribute('src')).toBe('/img/plain.svg');
    expect(rows[0].textContent).toContain('No recess');
    // One image among the items boxes every row, so the labels stay in a column.
    expect(rows[2].querySelector(`[${ChoiceImage.PLACEHOLDER}]`)).not.toBeNull();
  });

  it('gives each group of native radios a name of its own', () => {
    const a = mount().radios()[0] as HTMLInputElement;
    const b = mount().radios()[0] as HTMLInputElement;
    expect(a.name).not.toBe(b.name);
  });

  it('puts the radios on one wrapping line inline, a box only where there is an image', () => {
    const { el, radios } = mount({ display: 'inline' });
    expect(el.dataset.display).toBe('inline');
    expect(radios()[0].parentElement!.parentElement!.className).toContain('flex-wrap');
    expect(el.querySelectorAll('img')).toHaveLength(2);
    expect(el.querySelector(`[${ChoiceImage.PLACEHOLDER}]`)).toBeNull();
  });

  it('renders a joined segmented row of buttons, the chosen one in the active look', () => {
    const { el, radios } = mount({ display: 'buttons', value: 'cbore' });
    const buttons = radios();
    expect(buttons.map(b => b.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect(buttons[0].parentElement!.className).toContain('join');
    expect(buttons.map(b => b.textContent)).toEqual(['Plain', 'Counterbore', 'Countersink']);
    expect(buttons.map(b => b.className.includes('btn-primary'))).toEqual([false, true, false]);
    expect(buttons.every(b => b.className.includes('join-item'))).toBe(true);
    expect(buttons[0].querySelector('img')!.getAttribute('src')).toBe('/img/plain.svg');
    expect(buttons[2].querySelector(`[${ChoiceImage.PLACEHOLDER}]`)).toBeNull();
    expect(el.dataset.display).toBe('buttons');
  });

  it('renders cards in a grid columns wide: image or placeholder over the label, the label and description as the title', () => {
    const { el, radios } = mount({ display: 'cards', columns: 4, value: 'plain' });
    const cards = radios();
    expect(el.dataset.columns).toBe('4');
    expect(cards[0].parentElement!.className).toContain('grid');
    expect(cards[0].title).toBe('Plain — No recess');
    expect(cards[1].title).toBe('Counterbore');
    expect(cards[1].querySelector('img')!.getAttribute('src')).toBe('/img/cbore.svg');
    expect(cards[2].querySelector(`[${ChoiceImage.PLACEHOLDER}]`)).not.toBeNull();
    expect(cards.map(c => c.className.includes('border-primary'))).toEqual([true, false, false]);
    expect(mount({ display: 'cards' }).el.dataset.columns).toBe('3');
    expect(mount({ display: 'cards', columns: 12 }).el.dataset.columns).toBe('6');
  });

  it('swaps a card image that fails for the placeholder', () => {
    const card = mount({ display: 'cards' }).radios()[0];
    card.querySelector('img')!.dispatchEvent(new Event('error'));
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector(`[${ChoiceImage.PLACEHOLDER}]`)).not.toBeNull();
  });
});

describe.each(DISPLAYS)('RadioGroup as %s', (display) => {
  it('is a radiogroup showing the initial value, with one tab stop on it', () => {
    const { el, group, checked, tabStops } = mount({ display, value: 'cbore' });
    expect(el.getAttribute('role')).toBe('radiogroup');
    expect(group.value).toBe('cbore');
    expect(checked()).toEqual(['cbore']);
    expect(tabStops()).toEqual(['cbore']);
  });

  it('shows none chosen without a value, the first radio taking the tab stop', () => {
    const { group, checked, tabStops } = mount({ display });
    expect(group.value).toBeUndefined();
    expect(checked()).toEqual([]);
    expect(tabStops()).toEqual(['plain']);
  });

  it('setValue marks the choice, undefined marks none, and neither fires a change', () => {
    const { group, checked, tabStops, onChange } = mount({ display, value: 'plain' });
    group.setValue('csink');
    expect(group.value).toBe('csink');
    expect(checked()).toEqual(['csink']);
    expect(tabStops()).toEqual(['csink']);
    group.setValue(undefined);
    expect(group.value).toBeUndefined();
    expect(checked()).toEqual([]);
    expect(tabStops()).toEqual(['plain']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('chooses on a click, once, and not again for the one already chosen', () => {
    const { group, radios, checked, onChange } = mount({ display });
    radios()[1].click();
    expect(group.value).toBe('cbore');
    expect(checked()).toEqual(['cbore']);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('cbore');
    radios()[1].click();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('moves and chooses with the arrows, wrapping, and with Home and End', () => {
    const { group, radios, checked, tabStops, onChange } = mount({ display, value: 'plain' });
    radios()[0].focus();
    const event = key(radios()[0], 'ArrowDown');
    expect(event.defaultPrevented).toBe(true);
    expect(group.value).toBe('cbore');
    expect(document.activeElement).toBe(radios()[1]);
    expect(tabStops()).toEqual(['cbore']);
    key(radios()[1], 'ArrowRight');
    expect(group.value).toBe('csink');
    key(radios()[2], 'ArrowRight');
    expect(group.value).toBe('plain');
    key(radios()[0], 'ArrowUp');
    expect(group.value).toBe('csink');
    key(radios()[2], 'ArrowLeft');
    expect(group.value).toBe('cbore');
    key(radios()[1], 'End');
    expect(group.value).toBe('csink');
    key(radios()[2], 'Home');
    expect(group.value).toBe('plain');
    expect(checked()).toEqual(['plain']);
    expect(document.activeElement).toBe(radios()[0]);
    expect(onChange.mock.calls.map(call => call[0])).toEqual(['cbore', 'csink', 'plain', 'csink', 'cbore', 'csink', 'plain']);
  });

  it('chooses the focused radio on Space', () => {
    const { group, radios, checked, onChange } = mount({ display });
    radios()[0].focus();
    const event = key(radios()[0], ' ');
    expect(event.defaultPrevented).toBe(true);
    expect(group.value).toBe('plain');
    expect(checked()).toEqual(['plain']);
    expect(onChange).toHaveBeenCalledTimes(1);
    key(radios()[0], ' ');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('leaves other keys alone', () => {
    const { radios, onChange } = mount({ display, value: 'plain' });
    expect(key(radios()[0], 'a').defaultPrevented).toBe(false);
    expect(key(radios()[0], 'Enter').defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has no clear button unless asked', () => {
    expect(mount({ display, value: 'plain' }).clear()).toBeUndefined();
  });

  it('allowClear shows Clear once something is chosen; pressing it unsets the value and says so', () => {
    const { group, radios, checked, tabStops, clear, onChange } = mount({ display, allowClear: true });
    expect(clear()!.hidden).toBe(true);
    radios()[2].click();
    expect(clear()!.hidden).toBe(false);
    clear()!.click();
    expect(group.value).toBeUndefined();
    expect(checked()).toEqual([]);
    expect(tabStops()).toEqual(['plain']);
    expect(clear()!.hidden).toBe(true);
    expect(document.activeElement).toBe(radios()[0]);
    expect(onChange.mock.calls.map(call => call[0])).toEqual(['csink', undefined]);
    // Shown and hidden by setValue too, silently.
    group.setValue('plain');
    expect(clear()!.hidden).toBe(false);
    group.setValue(undefined);
    expect(clear()!.hidden).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('destroy takes the group off the page and stops its keys', () => {
    const { group, el, radios, onChange } = mount({ display, value: 'plain' });
    const first = radios()[0];
    group.destroy();
    expect(el.isConnected).toBe(false);
    key(first, 'ArrowDown');
    expect(group.value).toBe('plain');
    expect(onChange).not.toHaveBeenCalled();
  });
});
