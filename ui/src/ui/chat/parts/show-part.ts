import { ChatIcons } from '../chat-icons';
import type { ChatPart, ShowItem, ShowPart } from '../chat-types';
import type { PointedCard } from '../pointing';
import { referenceColor } from '../reference-colors';
import { referenceToken } from '../scene-references';
import type { PartContext, PartView } from './part-view';

/**
 * What the agent pointed at through `show_user` (docs/agent-chat-plan.md
 * §27), as one card: a chip per item — its number, its colour and the
 * agent's label — and the agent's note. The agent's text refers to the chips
 * as `[1]`, `[2]`, the way the user's own references read.
 *
 * The card holds no state. Which card is shown in the viewport, and how each
 * of its items stands against the model on screen, is the panel's
 * ({@link PartContext.pointer}): a card that has just arrived shows itself
 * once, replacing the one shown before; **Clear** takes the highlight away
 * and **Show in viewport** brings it back, on any card, after any reload.
 * While it is shown, hovering (or focusing) a chip draws that item alone at
 * full strength; an item that no longer resolves after an edit is marked
 * stale and not drawn; and when another file is on screen the card says so
 * instead of resolving its selectors there.
 *
 * Labels and the note are the agent's words, which may repeat what a file or
 * a package told it: they are set as text, never as markup.
 */
export class ShowPartView implements PartView {
  readonly el: HTMLDivElement;
  private part: ShowPart;
  private readonly unsubscribe: (() => void) | null;
  private readonly chips: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly toggle: HTMLButtonElement | null;
  /** What the chips and the button were last painted from. */
  private painted = '';

  constructor(part: ShowPart, private readonly ctx: PartContext, live: boolean) {
    this.part = part;
    this.el = document.createElement('div');
    this.el.className = 'chat-show';
    this.el.dataset.part = 'show';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', `Pointed at in ${part.file}`);

    const head = document.createElement('div');
    head.className = 'chat-show-head';
    const title = document.createElement('span');
    title.className = 'chat-show-title';
    title.append(ChatIcons.span(ChatIcons.POINT, '[&>svg]:size-3.5'), document.createTextNode('In the viewport'));
    const file = document.createElement('span');
    file.className = 'chat-show-file';
    file.dataset.ref = 'show-file';
    file.textContent = part.file;
    file.title = part.file;
    head.append(title, file);
    this.toggle = ctx.pointer ? document.createElement('button') : null;
    if (this.toggle) {
      this.toggle.type = 'button';
      this.toggle.className = 'chat-show-toggle';
      this.toggle.dataset.ref = 'show-toggle';
      this.toggle.addEventListener('click', () => this.onToggle());
      head.append(this.toggle);
    }
    this.el.append(head);
    if (part.note) {
      const note = document.createElement('div');
      note.className = 'chat-show-note';
      note.dataset.ref = 'show-note';
      note.textContent = part.note;
      this.el.append(note);
    }
    this.chips = document.createElement('div');
    this.chips.className = 'chat-show-chips';
    this.chips.dataset.ref = 'show-chips';
    this.chips.setAttribute('role', 'list');
    this.status = document.createElement('div');
    this.status.className = 'chat-show-status hidden';
    this.status.dataset.ref = 'show-status';
    this.el.append(this.chips, this.status);

    this.unsubscribe = ctx.pointer?.subscribe(() => this.paint()) ?? null;
    // A card that has just arrived points by itself, once; one a reload or a
    // repaint brings back waits to be asked.
    if (ctx.pointer?.firstSight(part.id) && live) {
      ctx.pointer.show(part);
    }
    this.paint();
  }

