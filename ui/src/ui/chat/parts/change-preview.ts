import { ChatIcons } from '../chat-icons';
import type { ChangePreview, ChangePreviewSide, ToolPart } from '../chat-types';
import { factChanges, factLines } from './build-facts';
import type { PartContext } from './part-view';

type Side = 'before' | 'after';

/**
 * What a change does to the model, on its approval card
 * (docs/agent-chat-plan.md §25): the file as it is and the file with the
 * change, each built by the engine without being written.
 *
 * - **Before and after**, two pictures drawn from one camera and framed on
 *   both, so a change of size or shape reads at a glance; under them the
 *   facts as differences (bodies, overall size, volume with its signed
 *   change and percentage).
 * - **A change that does not build** says so first, with the reasons: the
 *   user still answers the approval as they see fit.
 * - **No change to the geometry** replaces two identical pictures when both
 *   sides draw the same meshes (a comment, a rename).
 * - **Preview the change**: shown instead when the file's last build was
 *   slow, so nothing holds the engine unasked.
 * - **Show in viewport** draws the file with the change over the model on
 *   screen, translucent, while the approval waits.
 *
 * The pictures are the ones the session kept (`image`); until there are
 * any, this page draws them from the two scratch builds and hands them
 * over, so every tab, a reload and a restarted engine show the same. A
 * preview that was never built (`cancelled`) shows nothing at all.
 *
 * Reasons are the engine's words: set as text, never as markup.
 */
export class ChangePreviewView {
  readonly el: HTMLDivElement;
  private part: ToolPart;
  /** The on-demand build this card asked for and the engine has not started yet. */
  private asking = false;
  /** Pictures this page drew, by build id: shown until (and after) the session keeps its own. */
  private readonly drawn = new Map<string, string>();
  /** The pairs of builds this page was asked to draw: each is drawn once, whether or not it could be. */
  private readonly asked = new Set<string>();
  /** Whether a drawing is in flight. */
  private drawing = false;
  /** The picture elements on screen, by source: a repaint moves them instead of loading them again. */
  private readonly images = new Map<string, HTMLImageElement>();
  /** The build this card shows in the viewport. */
  private ghost: string | null = null;
  /** Builds that could not be shown in the viewport. */
  private readonly ghostless = new Set<string>();

  constructor(part: ToolPart, private readonly ctx: PartContext) {
    this.part = part;
    this.el = document.createElement('div');
    this.el.className = 'chat-change';
    this.el.dataset.ref = 'preview';
    this.paint();
  }

  /** Whether the card has a preview to show: one offered, building or built. */
  get shown(): boolean {
    const state = this.part.preview?.state;
    return state === 'offered' || state === 'building' || state === 'ready';
  }

  update(part: ToolPart): void {
    this.part = part;
    if (part.preview?.state !== 'offered') {
      this.asking = false;
    }
    if (part.state !== 'awaiting-approval') {
      this.hideGhost();
    }
    this.paint();
  }

  dispose(): void {
    this.hideGhost();
  }

  /** Takes this card's change out of the viewport, if it shows it. */
  hideGhost(): void {
    if (this.ghost === null) {
      return;
    }
    this.ghost = null;
    this.ctx.hideVariantGhost?.();
    this.paintGhostButton();
  }

  private get waiting(): boolean {
    return this.part.state === 'awaiting-approval';
  }

  private paint(): void {
    const preview = this.part.preview;
    this.el.replaceChildren();
    this.el.dataset.state = preview?.state ?? 'none';
    this.el.classList.toggle('hidden', !this.shown);
    if (!preview || !this.shown) {
      return;
    }
    switch (preview.state) {
      case 'offered':
        this.el.append(this.offer(preview));
        return;
      case 'building':
        // The rows the facts will fill hold their place, so what is under the block moves little when it is ready.
        this.el.append(this.tiles(preview, true), ...(preview.before === null ? [] : [pendingFacts()]), progress());
        return;
      case 'ready':
        this.paintReady(preview);
        return;
    }
  }

  // --- Offered ----------------------------------------------------------------

