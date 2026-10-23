// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelRail } from '../src/ui/panel-rail';

// The rail's third latch: the project Parameters column. Below the Code
// button, absent on a host that passes no handler, and — like the other
// two — reflecting the column's state rather than a remembered click.

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(withGlobal = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let open = false;
  const rail = new PanelRail(container, {
    onToggleTree: () => undefined,
    isTreeVisible: () => false,
    onToggleEditor: () => undefined,
    isEditorOpen: () => false,
    ...(withGlobal ? {
      onToggleGlobalParams: () => { open = !open; },
      isGlobalParamsOpen: () => open,
    } : {}),
  });
  const buttons = () => [...container.querySelectorAll('button')];
  return {
    rail,
    buttons,
    button: (label: string) => buttons().find((b) => b.getAttribute('aria-label') === label)!,
    setOpen: (value: boolean) => { open = value; },
  };
}

describe('panel rail — Global Parameters button', () => {
  it('sits below the Code button', () => {
    const h = mount();
    expect(h.buttons().map((b) => b.getAttribute('aria-label')))
      .toEqual(['Feature tree', 'Code editor', 'Global Parameters']);
    expect(h.button('Global Parameters').querySelector('svg')).not.toBeNull();
    expect(h.button('Global Parameters').parentElement!.dataset.tip).toBe('Global Parameters');
  });

  it('is absent without a handler', () => {
    const h = mount(false);
    expect(h.buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Feature tree', 'Code editor']);
  });

  it('latches with the column and follows a toggle made elsewhere on sync', () => {
    const h = mount();
    const button = h.button('Global Parameters');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    expect(button.className).toContain('btn-primary');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    button.click();
    expect(button.getAttribute('aria-pressed')).toBe('false');

    h.setOpen(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    h.rail.sync();
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });
});
