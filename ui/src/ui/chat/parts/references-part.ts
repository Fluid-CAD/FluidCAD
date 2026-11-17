import type { ChatPart, ReferencesPart } from '../chat-types';
import type { PartView } from './part-view';

/**
 * The scene references a user message carries, as chips (§11). Phase 6
 * attaches them from the composer and gives the chips their full look; a
 * transcript that has some already shows each one's colour, number and
 * selector.
 */
export class ReferencesPartView implements PartView {
  readonly el: HTMLDivElement;

  constructor(part: ReferencesPart) {
    this.el = document.createElement('div');
    this.el.className = 'chat-references';
    this.el.dataset.part = 'references';
    this.update(part);
  }

  update(part: ChatPart): void {
    if (part.type !== 'references') {
      return;
    }
    this.el.replaceChildren();
    for (const reference of part.references) {
      const chip = document.createElement('span');
      chip.className = 'chat-reference-chip';
      chip.title = reference.selector.source;
      const dot = document.createElement('span');
      dot.className = 'chat-reference-dot';
      if (/^#[0-9a-f]{3,8}$/i.test(reference.color.hex)) {
        dot.style.backgroundColor = reference.color.hex;
      }
      const label = document.createElement('span');
      label.className = 'truncate';
      label.textContent = `${reference.n} · ${reference.count > 1 ? `${reference.count} ${reference.kind}s` : reference.kind}`;
      chip.append(dot, label);
      this.el.append(chip);
    }
  }
}
