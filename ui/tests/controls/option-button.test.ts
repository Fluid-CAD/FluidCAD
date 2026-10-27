// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OptionButton, type ChoiceItem, type OptionButtonOptions, type ParameterChoice } from '../../src/ui/controls';

// The rich select's trigger: what it shows, what opens its popover, that a
// choice made there (and only a user's choice) reaches onChange.

const HEADS: ChoiceItem<string>[] = [
  { value: 'plain', label: 'Plain', image: '/img/plain.svg', description: 'No recess' },
  { value: 'cbore', label: 'Counterbore', image: '/img/cbore.svg' },
  { value: 'csink', label: 'Countersink' },
];

const mounted: OptionButton<string>[] = [];

afterEach(() => {
  for (const button of mounted.splice(0)) {
    button.destroy();
  }
  document.body.innerHTML = '';
});

function mount(options: Partial<OptionButtonOptions<string>> = {}) {
  const button = new OptionButton<string>({ items: HEADS, ...options });
  mounted.push(button);
  document.body.appendChild(button.element);
  const onChange = vi.fn();
  button.onChange = onChange;
  return {
    button, onChange, el: button.element,
    popup: () => document.body.querySelector<HTMLElement>('[role="listbox"]'),
    options: () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')],
  };
}

function key(target: Element, name: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('OptionButton', () => {
  it('is a button that announces a listbox popup', () => {
    const { el } = mount();
    expect(el.tagName).toBe('BUTTON');
    expect(el.type).toBe('button');
    expect(el.getAttribute('aria-haspopup')).toBe('listbox');
    expect(el.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the chosen item\'s image and label', () => {
    const { button, el } = mount({ value: 'cbore' });
    expect(button.value).toBe('cbore');
    expect(el.textContent).toBe('Counterbore');
    expect(el.querySelector('img')!.getAttribute('src')).toBe('/img/cbore.svg');
  });

  it('shows the label alone for an item without an image', () => {
    const { el } = mount({ value: 'csink' });
    expect(el.textContent).toBe('Countersink');
    expect(el.querySelector('img')).toBeNull();
  });

  it('shows the placeholder while nothing is chosen', () => {
    expect(mount().el.textContent).toBe('Choose…');
    const { button, el } = mount({ placeholder: '—' });
    expect(button.value).toBeUndefined();
    expect(el.textContent).toBe('—');
    expect(el.querySelector('img')).toBeNull();
  });

  it('setValue shows the item, or the placeholder for undefined, and fires no change', () => {
    const { button, el, onChange } = mount({ placeholder: '—' });
    button.setValue('plain');
    expect(button.value).toBe('plain');
    expect(el.textContent).toBe('Plain');
    expect(el.title).toBe('No recess');
    button.setValue(undefined);
    expect(button.value).toBeUndefined();
    expect(el.textContent).toBe('—');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('setItems swaps the choices: the value stays, shown once an item carries it', () => {
    const { button, el, onChange, options } = mount({ value: 'plain', placeholder: '—' });
    button.setItems([{ value: 'hex', label: 'Hex' }]);
    expect(button.value).toBe('plain');
    expect(el.textContent).toBe('—');
    button.setItems([{ value: 'plain', label: 'Flat' }, { value: 'hex', label: 'Hex' }]);
    expect(el.textContent).toBe('Flat');
    el.click();
    expect(options().map(o => o.textContent)).toEqual(['Flat', 'Hex']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('opens on a click and closes on the next', () => {
    const { button, el, popup } = mount();
    el.click();
    expect(button.isOpen).toBe(true);
    expect(popup()).not.toBeNull();
    expect(el.getAttribute('aria-expanded')).toBe('true');
    el.click();
    expect(button.isOpen).toBe(false);
    expect(popup()).toBeNull();
    expect(el.getAttribute('aria-expanded')).toBe('false');
  });

  it.each(['ArrowDown', 'ArrowUp', 'Enter', ' '])('opens on %j, with the chosen option focused', (name) => {
    const { button, el } = mount({ value: 'cbore' });
    el.focus();
    const event = key(el, name);
    expect(event.defaultPrevented).toBe(true);
    expect(button.isOpen).toBe(true);
    expect(document.activeElement!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement!.textContent).toBe('Counterbore');
  });

  it('passes mode, columns and search on to the popover', () => {
    const { el, popup } = mount({ mode: 'grid', columns: 4, search: true });
    el.click();
    const panel = popup()!.parentElement!;
    expect(panel.dataset.mode).toBe('grid');
    expect(panel.dataset.columns).toBe('4');
    expect(panel.querySelector('input')).not.toBeNull();
  });

  it('takes a choice from the popover: shown, onChange once, closed, focus back', () => {
    const { button, el, onChange, options } = mount({ value: 'plain' });
    el.click();
    options()[2].click();
    expect(button.value).toBe('csink');
    expect(el.textContent).toBe('Countersink');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('csink');
    expect(button.isOpen).toBe(false);
    expect(el.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(el);
  });

  it('fires no change when the chosen item is chosen again', () => {
    const { el, onChange, options } = mount({ value: 'plain' });
    el.click();
    options()[0].click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on Escape without a change, the key kept from the document', () => {
    const { button, el, onChange } = mount({ value: 'plain' });
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    el.click();
    key(document.activeElement!, 'Escape');
    document.removeEventListener('keydown', heard);
    expect(button.isOpen).toBe(false);
    expect(heard).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(el.getAttribute('aria-expanded')).toBe('false');
  });

  it('destroy closes the popover and stops the button opening one', () => {
    const { button, el, popup } = mount();
    el.click();
    button.destroy();
    expect(popup()).toBeNull();
    expect(button.isOpen).toBe(false);
    el.click();
    key(el, 'ArrowDown');
    expect(popup()).toBeNull();
  });
});

describe('OptionButton bound to a parameter', () => {
  const P = { letter: 'P', title: 'Parameter — param()', colors: 'bg-primary/20 text-primary border-primary/40' };
  const HOLE: ParameterChoice = { name: 'holeHead', chip: P, value: 'Counterbore' };

  it('shows the parameter\'s name with what it selects muted beside it, and holds no value of its own', () => {
    const { button, el, onChange } = mount({ value: 'plain' });
    button.setBinding(HOLE);
    expect(button.binding).toBe(HOLE);
    expect(button.value).toBeUndefined();
    const text = el.querySelector<HTMLElement>('[data-role="binding"]')!;
    expect(text.className).toContain('flex-1 min-w-0');
    expect(text.querySelector('[data-role="parameter"]')!.textContent).toBe('holeHead');
    expect(text.querySelector('[data-role="parameter"]')!.className).toContain('font-mono');
    expect(text.querySelector('[data-role="resolved"]')!.textContent).toBe('Counterbore');
    expect(text.querySelector('[data-role="resolved"]')!.className).toContain('text-base-content/50');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[data-role="chip"]')).toBeNull();
    expect(el.title).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    // A project parameter's label is the tooltip; a value no option carries, the warning.
    button.setBinding({ name: 'head', chip: P, label: 'Head style', value: "'flat'", warning: "head is 'flat', which is not one of the options." });
    expect(el.title).toBe("head is 'flat', which is not one of the options.");
    expect(el.querySelector('[data-role="resolved"]')!.className).toContain('text-warning');
    button.setBinding({ name: 'head', chip: P, label: 'Head style' });
    expect(el.title).toBe('Head style');
    expect(el.querySelector('[data-role="resolved"]')).toBeNull();
    // Let go: the option chosen before shows again.
    button.setBinding(undefined);
    expect(el.textContent).toBe('Plain');
    expect(button.value).toBe('plain');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('binds on a parameter chosen in the popover, telling onBind once, and marks it selected on the next open', () => {
    const onBind = vi.fn();
    const { button, el, onChange, options } = mount({ value: 'plain', parameters: () => [HOLE] });
    button.onBind = onBind;
    el.click();
    const row = () => document.body.querySelector<HTMLElement>('[data-parameter="holeHead"]')!;
    expect(row().getAttribute('aria-selected')).toBe('false');
    row().click();
    expect(onBind).toHaveBeenCalledTimes(1);
    expect(onBind).toHaveBeenCalledWith(HOLE);
    expect(onChange).not.toHaveBeenCalled();
    expect(button.binding).toBe(HOLE);
    expect(button.value).toBeUndefined();
    expect(el.querySelector('[data-role="parameter"]')!.textContent).toBe('holeHead');
    expect(button.isOpen).toBe(false);
    expect(el.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(el);
    el.click();
    expect(row().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(row());
    expect(options().filter(o => !o.dataset.parameter).map(o => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false']);
  });

  it('choosing an option again unbinds — the one shown before included — and setValue lets the binding go silently', () => {
    const { button, el, onChange, options } = mount({ value: 'plain', parameters: () => [HOLE] });
    button.setBinding(HOLE);
    el.click();
    options()[0].click();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('plain');
    expect(button.binding).toBeUndefined();
    expect(button.value).toBe('plain');
    expect(el.textContent).toBe('Plain');
    button.setBinding(HOLE);
    button.setValue('cbore');
    expect(button.binding).toBeUndefined();
    expect(el.textContent).toBe('Counterbore');
    // Items swapped under a binding: it stays.
    button.setBinding(HOLE);
    button.setItems([{ value: 'hex', label: 'Hex' }]);
    expect(button.binding).toBe(HOLE);
    expect(el.querySelector('[data-role="parameter"]')!.textContent).toBe('holeHead');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