  private offer(preview: ChangePreview): HTMLElement {
    const row = document.createElement('div');
    row.className = 'chat-change-offer';
    const words = document.createElement('span');
    words.className = 'chat-change-offer-words';
    words.dataset.ref = 'preview-offer';
    words.textContent = preview.estimateMs !== undefined
      ? `Not previewed: this file's last build took ${duration(preview.estimateMs)}.`
      : 'Not previewed.';
    row.append(words);
    if (this.waiting && this.part.approval && this.ctx.requestPreview) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.ref = 'preview-build';
      button.className = 'btn btn-xs btn-ghost chat-approval-secondary shrink-0';
      button.disabled = this.asking;
      button.title = 'Build the file as it is and with the change, to show both. The app waits while they build.';
      if (this.asking) {
        const spinner = document.createElement('span');
        spinner.className = 'loading loading-spinner loading-xs';
        button.append(spinner);
      }
      button.append(text('Preview the change'));
      button.addEventListener('click', () => void this.ask());
      row.append(button);
    }
    return row;
  }

  private async ask(): Promise<void> {
    const approval = this.part.approval;
    if (!approval || this.asking || !this.ctx.requestPreview || !this.waiting) {
      return;
    }
    this.asking = true;
    this.paint();
    const ok = await this.ctx.requestPreview(approval.id);
    // Taken: the part's update shows the build. Refused while it is still offered: ask again.
    if (!ok && this.part.preview?.state === 'offered') {
      this.asking = false;
      this.paint();
    }
  }

  // --- Built ------------------------------------------------------------------

  private paintReady(preview: ChangePreview): void {
    const before = preview.before ?? null;
    const after = preview.after;
    if (!after) {
      return;
    }
    if (after.state === 'failed') {
      this.el.append(problems(after, before));
    } else if (before?.state === 'failed') {
      this.el.append(note(ChatIcons.CHECK, 'The file as it is does not build; with this change it does.', 'fixes'));
    }
    if (preview.same) {
      // A feature that fails is left out of the build: what did build is then the model as it is.
      this.el.append(after.state === 'failed'
        ? note(ChatIcons.INFO, 'What does build is the same geometry as now.', 'same')
        : note(ChatIcons.CHECK, 'No change to the geometry', 'same'));
      if (after.facts) {
        this.el.append(lines(factLines(after.facts)));
      }
    } else {
      const tiles = this.tiles(preview, false);
      if (tiles.childElementCount > 0) {
        this.el.append(tiles);
      }
      const facts = this.facts(before, after);
      if (facts) {
        this.el.append(facts);
      }
    }
    if (after.state === 'built' && after.facts?.sound === false) {
      const warning = note(ChatIcons.WARNING, 'The geometry check found a problem in a solid.', 'unsound');
      this.el.append(warning);
    }
    // Looking closer: the file with the change over the model on screen. A
    // part's build only (an assembly's instances are not drawn this way), and
    // not a file the change creates: the model on screen is another file's.
    if (this.waiting && !preview.same && before !== null && after.buildId && after.sceneKind !== 'assembly' && this.ctx.showVariantGhost) {
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'chat-variant-show chat-change-show';
      show.dataset.ref = 'preview-show';
      show.dataset.build = after.buildId;
      show.append(ChatIcons.span(ChatIcons.VIEW, '[&>svg]:size-3.5'), text('Show in viewport'));
      const buildId = after.buildId;
      show.addEventListener('click', () => void this.toggleGhost(buildId));
      this.el.append(show);
      this.paintGhostButton();
    }
  }

  /** The sides a picture is shown of: each that has a build, the file as it is first. */
  private pictured(preview: ChangePreview, building: boolean): Side[] {
    if (building) {
      return preview.before === null ? ['after'] : ['before', 'after'];
    }
    const sides: Side[] = [];
    if (preview.before?.buildId && preview.after?.buildId) {
      sides.push('before');
    }
    if (preview.after?.buildId) {
      sides.push('after');
    }
    return sides;
  }

  private tiles(preview: ChangePreview, building: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'chat-change-tiles';
    row.dataset.ref = 'preview-tiles';
    const sides = this.pictured(preview, building);
    if (!building) {
      this.draw(preview, sides);
      // Nothing to show and nothing coming (the builds are gone and nobody drew them): the facts say it alone.
      if (!this.drawing && sides.every((side) => !this.source(preview[side]!))) {
        return row;
      }
    }
    row.dataset.count = String(sides.length);
    for (const side of sides) {
      const built = preview[side] ?? undefined;
      const tile = document.createElement('div');
      tile.className = 'chat-change-tile';
      tile.dataset.ref = 'preview-tile';
      tile.dataset.side = side;
      tile.dataset.state = built?.state ?? 'building';
      const picture = document.createElement('span');
      picture.className = 'chat-variant-picture';
      picture.dataset.ref = 'preview-picture';
      const src = built ? this.source(built) : '';
      const label = side === 'before' ? 'Before' : preview.before === null ? 'New file' : 'After';
      if (src) {
        picture.dataset.shows = 'picture';
        picture.append(this.image(src, `${label}: a picture of the built model`));
      } else {
        // While the engine builds, a side waits its turn, builds, or is built
        // and waits for the other: the two are drawn together, from one camera.
        const shows = building
          ? built ? (built.buildId ? 'built' : 'nothing') : this.buildingSide(preview) === side ? 'building' : 'queued'
          : this.drawing ? 'drawing' : 'nothing';
        picture.dataset.shows = shows === 'nothing' ? 'nothing' : 'waiting';
        picture.append(placeholder(shows));
      }
      const caption = document.createElement('span');
      caption.className = 'chat-change-caption';
      caption.textContent = label;
      tile.append(picture, caption);
      row.append(tile);
    }
    return row;
  }

  /** The side the engine is building now: the first that has no outcome yet. */
  private buildingSide(preview: ChangePreview): Side {
    return preview.before === undefined ? 'before' : 'after';
  }

  /** What a side's picture area shows: this page's own drawing once made, else the picture the session kept. */
  private source(side: ChangePreviewSide): string {
    const local = side.buildId ? this.drawn.get(side.buildId) : undefined;
    return local ?? (side.image ? this.ctx.fileUrl(side.image) : '');
  }

  private image(src: string, alt: string): HTMLImageElement {
    let image = this.images.get(src);
    if (!image) {
      image = document.createElement('img');
      image.decoding = 'async';
      image.draggable = false;
      image.src = src;
      this.images.set(src, image);
    }
    image.alt = alt;
    return image;
  }

  /** Draws the pictured sides from one camera, once, when the session keeps no picture of one of them yet. */
  private draw(preview: ChangePreview, sides: Side[]): void {
    const missing = sides.filter((side) => !preview[side]!.image && !this.drawn.has(preview[side]!.buildId!));
    const key = sides.map((side) => preview[side]!.buildId).join('|');
    if (missing.length === 0 || !this.ctx.buildPictures || this.asked.has(key)) {
      return;
    }
    this.asked.add(key);
    this.drawing = true;
    const approvalId = this.part.approval?.id;
    void this.ctx.buildPictures(sides.map((side) => preview[side]!.buildId!))
      .catch((): (string | null)[] => [])
      .then((pictures) => {
        this.drawing = false;
        const made: { before?: string; after?: string } = {};
        sides.forEach((side, index) => {
          const dataUrl = pictures[index];
          if (dataUrl) {
            this.drawn.set(preview[side]!.buildId!, dataUrl);
            // Kept with the session unless another page's picture already is.
            if (!this.part.preview?.[side]?.image) {
              made[side] = dataUrl;
            }
          }
        });
        if (approvalId && (made.before || made.after)) {
          this.ctx.savePreviewPictures?.(approvalId, made);
        }
        this.paint();
      });
  }

  /** The facts under the pictures: as differences when both sides have them, else the one side's own. */
  private facts(before: ChangePreviewSide | null, after: ChangePreviewSide): HTMLElement | null {
    if (!after.facts) {
      return null;
    }
    if (!before?.facts) {
      return lines(factLines(after.facts));
    }
    const table = document.createElement('div');
    table.className = 'chat-change-facts';
    table.dataset.ref = 'preview-facts';
    table.setAttribute('role', 'table');
    for (const fact of factChanges(before.facts, after.facts)) {
      const row = document.createElement('div');
      row.className = 'chat-change-fact';
      row.dataset.ref = 'preview-fact';
      row.dataset.tone = fact.tone;
      row.setAttribute('role', 'row');
      const label = cell('chat-change-fact-label', fact.label);
      const values = cell('chat-change-fact-values', fact.before === fact.after ? fact.after : `${fact.before} → ${fact.after}`);
      const change = cell('chat-change-fact-change', fact.change || (fact.before === fact.after ? 'no change' : ''));
      row.append(label, values, change);
      table.append(row);
    }
    return table;
  }

  // --- Looking closer -----------------------------------------------------------

  private async toggleGhost(buildId: string): Promise<void> {
    if (!this.ctx.showVariantGhost || !this.waiting) {
      return;
    }
    if (this.ghost === buildId) {
      this.hideGhost();
      return;
    }
    this.ghost = buildId;
    this.paintGhostButton();
    const shown = await this.ctx.showVariantGhost(buildId).catch(() => false);
    if (this.ghost !== buildId) {
      // Toggled off, or the approval was answered, while its meshes loaded.
      if (this.ghost === null && shown) {
        this.ctx.hideVariantGhost?.();
      }
      return;
    }
    if (!shown) {
      this.ghost = null;
      this.ghostless.add(buildId);
      this.paintGhostButton();
    }
  }

  private paintGhostButton(): void {
    const button = this.el.querySelector<HTMLButtonElement>('[data-ref="preview-show"]');
    if (!button) {
      return;
    }
    const buildId = button.dataset.build ?? '';
    const gone = this.ghostless.has(buildId);
    button.setAttribute('aria-pressed', String(this.ghost === buildId));
    button.disabled = gone;
    button.title = gone
      ? 'This build is no longer kept by the engine, so it cannot be shown.'
      : this.ghost === buildId
        ? 'Take it out of the viewport'
        : 'Draw the model with this change over the model on screen, translucent';
  }
}

