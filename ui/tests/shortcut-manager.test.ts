// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { ShortcutManager, formatShortcut } from '../src/ui/shortcut-manager';

const managers: ShortcutManager[] = [];

function make(): ShortcutManager {
  const m = new ShortcutManager({ timeout: 200 });
  managers.push(m);
  return m;
}

function press(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

afterEach(() => {
  while (managers.length > 0) {
    managers.pop()!.destroy();
  }
});

describe('ShortcutManager suspendWhile', () => {
  it('matches letters normally when nothing suspends it', () => {
    const fired: string[] = [];
    const m = make();
    m.register('c', () => fired.push('c'));
    m.enable();

    press('c');
    expect(fired).toEqual(['c']);
  });

  // The sketcher's coordinate pill claims the next printable key to open
  // itself. It is a plain (unfocused) div until then, so `isEditableTarget`
  // cannot see it and the manager has to stand down explicitly.
  it('leaves letters alone while suspended', () => {
    const fired: string[] = [];
    const m = make();
    m.register('c', () => fired.push('c'));
    m.enable();

    let suspended = true;
    m.suspendWhile = () => suspended;

    press('c');
    expect(fired).toEqual([]);

    suspended = false;
    press('c');
    expect(fired).toEqual(['c']);
  });

  it('drops a half-typed chord when suspension begins', () => {
    const fired: string[] = [];
    const m = make();
    m.register('l', () => fired.push('l'));
    m.register('ll', () => fired.push('ll'));
    m.enable();

    let suspended = false;
    m.suspendWhile = () => suspended;

    press('l');          // pending: could still become `ll`
    suspended = true;
    press('l');          // goes to the pill instead

    expect(fired).toEqual([]);
  });

  it('still ignores an already focused field', () => {
    const fired: string[] = [];
    const m = make();
    m.register('c', () => fired.push('c'));
    m.enable();

    const field = document.createElement('input');
    document.body.appendChild(field);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));

    expect(fired).toEqual([]);
    field.remove();
  });
});

describe('ShortcutManager modifier combos', () => {
  it('fires mod+z on Ctrl and on ⌘, and preventDefaults it', () => {
    const fired: string[] = [];
    const m = make();
    m.register('mod+z', () => fired.push('undo'));
    m.enable();

    const ctrl = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ctrl);
    const meta = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(meta);

    expect(fired).toEqual(['undo', 'undo']);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(meta.defaultPrevented).toBe(true);
  });

  it('keeps shift and alt exact: mod+shift+z is not mod+z', () => {
    const fired: string[] = [];
    const m = make();
    m.register('mod+z', () => fired.push('undo'));
    m.register('mod+shift+z', () => fired.push('redo'));
    m.enable();

    press('Z', { ctrlKey: true, shiftKey: true });
    press('z', { ctrlKey: true, altKey: true });
    press('y', { ctrlKey: true });

    expect(fired).toEqual(['redo']);
  });

  it('honours a literal ctrl (ctrl+y) but not meta for it', () => {
    const fired: string[] = [];
    const m = make();
    m.register('ctrl+y', () => fired.push('redo'));
    m.enable();

    press('y', { metaKey: true });
    press('y', { ctrlKey: true });

    expect(fired).toEqual(['redo']);
  });

  it('repeats while the key is held, unlike chords', () => {
    const fired: string[] = [];
    const m = make();
    m.register('mod+z', () => fired.push('undo'));
    m.register('c', () => fired.push('c'));
    m.enable();

    press('z', { ctrlKey: true, repeat: true });
    press('c', { repeat: true });

    expect(fired).toEqual(['undo']);
  });

  it('leaves a focused field its native history', () => {
    const fired: string[] = [];
    const m = make();
    m.register('mod+z', () => fired.push('undo'));
    m.enable();

    const field = document.createElement('input');
    document.body.appendChild(field);
    const e = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(e);

    expect(fired).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    field.remove();
  });

  it('flushes a pending chord before the combo fires', () => {
    const fired: string[] = [];
    const m = make();
    m.register('l', () => fired.push('l'));
    m.register('ll', () => fired.push('ll'));
    m.register('mod+z', () => fired.push('undo'));
    m.enable();

    press('l');
    press('z', { ctrlKey: true });

    expect(fired).toEqual(['l', 'undo']);
  });
});

describe('ShortcutManager when guards', () => {
  it('does not consume a key whose binding is inactive', () => {
    const fired: string[] = [];
    const m = make();
    let active = false;
    m.register('mod+z', () => fired.push('undo'), { when: () => active });
    m.register('h', () => fired.push('h'), { when: () => active });
    m.enable();

    const combo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(combo);
    const chord = new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true });
    window.dispatchEvent(chord);
    expect(fired).toEqual([]);
    expect(combo.defaultPrevented).toBe(false);
    expect(chord.defaultPrevented).toBe(false);

    active = true;
    press('z', { ctrlKey: true });
    press('h');
    expect(fired).toEqual(['undo', 'h']);
  });

  // `d` is Dimension and `da` Angle on the constraint bar; with no angle
  // pick set the `d` must not wait out the chord timeout.
  it('an inactive longer chord does not hold the shorter one back', () => {
    const fired: string[] = [];
    const m = make();
    let angleLegal = false;
    m.register('d', () => fired.push('d'));
    m.register('da', () => fired.push('da'), { when: () => angleLegal });
    m.enable();

    press('d');
    expect(fired).toEqual(['d']);

    angleLegal = true;
    press('d');
    expect(fired).toEqual(['d']);   // pending now — `da` is possible
    press('a');
    expect(fired).toEqual(['d', 'da']);
  });
});

describe('ShortcutManager registration', () => {
  it('rejects a binding registered twice', () => {
    const m = make();
    m.register('c', () => {});
    m.register('mod+z', () => {});
    expect(() => m.register('c', () => {})).toThrow(/already registered/);
    expect(() => m.register('mod+z', () => {})).toThrow(/already registered/);
  });

  it('rejects a string that is neither chord nor combo', () => {
    const m = make();
    expect(() => m.register('ctrl+', () => {})).toThrow();
    expect(() => m.register('super+z', () => {})).toThrow();
  });

  it('lists every binding', () => {
    const m = make();
    m.register('c', () => {});
    m.register('ca', () => {});
    m.register('mod+shift+z', () => {});
    expect(m.bindings().sort()).toEqual(['c', 'ca', 'mod+shift+z']);
  });
});

describe('formatShortcut', () => {
  it('shows chords verbatim and combos per platform', () => {
    expect(formatShortcut('ll')).toBe('ll');
    expect(formatShortcut('mod+z', false)).toBe('Ctrl+Z');
    expect(formatShortcut('mod+shift+z', false)).toBe('Ctrl+Shift+Z');
    expect(formatShortcut('ctrl+y', false)).toBe('Ctrl+Y');
    expect(formatShortcut('mod+shift+z', true)).toBe('⌘⇧Z');
  });
});
