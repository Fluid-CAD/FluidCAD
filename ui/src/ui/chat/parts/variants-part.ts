import { ChatIcons } from '../chat-icons';
import { MAX_ANSWER_CHARS, type ChatPart, type VariantTile, type VariantsPart, type VariantsReply } from '../chat-types';
import { factLines } from './build-facts';
import type { PartContext, PartView } from './part-view';

export { factLines };

/**
 * What the agent proposed through `propose_variants`
 * (docs/agent-chat-plan.md §24), as one card: the two variants side by
 * side, each a tile with a picture of its build, its label and description
 * and what it produces (bodies, overall size, volume).
 *
 * While the engine builds them the tiles say so and fill in one after the
 * other. Then the user picks a tile and applies it, writes their own answer
 * instead, or skips; whichever of a pick and their own words they touched
 * last is what is sent. A variant that did not build says why and cannot be
 * picked. "Show in viewport" draws a built variant over the model on screen
 * as a translucent ghost, one at a time, until it is toggled off, the card
 * is answered, or the card leaves the screen.
 *
 * A tile's picture is the one the session kept (`image`); until there is
 * one, this page draws it from the variant's scratch build and hands the
 * picture over, so every tab, a reload and a restarted engine show the same.
 *
 * Labels, descriptions and reasons are the model's or the engine's words:
 * set as text, never as markup. The state comes from the part, so a second
 * tab shows the same card; the first reply wins. Once settled the card
 * keeps its tiles, the picked one marked, and nothing to click.
 */
export class VariantsPartView implements PartView {
  readonly el: HTMLDivElement;
  private part: VariantsPart;
  /** The tile the user has picked, before it is sent. */
  private picked: string | null = null;
  /** What the user has written instead, before it is sent. */
  private written = '';
  /** The reply this card sent and the engine has not settled yet (its controls wait). */
  private sending: 'answer' | 'skip' | null = null;
  /** Pictures this page drew, by build id: shown until (and after) the session keeps one. */
  private readonly drawn = new Map<string, string>();
  /** Builds this page was asked to draw: each is drawn once, whether or not it could be. */
  private readonly asked = new Set<string>();
  /** Builds whose drawing is in flight. */
  private readonly drawing = new Set<string>();
  /** The build this card shows in the viewport. */
  private ghost: string | null = null;
  /** Builds that could not be shown in the viewport. */
  private readonly ghostless = new Set<string>();
  private applyButton: HTMLButtonElement | null = null;
  private skipButton: HTMLButtonElement | null = null;
  private field: HTMLInputElement | null = null;

  constructor(part: VariantsPart, private readonly ctx: PartContext) {
    this.part = part;
    this.el = document.createElement('div');
    this.el.className = 'chat-variants';
    this.el.dataset.part = 'variants';
    this.paint();
  }

  update(part: ChatPart): void {
    if (part.type !== 'variants') {
      return;
    }
    const waited = this.part.state === 'awaiting-choice';
    this.part = part;
    // Still waiting: what the user picked and typed stays as it is; a tile may have gained its picture.
    if (waited && part.state === 'awaiting-choice') {
      this.paintPictures();
      return;
    }
    this.sending = null;
    if (part.state !== 'awaiting-choice') {
      this.hideGhost();
    }
    this.paint();
  }

  dispose(): void {
    this.hideGhost();
  }

  /** Takes this card's variant out of the viewport, if it shows one. */
  hideGhost(): void {
    if (this.ghost === null) {
      return;
    }
    this.ghost = null;
    this.ctx.hideVariantGhost?.();
    this.paintGhostButtons();
  }