/** Why the file with the change does not build: said first, with every reason listed. */
function problems(after: ChangePreviewSide, before: ChangePreviewSide | null): HTMLElement {
  const block = document.createElement('div');
  block.className = 'chat-change-problems';
  block.dataset.ref = 'preview-problems';
  block.setAttribute('role', 'alert');
  const heading = document.createElement('div');
  heading.className = 'chat-change-problems-title';
  heading.append(ChatIcons.span(ChatIcons.ERROR, '[&>svg]:size-3.5 mt-px'), text('This change does not build'));
  block.append(heading);
  const list = document.createElement('ul');
  for (const problem of after.problems ?? []) {
    const item = document.createElement('li');
    item.dataset.ref = 'preview-problem';
    const title = document.createElement('span');
    title.className = 'font-medium';
    title.textContent = problem.message ? `${problem.title}: ` : problem.title;
    item.append(title, text(problem.message));
    if (problem.line !== undefined) {
      const where = document.createElement('span');
      where.className = 'chat-change-problem-line';
      // The line is of the file with the change, which is not written: nothing to open.
      where.textContent = `line ${problem.line}`;
      item.append(where);
    }
    list.append(item);
  }
  if (after.moreProblems) {
    const more = document.createElement('li');
    more.className = 'chat-change-problems-more';
    more.textContent = `and ${after.moreProblems} more`;
    list.append(more);
  }
  block.append(list);
  if (before?.state === 'failed') {
    const also = document.createElement('div');
    also.className = 'chat-change-problems-also';
    also.dataset.ref = 'preview-before-failed';
    also.textContent = 'The file as it is does not build either.';
    block.append(also);
  }
  return block;
}

