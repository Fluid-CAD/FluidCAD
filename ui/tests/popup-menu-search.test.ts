// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closePopupMenu, isPopupMenuOpen, showPopupMenu, type PopupMenuItem } from '../src/ui/popup-menu';

// A popup menu with `search`: a filter field over a scrolling list, for a
// long menu such as the Agent panel's model chip on OpenRouter.

afterEach(() => {
  closePopupMenu();
  document.body.innerHTML = '';
});

function open(items: PopupMenuItem[]) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const menu = showPopupMenu(host, { clientX: 10, clientY: 600 }, items, { placement: 'above', search: { placeholder: 'Search models', empty: 'No model matches' } });
  const input = menu.querySelector<HTMLInputElement>('[data-ref="menu-search"]')!;
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };
  const shown = () => [...menu.querySelectorAll<HTMLElement>('[data-ref="menu-list"] [role="menuitem"]:not(.hidden)')].map((r) => r.textContent!.trim());
  const empty = () => menu.querySelector<HTMLElement>('[data-ref="menu-empty"]')!;
  return { menu, input, type, shown, empty };
}

const picked = vi.fn();
const MODELS: PopupMenuItem[] = [
  { icon: '', label: 'Anthropic: Claude Opus 5.5', keywords: 'anthropic/claude-opus-5-5', onSelect: () => picked('opus') },
  { icon: '', label: 'Anthropic: Claude Haiku 5.5', keywords: 'anthropic/claude-haiku-5-5', onSelect: () => picked('haiku') },
  { icon: '', label: 'OpenAI: GPT-6.2 Astra', keywords: 'openai/gpt-6.2-astra', selected: true, onSelect: () => picked('astra') },
  { icon: '', label: 'Google: Gemini 4 Pro', keywords: 'google/gemini-4-pro', onSelect: () => picked('gemini') },
  { icon: '', label: 'Other model…', separated: true, pinned: true, onSelect: () => picked('other') },
];

describe('a searchable popup menu', () => {
  it('opens with the field focused, the rows in a scrolling list and the pinned row under it', () => {
    const h = open(MODELS);
    expect(document.activeElement).toBe(h.input);
    expect(h.input.placeholder).toBe('Search models');
    expect(h.menu.querySelector('[data-ref="menu-list"]')!.className).toContain('overflow-y-auto');
    expect(h.menu.style.maxHeight).not.toBe('');
    expect(h.shown()).toEqual(['Anthropic: Claude Opus 5.5', 'Anthropic: Claude Haiku 5.5', 'OpenAI: GPT-6.2 Astra', 'Google: Gemini 4 Pro']);
    // The pinned row is outside the list.
    const other = [...h.menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((r) => r.textContent!.trim() === 'Other model…')!;
    expect(other.closest('[data-ref="menu-list"]')).toBeNull();
    expect(h.menu.querySelector('[data-selected]')!.textContent!.trim()).toBe('OpenAI: GPT-6.2 Astra');
  });

  it('filters by every word typed, in the label or the keywords, ignoring case; the pinned row stays', () => {
    const h = open(MODELS);
    h.type('claude');
    expect(h.shown()).toEqual(['Anthropic: Claude Opus 5.5', 'Anthropic: Claude Haiku 5.5']);
    h.type('ANTHROPIC haiku');
    expect(h.shown()).toEqual(['Anthropic: Claude Haiku 5.5']);
    h.type('gpt-6.2');
    expect(h.shown()).toEqual(['OpenAI: GPT-6.2 Astra']);
    expect(h.empty().classList.contains('hidden')).toBe(true);
    h.type('llama');
    expect(h.shown()).toEqual([]);
    expect(h.empty().classList.contains('hidden')).toBe(false);
    expect(h.empty().textContent).toBe('No model matches');
    expect([...h.menu.querySelectorAll('[role="menuitem"]:not(.hidden)')].map((r) => r.textContent!.trim())).toEqual(['Other model…']);
  });

  it('Enter picks the first row shown; the arrows move between the field and the rows; typing on a row filters on', () => {
    const h = open(MODELS);
    h.type('gemini');
    h.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(picked).toHaveBeenLastCalledWith('gemini');
    expect(isPopupMenuOpen()).toBe(false);

    const k = open(MODELS);
    k.type('claude');
    k.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const rows = () => [...k.menu.querySelectorAll<HTMLElement>('[data-ref="menu-list"] [role="menuitem"]:not(.hidden)')];
    expect(document.activeElement).toBe(rows()[0]);
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(rows()[1]);
    rows()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(k.input);
    k.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    expect(k.input.value).toBe('claude k');
    expect(document.activeElement).toBe(k.input);
    expect(k.shown()).toEqual(['Anthropic: Claude Haiku 5.5']);
  });
});