  private paint(): void {
    const part = this.part;
    const choosing = part.state === 'awaiting-choice';
    this.el.dataset.state = part.state;
    this.el.replaceChildren();
    this.applyButton = null;
    this.skipButton = null;
    this.field = null;

    const head = document.createElement('div');
    head.className = 'chat-variants-head';
    const question = document.createElement('div');
    question.className = 'chat-variants-question';
    question.dataset.ref = 'variants-question';
    question.textContent = part.question || 'Which version?';
    const file = document.createElement('div');
    file.className = 'chat-variants-file';
    file.dataset.ref = 'variants-file';
    file.textContent = part.file;
    file.title = part.file;
    head.append(question, file);
    this.el.append(head);

    const tiles = document.createElement('div');
    tiles.className = 'chat-variants-tiles';
    tiles.setAttribute('role', 'group');
    tiles.setAttribute('aria-label', part.question || 'Variants');
    for (const tile of part.variants) {
      tiles.append(this.tile(tile, choosing));
    }
    this.el.append(tiles);

    if (choosing) {
      this.paintChoice();
    } else if (part.state === 'building') {
      const built = part.variants.filter((t) => t.state !== 'queued' && t.state !== 'building').length;
      const line = document.createElement('div');
      line.className = 'chat-variants-progress';
      line.dataset.ref = 'variants-progress';
      const spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-xs';
      line.append(spinner, text(`Building ${Math.min(built + 1, part.variants.length)} of ${part.variants.length}. The app waits while a variant builds.`));
      this.el.append(line);
    } else {
      this.el.append(this.outcome());
    }
    this.paintPictures();
  }

  // --- A tile -----------------------------------------------------------------

  private tile(tile: VariantTile, choosing: boolean): HTMLElement {
    const canPick = choosing && tile.state === 'ready' && !!this.ctx.chooseVariant;
    const wrap = document.createElement('div');
    wrap.className = 'chat-variant';
    wrap.dataset.ref = 'variant';
    wrap.dataset.label = tile.label;
    wrap.dataset.state = tile.state;
    wrap.dataset.picked = String(this.part.state === 'picked' && this.part.picked === tile.label);

    // The whole tile is the pick: one button, pressed while it is the choice.
    const body = document.createElement(choosing ? 'button' : 'div') as HTMLButtonElement | HTMLDivElement;
    body.className = 'chat-variant-body';
    body.dataset.ref = 'variant-pick';
    if (body instanceof HTMLButtonElement) {
      body.type = 'button';
      body.disabled = !canPick;
      body.setAttribute('aria-pressed', String(this.picked === tile.label));
      body.addEventListener('click', () => this.pick(tile.label));
    }

    const picture = document.createElement('span');
    picture.className = 'chat-variant-picture';
    picture.dataset.ref = 'variant-picture';
    body.append(picture);

    const name = document.createElement('span');
    name.className = 'chat-variant-name';
    const mark = document.createElement('span');
    mark.className = 'chat-variant-mark';
    mark.append(ChatIcons.span(ChatIcons.CHECK, '[&>svg]:size-3'));
    const label = document.createElement('span');
    label.className = 'chat-variant-label';
    label.dataset.ref = 'variant-label';
    label.textContent = tile.label;
    name.append(mark, label);
    body.append(name);

    if (tile.description) {
      const description = document.createElement('span');
      description.className = 'chat-variant-description';
      description.dataset.ref = 'variant-description';
      description.textContent = tile.description;
      body.append(description);
    }
    if (tile.facts) {
      const facts = document.createElement('span');
      facts.className = 'chat-variant-facts';
      facts.dataset.ref = 'variant-facts';
      for (const fact of factLines(tile.facts)) {
        const line = document.createElement('span');
        line.textContent = fact;
        facts.append(line);
      }
      body.append(facts);
    }
    if (tile.state === 'failed') {
      const error = document.createElement('span');
      error.className = 'chat-variant-error';
      error.dataset.ref = 'variant-error';
      error.append(ChatIcons.span(ChatIcons.ERROR, '[&>svg]:size-3.5 mt-px'));
      const words = document.createElement('span');
      words.textContent = tile.error ?? 'It did not build.';
      error.append(words);
      body.append(error);
    } else if (tile.facts?.sound === false) {
      const warning = document.createElement('span');
      warning.className = 'chat-variant-warning';
      warning.dataset.ref = 'variant-warning';
      warning.append(ChatIcons.span(ChatIcons.WARNING, '[&>svg]:size-3.5 mt-px'), text('The geometry check found a problem in a solid.'));
      body.append(warning);
    }
    wrap.append(body);

    // Looking closer: the build over the model on screen. A part's build only;
    // an assembly's instances are not drawn this way.
    if (choosing && tile.buildId && tile.sceneKind !== 'assembly' && this.ctx.showVariantGhost) {
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'chat-variant-show';
      show.dataset.ref = 'variant-show';
      show.dataset.build = tile.buildId;
      show.append(ChatIcons.span(ChatIcons.VIEW, '[&>svg]:size-3.5'), text('Show in viewport'));
      const buildId = tile.buildId;
      show.addEventListener('click', () => void this.toggleGhost(buildId));
      wrap.append(show);
    }
    return wrap;
  }