function note(icon: string, words: string, kind: string): HTMLElement {
  const line = document.createElement('div');
  line.className = 'chat-change-note';
  line.dataset.ref = `preview-${kind}`;
  line.dataset.kind = kind;
  line.dataset.icon = icon === ChatIcons.CHECK ? 'check' : 'plain';
  line.append(ChatIcons.span(icon, '[&>svg]:size-3.5 mt-px'), text(words));
  return line;
}

/** One side's facts, on one quiet line. */
function lines(facts: string[]): HTMLElement {
  const line = document.createElement('div');
  line.className = 'chat-change-lines';
  line.dataset.ref = 'preview-facts';
  line.textContent = facts.join(' · ');
  return line;
}

/** The facts' rows while the engine builds: their labels, and nothing to say yet. */
function pendingFacts(): HTMLElement {
  const table = document.createElement('div');
  table.className = 'chat-change-facts';
  table.dataset.ref = 'preview-facts-pending';
  table.setAttribute('aria-hidden', 'true');
  for (const label of ['Bodies', 'Size', 'Volume']) {
    const row = document.createElement('div');
    row.className = 'chat-change-fact';
    row.dataset.tone = 'same';
    row.append(cell('chat-change-fact-label', label), cell('chat-change-fact-values chat-change-fact-pending', '…'), cell('chat-change-fact-change', ''));
    table.append(row);
  }
  return table;
}

function progress(): HTMLElement {
  const line = document.createElement('div');
  line.className = 'chat-variants-progress chat-change-progress';
  line.dataset.ref = 'preview-progress';
  const spinner = document.createElement('span');
  spinner.className = 'loading loading-spinner loading-xs';
  line.append(spinner, text('Building a preview of this change. The app waits while it builds; you can answer now.'));
  return line;
}

/** What a side shows in place of a picture. */
function placeholder(shows: 'queued' | 'building' | 'built' | 'drawing' | 'nothing'): HTMLElement {
  const holder = document.createElement('span');
  holder.className = 'chat-variant-placeholder';
  holder.dataset.ref = 'preview-placeholder';
  switch (shows) {
    case 'queued':
      holder.append(ChatIcons.span(ChatIcons.WAITING, '[&>svg]:size-4'), text('Queued'));
      return holder;
    case 'built':
      holder.append(ChatIcons.span(ChatIcons.CHECK, '[&>svg]:size-4'), text('Built'));
      return holder;
    case 'nothing':
      holder.append(ChatIcons.span(ChatIcons.NO_PICTURE, '[&>svg]:size-5'), text('No picture'));
      return holder;
    default: {
      const spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-sm';
      holder.append(spinner, text(shows === 'building' ? 'Building…' : 'Drawing…'));
      return holder;
    }
  }
}

function cell(className: string, words: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.setAttribute('role', 'cell');
  el.textContent = words;
  return el;
}

/** A build time as the card says it: `850 ms`, `6.2 s`, `1 min 20 s`. */
export function duration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(seconds)} s`;
  }
  const whole = Math.round(seconds);
  return whole % 60 === 0 ? `${whole / 60} min` : `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

function text(value: string): Text {
  return document.createTextNode(value);
}
