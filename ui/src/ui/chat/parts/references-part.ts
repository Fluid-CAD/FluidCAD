import type { ChatPart, ReferencesPart, SceneReference } from '../chat-types';
import { referenceLabel, referenceToken } from '../scene-references';
import type { PartView } from './part-view';

/**
 * The scene references a user message carries (§11), as chips: each one's
 * colour, its `[n]`, how many faces or edges, and the selector as the
 * tooltip. The capture they were drawn in is the message's image part,
 * under them.
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
    this.el.replaceChildren(...part.references.map(referenceChip));
  }
}

/**
 * A reference that was sent, as a chip with nothing to click: its colour,
 * `[n]`, how many faces or edges, the selector as the tooltip. A user
 * message's references and the picks of an answered question (§27) show so.
 */
export function referenceChip(reference: SceneReference): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'chat-reference-chip';
  chip.dataset.n = String(reference.n);
  chip.dataset.color = reference.color.name;
  chip.title = reference.selector.source;
  const dot = document.createElement('span');
  dot.className = 'chat-reference-dot';
  if (/^#[0-9a-f]{3,8}$/i.test(reference.color.hex)) {
    dot.style.backgroundColor = reference.color.hex;
  }
  const label = document.createElement('span');
  label.className = 'truncate';
  label.textContent = `${referenceToken(reference.n)} ${referenceLabel(reference.kind, reference.count)}`;
  chip.append(dot, label);
  return chip;
}