  /** What each tile's picture area shows now: the picture, or why there is none yet. */
  private paintPictures(): void {
    const pictures = this.el.querySelectorAll<HTMLElement>('[data-ref="variant-picture"]');
    for (const [index, tile] of this.part.variants.entries()) {
      // One picture area per tile, in the tiles' order.
      const picture = pictures[index];
      if (!picture) {
        continue;
      }
      const local = tile.buildId ? this.drawn.get(tile.buildId) : undefined;
      // The page's own drawing stays once shown: the kept picture is the same build.
      const src = local ?? (tile.image ? this.ctx.fileUrl(tile.image) : '');
      if (src) {
        const current = picture.querySelector('img');
        if (current?.getAttribute('src') !== src) {
          const image = document.createElement('img');
          image.alt = `${tile.label}: a picture of the built variant`;
          image.decoding = 'async';
          image.draggable = false;
          image.src = src;
          picture.dataset.shows = 'picture';
          picture.replaceChildren(image);
        }
        continue;
      }
      if (tile.buildId && !tile.image && this.ctx.variantPicture && !this.asked.has(tile.buildId)) {
        this.draw(tile.buildId, tile.label);
      }
      const waiting = tile.state === 'building' || tile.state === 'queued' || (!!tile.buildId && this.drawing.has(tile.buildId));
      picture.dataset.shows = waiting ? 'waiting' : 'nothing';
      picture.replaceChildren(placeholder(tile, waiting));
    }
    this.paintGhostButtons();
  }

  private draw(buildId: string, label: string): void {
    this.asked.add(buildId);
    this.drawing.add(buildId);
    const part = this.part;
    void this.ctx.variantPicture!(buildId)
      .catch((): null => null)
      .then((dataUrl) => {
        this.drawing.delete(buildId);
        if (dataUrl) {
          this.drawn.set(buildId, dataUrl);
          // Kept with the session unless another page's picture already is.
          if (!this.part.variants.find((t) => t.buildId === buildId)?.image) {
            this.ctx.saveVariantPicture?.(part.id, label, dataUrl);
          }
        }
        this.paintPictures();
      });
  }

  // --- Looking closer -----------------------------------------------------------

  private async toggleGhost(buildId: string): Promise<void> {
    if (!this.ctx.showVariantGhost || this.part.state !== 'awaiting-choice') {
      return;
    }
    if (this.ghost === buildId) {
      this.hideGhost();
      return;
    }
    this.ghost = buildId;
    this.paintGhostButtons();
    const shown = await this.ctx.showVariantGhost(buildId).catch(() => false);
    if (this.ghost !== buildId) {
      // Toggled off, or the card was answered, while its meshes loaded.
      if (this.ghost === null && shown) {
        this.ctx.hideVariantGhost?.();
      }
      return;
    }
    if (!shown) {
      this.ghost = null;
      this.ghostless.add(buildId);
      this.paintGhostButtons();
    }
  }

