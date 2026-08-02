// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { ShortcutManager } from '../src/ui/shortcut-manager';

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
