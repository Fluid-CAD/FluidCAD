// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '../src/ui/chat/chat-composer';
import { mentionAt, mentionText, rankMentions, type MentionFile } from '../src/ui/chat/file-mentions';

// Naming a project file in a message: `@` in the composer lists the files
// above the box, typing narrows the list, Enter, Tab or a click writes the
// file's path as `@path`, Escape closes the list and leaves the text.

const FILES: MentionFile[] = [
  { path: 'README.md', kind: 'other' },
  { path: 'parts/plate.part.js', kind: 'model' },
  { path: 'parts/bracket.part.js', kind: 'model' },
  { path: 'lib/holes.js', kind: 'source' },
  { path: 'my parts/lid.part.js', kind: 'model' },
];

afterEach(() => {
  document.body.innerHTML = '';
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(files: MentionFile[] = FILES) {
  const onSubmit = vi.fn(async (_text: string) => true);
  const onStop = vi.fn();
  const listFiles = vi.fn(async () => files);
  const composer = new ChatComposer({ onSubmit, onStop, listFiles });
  document.body.appendChild(composer.el);
  const input = composer.textarea;
  input.focus();
  const list = composer.el.querySelector<HTMLElement>('[data-ref="mentions"]')!;
  /** Type `text` at the end of what is there, as the keyboard would. */
  const type = async (text: string) => {
    input.value += text;
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  const key = (k: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(event);
    return event;
  };
  const rows = () => [...list.querySelectorAll<HTMLElement>('[role="option"]')];
  const paths = () => rows().map((row) => row.dataset.path);
  const highlighted = () => list.querySelector<HTMLElement>('[data-highlighted]')?.dataset.path;
  const shown = () => !list.classList.contains('hidden');
  return { composer, input, list, onSubmit, onStop, listFiles, type, key, rows, paths, highlighted, shown };
}

describe('finding the mention at the caret', () => {
  it('is an @ that starts a word, up to the caret', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('fillet @pla', 11)).toEqual({ start: 7, query: 'pla' });
    expect(mentionAt('see (@parts/pl', 14)).toEqual({ start: 5, query: 'parts/pl' });
    expect(mentionAt('fillet @pla te', 14)).toBeNull();
    expect(mentionAt('mail me@example.com', 19)).toBeNull();
    expect(mentionAt('fillet @pla', 6)).toBeNull();
  });

  it('ranks by the match, then models before modules before the rest', () => {
    expect(rankMentions(FILES, '').map((f) => f.path)).toEqual([
      'my parts/lid.part.js', 'parts/bracket.part.js', 'parts/plate.part.js', 'lib/holes.js', 'README.md',
    ]);
    expect(rankMentions(FILES, 'plate').map((f) => f.path)).toEqual(['parts/plate.part.js']);
    expect(rankMentions(FILES, 'zzz')).toEqual([]);
    expect(rankMentions(FILES, '', 2)).toHaveLength(2);
  });

  it('quotes a path with a space', () => {
    expect(mentionText('parts/plate.part.js')).toBe('@parts/plate.part.js');
    expect(mentionText('my parts/lid.part.js')).toBe('@"my parts/lid.part.js"');
  });
});

describe('the @ file list in the composer', () => {
  it('opens on @, narrows as the name is typed, and closes when the word ends', async () => {
    const h = mount();
    expect(h.shown()).toBe(false);
    await h.type('fillet @');
    expect(h.shown()).toBe(true);
    expect(h.paths()).toHaveLength(5);
    expect(h.input.getAttribute('aria-expanded')).toBe('true');
    await h.type('brack');
    expect(h.paths()).toEqual(['parts/bracket.part.js']);
    // One listing for the mention, however much of it is typed.
    expect(h.listFiles).toHaveBeenCalledTimes(1);
    await h.type(' ');
    expect(h.shown()).toBe(false);
    expect(h.input.getAttribute('aria-expanded')).toBe('false');
  });

  it('Enter writes the highlighted file instead of sending', async () => {
    const h = mount();
    await h.type('fillet @pl');
    expect(h.highlighted()).toBe('parts/plate.part.js');
    const event = h.key('Enter');
    expect(event.defaultPrevented).toBe(true);
    expect(h.onSubmit).not.toHaveBeenCalled();
    expect(h.input.value).toBe('fillet @parts/plate.part.js ');
    expect(h.input.selectionStart).toBe(h.input.value.length);
    expect(h.shown()).toBe(false);
    // The list gone, Enter sends again.
    h.key('Enter');
    await settle();
    expect(h.onSubmit).toHaveBeenCalledWith('fillet @parts/plate.part.js ');
  });

  it('the arrows move the highlight, around the ends; Tab picks', async () => {
    const h = mount();
    await h.type('@part');
    const first = h.paths();
    expect(h.highlighted()).toBe(first[0]);
    h.key('ArrowDown');
    expect(h.highlighted()).toBe(first[1]);
    expect(h.input.getAttribute('aria-activedescendant')).toBe(h.rows()[1].id);
    h.key('ArrowUp');
    h.key('ArrowUp');
    expect(h.highlighted()).toBe(first[first.length - 1]);
    h.key('Tab');
    expect(h.input.value).toBe(`${mentionText(first[first.length - 1]!)} `);
  });

  it('a click picks, into the middle of the text, with no second space', async () => {
    const h = mount();
    h.input.value = 'fillet @hol on the top';
    h.input.setSelectionRange(11, 11);
    h.input.dispatchEvent(new Event('input'));
    await settle();
    expect(h.paths()).toEqual(['lib/holes.js']);
    h.rows()[0].click();
    expect(h.input.value).toBe('fillet @lib/holes.js on the top');
    expect(h.input.selectionStart).toBe('fillet @lib/holes.js'.length);
  });

  it('a path with a space goes in quotes', async () => {
    const h = mount();
    await h.type('@lid');
    h.key('Enter');
    expect(h.input.value).toBe('@"my parts/lid.part.js" ');
  });

  it('Escape closes the list, keeps the text, and stops no turn; the same @ stays closed', async () => {
    const h = mount();
    h.composer.setBusy(true);
    await h.type('@pl');
    const event = h.key('Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(h.onStop).not.toHaveBeenCalled();
    expect(h.shown()).toBe(false);
    expect(h.input.value).toBe('@pl');
    await h.type('a');
    expect(h.shown()).toBe(false);
    // Another @ opens it again; Escape with no list stops the turn as before.
    await h.type(' @');
    expect(h.shown()).toBe(true);
    h.key('Escape');
    h.key('Escape');
    expect(h.onStop).toHaveBeenCalledTimes(1);
  });

  it('with nothing matching it says so, and Enter sends the message as typed', async () => {
    const h = mount();
    await h.type('ask @nobody');
    expect(h.shown()).toBe(true);
    expect(h.rows()).toHaveLength(0);
    expect(h.list.textContent).toBe('No matching files.');
    h.key('Enter');
    await settle();
    expect(h.onSubmit).toHaveBeenCalledWith('ask @nobody');
  });

  it('closes when the textarea loses the focus', async () => {
    const h = mount();
    await h.type('@');
    expect(h.shown()).toBe(true);
    h.input.blur();
    expect(h.shown()).toBe(false);
  });

  it('without a file listing, @ is only a character', async () => {
    const composer = new ChatComposer({ onSubmit: async () => true, onStop: () => {} });
    document.body.appendChild(composer.el);
    expect(composer.el.querySelector('[data-ref="mentions"]')).toBeNull();
    expect(composer.textarea.hasAttribute('aria-autocomplete')).toBe(false);
  });
});
