// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OptionMultiButton, type ChoiceItem, type OptionMultiButtonOptions, type ParameterChoice } from '../../src/ui/controls';

// The trigger of a select several are chosen from: what it shows for none,
// one or two and more, that its popover toggles and stays open, that its
// value keeps the items' order, and that only a user's toggle reaches onChange.

const FINISHES: ChoiceItem<string>[] = [
  { value: 'deburr', label: 'Deburr' },
  { value: 'chamfer', label: 'Chamfer' },
  { value: 'polish', label: 'Polish' },
  { value: 'anodise', label: 'Anodise' },
];

const mounted: OptionMultiButton<string>[] = [];

afterEach(() => {
  for (const button of mounted.splice(0)) {
    button.destroy();
  }
  document.body.innerHTML = '';
});

function mount(options: Partial<OptionMultiButtonOptions<string>> = {}) {
  const button = new OptionMultiButton<string>({ items: FINISHES, ...options });
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

describe('OptionMultiButton trigger', () => {
  it('shows "None" greyed while nothing is chosen, or the placeholder it was given', () => {
    const { el, button } = mount();
    expect(el.textContent).toBe('None');
    expect(el.querySelector('span')!.className).toContain('text-base-content/50');
    expect(el.title).toBe('');
    expect(button.value).toEqual([]);
    expect(el.getAttribute('aria-haspopup')).toBe('listbox');
    expect(el.getAttribute('aria-expanded')).toBe('false');

    expect(mount({ placeholder: 'No finish' }).el.textContent).toBe('No finish');
  });

  it('spells out one or two chosen labels in the items\' order, in a truncating label', () => {
    expect(mount({ values: ['chamfer'] }).el.textContent).toBe('Chamfer');

    const { el, button } = mount({ values: ['polish', 'deburr'] });
    expect(el.textContent).toBe('Deburr, Polish');
    expect(el.querySelector('span')!.className).toContain('truncate');
    expect(el.querySelector('span')!.className).not.toContain('text-base-content/50');
    expect(button.value).toEqual(['deburr', 'polish']);
  });

  it('counts more than two, and names them all in the tooltip', () => {
    const { el, button } = mount({ values: ['anodise', 'polish', 'deburr'] });
    expect(el.textContent).toBe('3 selected');
    expect(el.title).toBe('Deburr, Polish, Anodise');
    expect(button.value).toEqual(['deburr', 'polish', 'anodise']);
  });

  it('leaves a value no item carries out of its value until an item does', () => {
    const { el, button } = mount({ values: ['deburr', 'knurl'] });
    expect(button.value).toEqual(['deburr']);
    expect(el.textContent).toBe('Deburr');

    button.setItems([...FINISHES, { value: 'knurl', label: 'Knurl' }]);
    expect(button.value).toEqual(['deburr', 'knurl']);
    expect(el.textContent).toBe('Deburr, Knurl');
  });
});

describe('OptionMultiButton popover', () => {
  it('opens a multiselectable popover with the chosen options checked', () => {
    const { el, popup, options, button } = mount({ values: ['chamfer'] });
    el.click();

    expect(button.isOpen).toBe(true);
    expect(el.getAttribute('aria-expanded')).toBe('true');
    expect(popup()!.getAttribute('aria-multiselectable')).toBe('true');
    expect(options().map(o => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false']);
  });

  it('each toggle updates the trigger and fires onChange with the list in the items\' order; the popover stays open', () => {
    const { el, options, onChange, button } = mount();
    el.click();

    options()[2].click();
    expect(onChange).toHaveBeenLastCalledWith(['polish']);
    expect(el.textContent).toBe('Polish');
    options()[0].click();
    expect(onChange).toHaveBeenLastCalledWith(['deburr', 'polish']);
    expect(el.textContent).toBe('Deburr, Polish');
    options()[3].click();
    expect(onChange).toHaveBeenLastCalledWith(['deburr', 'polish', 'anodise']);
    expect(el.textContent).toBe('3 selected');
    options()[2].click();
    expect(onChange).toHaveBeenLastCalledWith(['deburr', 'anodise']);
    expect(el.textContent).toBe('Deburr, Anodise');

    expect(onChange).toHaveBeenCalledTimes(4);
    expect(button.isOpen).toBe(true);
    expect(options().map(o => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'true']);
  });

  it('emptying the list shows the placeholder and fires an empty list', () => {
    const { el, options, onChange } = mount({ values: ['deburr'] });
    el.click();
    options()[0].click();

    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(el.textContent).toBe('None');
  });

  it('opens on ArrowDown, ArrowUp, Enter and Space; a click on the open trigger and Escape close it', () => {
    for (const name of ['ArrowDown', 'ArrowUp', 'Enter', ' ']) {
      const { el, button } = mount();
      expect(key(el, name).defaultPrevented).toBe(true);
      expect(button.isOpen).toBe(true);
      button.close();
      expect(el.getAttribute('aria-expanded')).toBe('false');
    }

    const { el, button, options, onChange } = mount();
    el.click();
    el.click();
    expect(button.isOpen).toBe(false);
    el.click();
    key(options()[0], 'Escape');
    expect(button.isOpen).toBe(false);
    expect(document.activeElement).toBe(el);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('setValue is silent, shows the list and closes an open popover', () => {
    const { el, button, onChange, options } = mount({ values: ['deburr'] });
    el.click();
    button.setValue(['polish', 'chamfer']);

    expect(onChange).not.toHaveBeenCalled();
    expect(button.isOpen).toBe(false);
    expect(button.value).toEqual(['chamfer', 'polish']);
    expect(el.textContent).toBe('Chamfer, Polish');

    el.click();
    expect(options().map(o => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'true', 'false']);
    button.setValue([]);
    expect(el.textContent).toBe('None');
  });

  it('destroy closes the popover and lets go of the trigger', () => {
    const { el, button } = mount();
    el.click();
    button.destroy();

    expect(button.isOpen).toBe(false);
    el.click();
    expect(button.isOpen).toBe(false);
  });
});

describe('OptionMultiButton bound to a parameter', () => {
  const P = { letter: 'P', title: 'Parameter — param()', colors: 'bg-primary/20 text-primary border-primary/40' };
  const STEPS: ParameterChoice = { name: 'steps', chip: P, value: 'Deburr, Polish' };

  it('shows the parameter\'s name and what it selects, opens on the list it holds, and a toggle carries on from it', () => {
    const onBind = vi.fn();
    const { button, el, onChange, options } = mount({ values: ['chamfer'], parameters: () => [STEPS] });
    button.onBind = onBind;
    button.setBinding(STEPS, ['deburr', 'polish']);
    expect(button.binding).toBe(STEPS);
    expect(button.value).toEqual(['deburr', 'polish']);
    expect(el.querySelector('[data-role="binding"]')).not.toBeNull();
    expect(el.querySelector('[data-role="parameter"]')!.textContent).toBe('steps');
    expect(el.querySelector('[data-role="resolved"]')!.textContent).toBe('Deburr, Polish');
    expect(el.title).toBe('');
    expect(onBind).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    el.click();
    expect(options().filter(o => !o.dataset.parameter).map(o => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'true', 'false']);
    expect(document.body.querySelector('[data-parameter="steps"]')!.getAttribute('aria-selected')).toBe('true');
    options()[3].click();
    expect(button.binding).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith(['deburr', 'polish', 'anodise']);
    expect(el.textContent).toBe('3 selected');
    expect(button.isOpen).toBe(true);
    // Bound to a list unknown to the host: the popover opens on nothing checked.
    button.setBinding(STEPS, []);
    expect(button.value).toEqual([]);
    el.click();
    expect(options().filter(o => !o.dataset.parameter).map(o => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false', 'false']);
  });

  it('binds on a parameter chosen in the popover — closed, onBind once — and setValue lets it go', () => {
    const onBind = vi.fn();
    const { button, el, onChange } = mount({ values: ['chamfer'], parameters: () => [STEPS] });
    button.onBind = onBind;
    el.click();
    document.body.querySelector<HTMLElement>('[data-parameter="steps"]')!.click();
    expect(onBind).toHaveBeenCalledTimes(1);
    expect(onBind).toHaveBeenCalledWith(STEPS);
    expect(onChange).not.toHaveBeenCalled();
    expect(button.isOpen).toBe(false);
    expect(button.binding).toBe(STEPS);
    expect(document.activeElement).toBe(el);
    expect(el.querySelector('[data-role="parameter"]')!.textContent).toBe('steps');
    // Until the host says what the parameter holds, the list stays as it was.
    expect(button.value).toEqual(['chamfer']);
    button.setValue(['polish']);
    expect(button.binding).toBeUndefined();
    expect(el.textContent).toBe('Polish');
  });
});