  private paintGhostButtons(): void {
    for (const button of this.el.querySelectorAll<HTMLButtonElement>('[data-ref="variant-show"]')) {
      const buildId = button.dataset.build ?? '';
      const gone = this.ghostless.has(buildId);
      button.setAttribute('aria-pressed', String(this.ghost === buildId));
      button.disabled = gone;
      button.title = gone
        ? 'This build is no longer kept by the engine, so it cannot be shown.'
        : this.ghost === buildId
          ? 'Take it out of the viewport'
          : 'Draw this variant over the model, translucent';
    }
  }

  // --- Choosing ---------------------------------------------------------------

  private paintChoice(): void {
    const canAnswer = !!this.ctx.chooseVariant;
    if (canAnswer) {
      const field = document.createElement('input');
      field.type = 'text';
      field.className = 'chat-question-input';
      field.dataset.ref = 'variants-text';
      field.maxLength = MAX_ANSWER_CHARS;
      field.autocomplete = 'off';
      field.spellcheck = true;
      field.placeholder = 'Or say what you want instead…';
      field.setAttribute('aria-label', 'Your own answer instead of a variant');
      field.value = this.written;
      field.addEventListener('input', () => {
        this.written = field.value;
        // Their own words are an answer instead of a pick.
        if (this.written.trim() !== '' && this.picked !== null) {
          this.picked = null;
          this.paintPicks();
        }
        this.paintActions();
      });
      field.addEventListener('keydown', (event) => {
        // Enter sends; while an IME composes, Enter belongs to it.
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          void this.send('answer');
        }
      });
      this.field = field;
      this.el.append(field);
    }

    const actions = document.createElement('div');
    actions.className = 'chat-question-actions';
    const waiting = document.createElement('span');
    waiting.className = 'chat-question-waiting';
    waiting.append(ChatIcons.span(ChatIcons.WAITING, '[&>svg]:size-3.5'), text('The agent is waiting for your choice'));
    actions.append(waiting);
    if (canAnswer) {
      const buttons = document.createElement('div');
      buttons.className = 'chat-question-buttons';
      this.skipButton = actionButton('variants-skip', 'Skip', 'btn-ghost chat-approval-secondary');
      this.skipButton.title = 'Apply neither; let the agent decide';
      this.skipButton.addEventListener('click', () => void this.send('skip'));
      this.applyButton = actionButton('variants-apply', 'Apply', 'btn-primary');
      this.applyButton.addEventListener('click', () => void this.send('answer'));
      buttons.append(this.skipButton, this.applyButton);
      actions.append(buttons);
    }
    this.el.append(actions);
    this.paintActions();
  }

  private pick(label: string): void {
    if (this.sending !== null || this.part.state !== 'awaiting-choice') {
      return;
    }
    this.picked = this.picked === label ? null : label;
    if (this.picked !== null && this.written !== '') {
      // A pick is an answer instead of their own words.
      this.written = '';
      if (this.field) {
        this.field.value = '';
      }
    }
    this.paintPicks();
    this.paintActions();
  }

  private paintPicks(): void {
    for (const tile of this.el.querySelectorAll<HTMLElement>('[data-ref="variant"]')) {
      tile.querySelector('[data-ref="variant-pick"]')?.setAttribute('aria-pressed', String(this.picked === tile.dataset.label));
    }
  }

  /** The reply as it would be sent now: the pick, else what the user wrote. */
  private reply(): VariantsReply | null {
    if (this.picked !== null) {
      return { pick: this.picked };
    }
    const written = this.written.trim();
    return written ? { text: written } : null;
  }

  private paintActions(): void {
    const busy = this.sending !== null;
    const reply = this.reply();
    if (this.applyButton) {
      // A pick is applied to the file; the user's own words are sent to the agent.
      const label = reply && 'text' in reply ? 'Send' : 'Apply';
      this.applyButton.disabled = busy || reply === null;
      this.applyButton.title = reply && 'pick' in reply ? `Write “${reply.pick}” to ${this.part.file}` : '';
      spin(this.applyButton, this.sending === 'answer', label);
    }
    if (this.skipButton) {
      this.skipButton.disabled = busy;
      spin(this.skipButton, this.sending === 'skip', 'Skip');
    }
    if (this.field) {
      this.field.disabled = busy;
    }
    for (const button of this.el.querySelectorAll<HTMLButtonElement>('button[data-ref="variant-pick"]')) {
      const tile = this.part.variants.find((t) => t.label === button.closest<HTMLElement>('[data-ref="variant"]')?.dataset.label);
      button.disabled = busy || tile?.state !== 'ready' || !this.ctx.chooseVariant;
    }
  }

  private async send(kind: 'answer' | 'skip'): Promise<void> {
    const part = this.part;
    if (this.sending !== null || !this.ctx.chooseVariant || part.state !== 'awaiting-choice') {
      return;
    }
    const reply: VariantsReply | null = kind === 'skip' ? { skip: true } : this.reply();
    if (!reply) {
      return;
    }
    this.sending = kind;
    this.paintActions();
    const ok = await this.ctx.chooseVariant(part.id, reply);
    // Taken: the part's update settles the card. Refused while it still waits: choose again.
    if (!ok && this.part.state === 'awaiting-choice' && this.part.id === part.id) {
      this.sending = null;
      this.paintActions();
    }
  }

  // --- Settled ----------------------------------------------------------------

  private outcome(): HTMLElement {
    const part = this.part;
    switch (part.state) {
      case 'picked':
        return outcomeLine(ChatIcons.CHECK, `You picked ${part.picked ?? 'a variant'}.`, 'picked');
      case 'answered':
        return outcomeLine(ChatIcons.CHECK, part.text ?? '', 'answered');
      case 'skipped':
        return outcomeLine(ChatIcons.DENIED, 'You skipped this; the agent decides.', 'skipped');
      case 'failed':
        return outcomeLine(ChatIcons.ERROR, part.reason ?? 'Nothing was applied.', 'failed');
      default:
        return outcomeLine(ChatIcons.DENIED, part.reason ?? 'Not chosen.', 'unanswered');
    }
  }
}