  update(part: ChatPart): void {
    if (part.type !== 'show') {
      return;
    }
    this.part = part;
    this.painted = '';
    this.paint();
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  private onToggle(): void {
    const pointer = this.ctx.pointer;
    if (!pointer) {
      return;
    }
    if (pointer.shown(this.part.id)) {
      pointer.clear(this.part.id);
    } else {
      pointer.show(this.part);
    }
  }

  private paint(): void {
    const shown = this.ctx.pointer?.shown(this.part.id) ?? null;
    const signature = JSON.stringify(shown);
    if (signature === this.painted) {
      return;
    }
    this.painted = signature;
    this.el.dataset.shown = String(shown !== null);
    if (this.toggle) {
      this.toggle.setAttribute('aria-pressed', String(shown !== null));
      this.toggle.textContent = shown ? 'Clear' : 'Show in viewport';
      this.toggle.title = shown ? 'Remove the highlight from the viewport' : 'Highlight these in the viewport again';
    }
    // The chips are kept across repaints: a hover that redraws them under the pointer would end itself.
    const existing = new Map([...this.chips.querySelectorAll<HTMLElement>('[data-ref="show-chip"]')].map((chip) => [chip.dataset.n, chip]));
    const chips = this.part.items.map((item) => this.chip(item, shown, existing.get(String(item.n))));
    if (chips.some((chip, index) => this.chips.children[index] !== chip) || this.chips.children.length !== chips.length) {
      this.chips.replaceChildren(...chips);
    }
    const status = this.statusText(shown);
    this.status.textContent = status ?? '';
    this.status.classList.toggle('hidden', status === null);
  }

  /** The chip of `item`, as it stands on the shown card (`shown` null: this card is not the one shown). */
  private chip(item: ShowItem, shown: PointedCard | null, existing: HTMLElement | undefined): HTMLElement {
    const chip = existing ?? this.newChip(item);
    const pointed = shown && !shown.offScreen ? shown.items.find((p) => p.n === item.n) : undefined;
    const state = pointed?.state ?? 'idle';
    chip.dataset.state = state;
    chip.dataset.emphasised = String(!!shown && shown.emphasised === item.n);
    chip.setAttribute('aria-busy', String(state === 'resolving'));
    const tag = chip.querySelector<HTMLElement>('[data-ref="show-stale"]')!;
    tag.classList.toggle('hidden', state !== 'stale');
    chip.title = state === 'stale'
      ? `${item.label} — no longer in the model: ${pointed?.reason ?? ''}`.trim()
      : `${item.label} — ${countText(item)}`;
    return chip;
  }

  private newChip(item: ShowItem): HTMLElement {
    const color = referenceColor(item.n);
    const chip = document.createElement('span');
    chip.className = 'chat-reference-chip chat-show-chip';
    chip.dataset.ref = 'show-chip';
    chip.dataset.n = String(item.n);
    chip.dataset.color = color.name;
    chip.setAttribute('role', 'listitem');
    // Focusable: the keyboard emphasises an item as the mouse does.
    chip.tabIndex = 0;
    chip.style.setProperty('--chat-reference-color', color.hex);
    const dot = document.createElement('span');
    dot.className = 'chat-reference-dot';
    dot.style.backgroundColor = color.hex;
    const label = document.createElement('span');
    label.className = 'chat-show-label truncate';
    label.dataset.ref = 'show-label';
    label.textContent = `${referenceToken(item.n)} ${item.label}`;
    const stale = document.createElement('span');
    stale.className = 'chat-show-stale hidden';
    stale.dataset.ref = 'show-stale';
    stale.textContent = 'stale';
    chip.append(dot, label, stale);
    const emphasise = (n: number | null) => this.ctx.pointer?.emphasise(this.part.id, n);
    chip.addEventListener('mouseenter', () => emphasise(item.n));
    chip.addEventListener('mouseleave', () => emphasise(null));
    chip.addEventListener('focus', () => emphasise(item.n));
    chip.addEventListener('blur', () => emphasise(null));
    return chip;
  }

  /** The line under the chips: what stops the card from pointing, when something does. */
  private statusText(shown: PointedCard | null): string | null {
    if (!shown) {
      return null;
    }
    if (shown.offScreen) {
      return `${this.part.file} is not the model on screen, so nothing is highlighted.`;
    }
    const stale = shown.items.filter((item) => item.state === 'stale');
    if (stale.length === 0) {
      return null;
    }
    if (stale.length === shown.items.length) {
      return stale.length === 1
        ? 'The model changed: this is no longer in it.'
        : 'The model changed: none of these is in it any more.';
    }
    const tokens = stale.map((item) => referenceToken(item.n));
    const list = tokens.length === 1 ? tokens[0] : `${tokens.slice(0, -1).join(', ')} and ${tokens[tokens.length - 1]}`;
    return `The model changed: ${list} ${stale.length === 1 ? 'is' : 'are'} no longer in it.`;
  }
}

/** "1 face", "2 faces, 4 edges": what the item was when the agent showed it. */
function countText(item: ShowItem): string {
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [...(item.faces > 0 ? [count(item.faces, 'face')] : []), ...(item.edges > 0 ? [count(item.edges, 'edge')] : [])].join(', ') || 'nothing';
}
