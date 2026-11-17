// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeftSlot, type LeftSlotOccupant } from '../src/ui/left-slot';

// The left slot beside the rail (agent-chat plan §10.1): occupants register
// a close(), taking the slot closes the others, and they share one width,
// clamped to keep 280 px of scene, covering the scene below 640 px. The
// code editor and the Hub panel are its occupants today.

const root = document.documentElement;
const variable = () => root.style.getPropertyValue('--fluidcad-editor-width');
const animating = () => root.classList.contains('fluidcad-editor-animating');

afterEach(() => {
  vi.unstubAllGlobals();
  root.style.removeProperty('--fluidcad-editor-width');
  root.style.removeProperty('--fluidcad-rail-width');
  root.classList.remove('fluidcad-editor-animating');
  document.body.innerHTML = '';
});

/** An occupant as the panels are: open or not, closing through the slot. */
function occupant(slot: LeftSlot, name: string, log: string[], minWidth = 280) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  let open = false;
  const self: LeftSlotOccupant & { el: HTMLElement; show(): void; isOpen(): boolean } = {
    el,
    show: () => {
      slot.take(self, { el, minWidth });
      open = true;
      log.push(`${name} open`);
    },
    close: () => {
      log.push(`${name} close`);
      if (!open) {
        return;
      }
      open = false;
      slot.release(self);
    },
    isOpen: () => open,
  };
  slot.register(self);
  return self;
}

function drag(handle: HTMLElement, from: number, to: number): void {
  handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: from, bubbles: true }));
  handle.dispatchEvent(new MouseEvent('pointermove', { clientX: to, bubbles: true }));
  handle.dispatchEvent(new MouseEvent('pointerup', { clientX: to, bubbles: true }));
}

describe('the left slot', () => {
  it('closes every other occupant when one takes it, then sizes the taker at the shared width', () => {
    vi.stubGlobal('innerWidth', 1440);
    const log: string[] = [];
    const slot = new LeftSlot({ width: 500 });
    const editor = occupant(slot, 'editor', log, 240);
    const hub = occupant(slot, 'hub', log);
    const chat = occupant(slot, 'chat', log);

    hub.show();
    expect(log).toEqual(['editor close', 'chat close', 'hub open']);
    expect(slot.holds(hub)).toBe(true);
    expect(hub.el.style.width).toBe('500px');
    expect(variable()).toBe('500px');
    expect(animating()).toBe(true);

    log.length = 0;
    editor.show();
    expect(log).toEqual(['hub close', 'chat close', 'editor open']);
    expect(hub.isOpen()).toBe(false);
    expect(slot.holds(editor)).toBe(true);
    expect(slot.holds(hub)).toBe(false);
    // The Hub's close found the slot already the editor's: the width went straight across.
    expect(variable()).toBe('500px');
    expect(editor.el.style.width).toBe('500px');
  });

  it('gives the width back to the scene when the holder closes, and only then', () => {
    vi.stubGlobal('innerWidth', 1440);
    const log: string[] = [];
    const slot = new LeftSlot();
    const editor = occupant(slot, 'editor', log, 240);
    const hub = occupant(slot, 'hub', log);
    editor.show();
    expect(variable()).toBe('420px');
    // A release from an occupant that doesn't hold the slot changes nothing.
    slot.release(hub);
    expect(variable()).toBe('420px');
    editor.close();
    expect(variable()).toBe('0px');
    expect(slot.holds(editor)).toBe(false);
  });

  it('clamps to each occupant\'s minimum and to what leaves 280 px of scene beside the rail', () => {
    vi.stubGlobal('innerWidth', 1000);
    root.style.setProperty('--fluidcad-rail-width', '48px');
    const log: string[] = [];
    const slot = new LeftSlot({ width: 250 });
    const editor = occupant(slot, 'editor', log, 240);
    const hub = occupant(slot, 'hub', log, 280);
    editor.show();
    expect(editor.el.style.width).toBe('250px');
    hub.show();
    // The Hub's own minimum, without changing the shared width.
    expect(hub.el.style.width).toBe('280px');
    expect(slot.width()).toBe(250);
    slot.setWidth(5000);
    expect(hub.el.style.width).toBe(`${1000 - 48 - 280}px`);
    expect(LeftSlot.clamp(Number.NaN, 240)).toBe(420);
  });

  it('covers the scene below 640 px, and follows the window when asked to lay out again', () => {
    vi.stubGlobal('innerWidth', 600);
    const log: string[] = [];
    const slot = new LeftSlot({ width: 400 });
    const hub = occupant(slot, 'hub', log);
    hub.show();
    expect(hub.el.style.width).toBe('calc(100% - var(--fluidcad-rail-width, 0px))');
    expect(variable()).toBe('0px');
    hub.close();
    vi.stubGlobal('innerWidth', 1440);
    hub.show();
    expect(hub.el.style.width).toBe('400px');
    vi.stubGlobal('innerWidth', 600);
    slot.layout();
    expect(hub.el.style.width).toBe('calc(100% - var(--fluidcad-rail-width, 0px))');
    expect(variable()).toBe('0px');
    vi.stubGlobal('innerWidth', 1440);
    slot.layout();
    expect(hub.el.style.width).toBe('400px');
    expect(variable()).toBe('400px');
  });

  it('drags the holder\'s edge: one width for every occupant, reported for saving, without animation', () => {
    vi.stubGlobal('innerWidth', 1440);
    const log: string[] = [];
    const onResize = vi.fn();
    const slot = new LeftSlot({ width: 420, onResize });
    const editor = occupant(slot, 'editor', log, 240);
    const hub = occupant(slot, 'hub', log);
    const handle = slot.resizeHandle();
    hub.el.appendChild(handle);
    hub.show();
    root.classList.remove('fluidcad-editor-animating');

    drag(handle, 420, 520);
    expect(hub.el.style.width).toBe('520px');
    expect(variable()).toBe('520px');
    expect(animating()).toBe(false);
    expect(onResize).toHaveBeenLastCalledWith(520);
    // Dragged below the Hub's minimum: clamped to it, and that is what is kept.
    drag(handle, 520, 100);
    expect(onResize).toHaveBeenLastCalledWith(280);
    expect(slot.width()).toBe(280);

    editor.show();
    expect(editor.el.style.width).toBe('280px');
  });

  it('takes a width from the page silently: the holder follows, nothing is saved', () => {
    vi.stubGlobal('innerWidth', 1440);
    const log: string[] = [];
    const onResize = vi.fn();
    const slot = new LeftSlot({ onResize });
    slot.setWidth(360);
    expect(slot.width()).toBe(360);
    expect(variable()).toBe('');
    const editor = occupant(slot, 'editor', log, 240);
    editor.show();
    expect(variable()).toBe('360px');
    slot.setWidth(380);
    expect(editor.el.style.width).toBe('380px');
    slot.setWidth(Number.NaN);
    expect(slot.width()).toBe(380);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('no longer closes an occupant that left', () => {
    vi.stubGlobal('innerWidth', 1440);
    const log: string[] = [];
    const slot = new LeftSlot();
    const hub = { close: vi.fn() };
    const leave = slot.register(hub);
    const editor = occupant(slot, 'editor', log, 240);
    editor.show();
    expect(hub.close).toHaveBeenCalledTimes(1);
    editor.close();
    leave();
    editor.show();
    expect(hub.close).toHaveBeenCalledTimes(1);
  });
});