/** What a tile shows in place of a picture. */
function placeholder(tile: VariantTile, waiting: boolean): HTMLElement {
  const holder = document.createElement('span');
  holder.className = 'chat-variant-placeholder';
  holder.dataset.ref = 'variant-placeholder';
  if (waiting) {
    if (tile.state === 'queued') {
      holder.append(ChatIcons.span(ChatIcons.WAITING, '[&>svg]:size-4'), text('Queued'));
    } else {
      const spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-sm';
      holder.append(spinner, text(tile.state === 'building' ? 'Building…' : 'Drawing…'));
    }
    return holder;
  }
  const words = tile.state === 'cancelled'
    ? 'Not built'
    : tile.state === 'failed' && !tile.buildId
      ? 'Did not build'
      : 'No picture';
  holder.append(ChatIcons.span(ChatIcons.NO_PICTURE, '[&>svg]:size-5'), text(words));
  return holder;
}

function outcomeLine(icon: string, words: string, kind: string): HTMLElement {
  const line = document.createElement('div');
  line.className = 'chat-variants-outcome';
  line.dataset.ref = 'variants-outcome';
  line.dataset.kind = kind;
  line.append(ChatIcons.span(icon, '[&>svg]:size-3.5 mt-px'));
  const said = document.createElement('span');
  said.className = 'min-w-0 break-words whitespace-pre-wrap';
  said.textContent = words;
  line.append(said);
  return line;
}

function actionButton(ref: string, label: string, variant: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.ref = ref;
  button.className = `btn btn-xs ${variant}`;
  button.textContent = label;
  return button;
}

/** The button's label, behind a spinner while its reply is on the way. */
function spin(button: HTMLButtonElement, on: boolean, label: string): void {
  button.replaceChildren();
  if (on) {
    const spinner = document.createElement('span');
    spinner.className = 'loading loading-spinner loading-xs';
    button.append(spinner);
  }
  button.append(text(label));
}

function text(value: string): Text {
  return document.createTextNode(value);
}
