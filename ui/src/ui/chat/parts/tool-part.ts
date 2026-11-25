import { ChatIcons } from '../chat-icons';
import type { ApprovalDecision, ChatPart, InstallSummary, InstallTarget, ToolPart } from '../chat-types';
import { ChangePreviewView } from './change-preview';
import type { PartContext, PartView } from './part-view';

/** The longest input summary shown on the card's line. */
const SUMMARY_CHARS = 90;
/** The longest output shown in the card's details (the transcript keeps up to 20 000 characters). */
const OUTPUT_CHARS = 8000;

/** Input fields worth naming on the card's one line, in order of preference. */
const SUMMARY_KEYS = [
  'query', 'pattern', 'selector', 'name', 'id', 'shapeId', 'faceId', 'edgeId', 'file_path', 'path', 'glob', 'expression', 'url',
];

/**
 * One line about a tool call's input: the field that says most about it
 * (a query, a pattern, a path, a name), else the first short values. The
 * title already names the tool and often the file.
 */
export function summarizeToolInput(input: unknown, title = ''): string {
  if (input === null || input === undefined) {
    return '';
  }
  if (typeof input !== 'object') {
    return clip(String(input));
  }
  const record = input as Record<string, unknown>;
  const pieces: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      // A value the title already says (the file of a read, by its path) is noise.
      const tail = value.trim().split(/[\\/]/).pop() ?? '';
      if (tail !== '' && title.includes(tail)) {
        return '';
      }
      pieces.push(value.trim());
      break;
    }
  }
  if (pieces.length === 0) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        pieces.push(`${key}: ${String(value)}`);
      }
      if (pieces.length >= 2) {
        break;
      }
    }
  }
  return clip(pieces.join(' · ').replace(/\s+/g, ' '));
}

function clip(text: string): string {
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
}

/** A render's outcome, as a write or recompute tool reports it (mcp `RenderOutcome`). */
export type RenderOutcomeView =
  | { state: 'rendered' }
  | { state: 'build-error'; errors: { name: string; message: string; location?: SourceLocation }[] }
  | { state: 'compile-error'; message: string; location?: SourceLocation }
  | { state: 'render-failed'; message: string };

type SourceLocation = { filePath: string; line: number; column: number };

/** The render outcome in a tool's output text (JSON with a `render` field, or the outcome itself), or null. */
export function readRenderOutcome(text: string | undefined): RenderOutcomeView | null {
  if (!text || !text.trimStart().startsWith('{')) {
    return null;
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const outcome = json && typeof json.render === 'object' && json.render ? json.render : json;
  switch (outcome?.state) {
    case 'rendered':
      return { state: 'rendered' };
    case 'build-error': {
      const errors = Array.isArray(outcome.objectErrors) ? outcome.objectErrors : [];
      return {
        state: 'build-error',
        errors: errors.map((e: any) => ({
          name: String(e?.name ?? 'A feature'),
          message: String(e?.message ?? ''),
          ...(isLocation(e?.sourceLocation) ? { location: e.sourceLocation } : {}),
        })),
      };
    }
    case 'compile-error': {
      const error = outcome.compileError ?? {};
      return {
        state: 'compile-error',
        message: String(error.message ?? 'The code does not compile.'),
        ...(isLocation(error.sourceLocation) ? { location: error.sourceLocation } : {}),
      };
    }
    case 'render-failed':
      return { state: 'render-failed', message: String(outcome.error ?? 'The render failed.') };
    default:
      return null;
  }
}

function isLocation(value: any): value is SourceLocation {
  return !!value && typeof value.filePath === 'string' && typeof value.line === 'number';
}

const STATE_TEXT: Record<ToolPart['state'], string> = {
  running: 'Running',
  'awaiting-approval': 'Waiting for approval',
  done: 'Done',
  error: 'Failed',
  denied: 'Not run',
};

/**
 * A tool call as a card (docs/agent-chat-plan.md §10.3): its status, title
 * and a line about its input; under it whatever the call produced that the
 * user should see at once (a render's outcome with links to the line, the
 * images it returned, the error); and, on a click, the raw input and
 * output.
 *
 * **Approval (§12.1).** While the call waits (`awaiting-approval`), the
 * `approval` slot (`data-ref="approval"`) shows the change it would make
 * (the unified diff of `write_file` / `edit_range`) and Allow, Allow for
 * this session (when the call offers it) and Deny. The state comes from the
 * part, so a reloaded page or a second tab shows the same buttons; the
 * first answer wins and the others are refused by the engine. Once
 * answered, an allowed call keeps one quiet line saying so; a declined,
 * stopped or timed-out one says why on its error line.
 *
 * **What the change does to the model (§25).** A change to a model file that
 * waits also shows its before and after ({@link ChangePreviewView}), above
 * the diff: it fills in while the buttons already work. Once answered it is
 * kept with the card's details.
 *
 * **Package installs.** An `install_package` call waiting shows a
 * confirmation card instead ({@link installSummaryView}): the package, its
 * version, publisher, license, installs and what it exports as the hub
 * describes them (filled in while the buttons already work), an upgrade or a
 * deprecation; then Install, Always (when offered: installs run without
 * asking from then on, until Settings → Agent turns it off) and Deny. Where
 * it goes is chosen as in the Hub panel: Install is a split button whose
 * menu holds My library and This project, the choice shows beside it, and
 * the answer carries it (a choice also becomes the Hub panel's for the
 * project). An install that ran without asking because of Always says so.
 *
 * **Dirty buffer (§12.2).** A write refused because the file has unsaved
 * changes in the editor (`errorCode: 'dirty-buffer'`) shows as a card naming
 * the file, with Show in editor when the page has one.
 */
export class ToolPartView implements PartView {
  readonly el: HTMLDivElement;
  private readonly header: HTMLButtonElement;
  private readonly statusIcon: HTMLSpanElement;
  private readonly title: HTMLSpanElement;
  private readonly summary: HTMLSpanElement;
  private readonly chevron: HTMLSpanElement;
  /** The change to approve and the buttons, while the call waits; the answer once given. */
  readonly approval: HTMLDivElement;
  private readonly dirty: HTMLDivElement;
  private readonly outcome: HTMLDivElement;
  private readonly images: HTMLDivElement;
  private readonly errorLine: HTMLDivElement;
  private readonly details: HTMLDivElement;
  private expanded = false;
  private part: ToolPart;
  /** The answer this card sent and the engine has not settled yet (its buttons wait). */
  private deciding: ApprovalDecision | null = null;
  /** The before and after of the change, when the call has one (§25). */
  private readonly preview: ChangePreviewView;
  /** Where the user chose to install on this card before answering; null: where the card says it goes. */
  private target: InstallTarget | null = null;
  /** Whether the Install button's place menu is open. */
  private menuOpen = false;

  constructor(part: ToolPart, private readonly ctx: PartContext) {
    this.part = part;
    this.el = document.createElement('div');
    this.el.className = 'chat-tool';
    this.el.dataset.part = 'tool';

    this.header = document.createElement('button');
    this.header.type = 'button';
    this.header.dataset.ref = 'toggle';
    this.header.className = 'chat-tool-header';
    this.statusIcon = document.createElement('span');
    this.statusIcon.className = 'chat-tool-status';
    this.title = document.createElement('span');
    this.title.className = 'chat-tool-title';
    this.title.dataset.ref = 'title';
    this.summary = document.createElement('span');
    this.summary.className = 'chat-tool-summary';
    this.summary.dataset.ref = 'summary';
    this.chevron = ChatIcons.span(ChatIcons.CHEVRON_RIGHT, '[&>svg]:size-3 chat-chevron ml-auto');
    this.header.append(this.statusIcon, this.title, this.summary, this.chevron);
    this.header.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.paint();
    });

    this.approval = div('chat-tool-approval', 'approval');
    this.dirty = div('chat-tool-dirty', 'dirty-buffer');
    this.outcome = div('chat-tool-outcome', 'outcome');
    this.images = div('chat-tool-images', 'images');
    this.errorLine = div('chat-tool-error', 'error');
    this.details = div('chat-tool-details', 'details');
    this.preview = new ChangePreviewView(part, ctx);
    this.el.append(this.header, this.approval, this.dirty, this.outcome, this.images, this.errorLine, this.details);
    this.paint();
  }

  update(part: ChatPart): void {
    if (part.type === 'tool') {
      this.part = part;
      this.preview.update(part);
      this.paint();
    }
  }

  dispose(): void {
    this.closeMenu();
    this.preview.dispose();
  }

  /** Takes what this card drew in the viewport (the change, shown over the model) back out. */
  hideGhost(): void {
    this.preview.hideGhost();
  }

  private paint(): void {
    const part = this.part;
    this.el.dataset.state = part.state;
    this.el.dataset.kind = part.kind;
    this.el.dataset.name = part.name;

    this.statusIcon.replaceChildren(statusIcon(part.state));
    this.statusIcon.title = STATE_TEXT[part.state];
    this.title.textContent = part.title || part.name;
    this.summary.textContent = summarizeToolInput(part.input, this.title.textContent);
    this.chevron.classList.toggle('rotate-90', this.expanded);
    this.header.setAttribute('aria-expanded', String(this.expanded));

    this.paintApproval();
    const dirty = part.state === 'error' && part.errorCode === 'dirty-buffer';
    this.el.dataset.errorCode = dirty ? 'dirty-buffer' : '';
    this.paintDirty(dirty);

    this.paintOutcome(readRenderOutcome(part.output?.text));
    this.paintImages(part.output?.images ?? []);

    const showError = (part.state === 'error' || part.state === 'denied') && !!part.error && !dirty;
    this.errorLine.textContent = showError ? firstLine(readableError(part.error!)) : '';
    this.errorLine.classList.toggle('hidden', !showError);

    this.details.classList.toggle('hidden', !this.expanded);
    if (this.expanded) {
      this.paintDetails();
    } else {
      this.details.replaceChildren();
    }
  }

  /** Waiting: the change and the three answers. Answered and allowed: one quiet line. */
  private paintApproval(): void {
    const part = this.part;
    const approval = part.approval;
    const waiting = part.state === 'awaiting-approval';
    if (!waiting) {
      this.deciding = null;
      this.target = null;
      this.closeMenu();
    }
    this.approval.replaceChildren();
    const allowed = approval?.decision === 'allow' || approval?.decision === 'allow-session' || approval?.decision === 'allow-always';
    this.approval.classList.toggle('hidden', !waiting && !allowed);
    this.approval.dataset.mode = waiting ? 'waiting' : 'answered';
    if (!waiting) {
      if (allowed) {
        this.approval.append(ChatIcons.span(ChatIcons.CHECK, '[&>svg]:size-3.5'), text(allowedLine(approval!)));
        if (approval!.decision === 'allow-always' && this.ctx.openAgentSettings) {
          const change = document.createElement('button');
          change.type = 'button';
          change.dataset.ref = 'always-settings';
          change.className = 'link link-hover chat-approval-link';
          change.textContent = 'Change';
          change.title = 'Settings → Agent: ask before installing packages again';
          change.addEventListener('click', () => this.ctx.openAgentSettings?.());
          this.approval.append(change);
        }
      }
      return;
    }
    const installing = part.name === 'install_package';
    const target = this.chosenTarget();
    if (installing) {
      const install = part.install ?? installFromInput(part.input);
      // With a choice, where it goes is the split button's: the card does not say it twice.
      this.approval.append(installSummaryView(target ? { ...install, target } : install, { placeShown: target !== null }));
    }
    // The shape first, then the patch: what the change does to the model, when the engine can say.
    if (this.preview.shown) {
      this.approval.append(this.preview.el);
    }
    if (part.diff) {
      this.approval.append(diffView(part.diff));
    }
    const row = document.createElement('div');
    row.className = 'chat-approval-row';
    const question = document.createElement('span');
    question.className = 'chat-approval-question';
    question.dataset.ref = 'approval-question';
    question.append(ChatIcons.span(ChatIcons.WAITING, '[&>svg]:size-3.5'), text(approvalQuestion(part)));
    row.append(question);
    if (installing && approval && this.ctx.decideApproval) {
      this.approval.append(row, this.installActions(approval, target));
      return;
    }
    if (approval && this.ctx.decideApproval) {
      const buttons = document.createElement('div');
      buttons.className = 'chat-approval-buttons';
      buttons.append(this.decisionButton('allow', 'Allow', 'btn-primary'));
      if (approval.canAllowSession) {
        buttons.append(this.decisionButton('allow-session', 'Allow for this session', 'btn-ghost chat-approval-secondary'));
      }
      buttons.append(this.decisionButton('deny', 'Deny', 'btn-ghost chat-approval-secondary'));
      row.append(buttons);
    }
    this.approval.append(row);
  }

  /**
   * Where the install goes if the user answers now: their choice on this
   * card, else the card's place. Null when the card offers no choice (an
   * engine that cannot say where installs go).
   */
  private chosenTarget(): InstallTarget | null {
    const part = this.part;
    if (part.name !== 'install_package' || !part.approval?.canChooseTarget || !part.install?.target || !this.ctx.decideApproval) {
      return null;
    }
    return this.target ?? part.install.target;
  }

  /** An install's answers: Install (split, with the place menu, when there is a choice) and where it goes, then Always and Deny. */
  private installActions(approval: NonNullable<ToolPart['approval']>, target: InstallTarget | null): HTMLElement {
    const row = document.createElement('div');
    row.className = 'chat-approval-row chat-install-actions';
    const install = this.decisionButton('allow', 'Install', 'btn-primary');
    if (target) {
      const split = document.createElement('div');
      split.className = 'join chat-install-split';
      install.classList.add('join-item');
      const chevron = document.createElement('button');
      chevron.type = 'button';
      chevron.dataset.ref = 'target-menu';
      chevron.className = 'btn btn-xs btn-primary join-item chat-install-chevron';
      chevron.disabled = this.deciding !== null;
      chevron.setAttribute('aria-label', 'Install into…');
      chevron.setAttribute('aria-haspopup', 'true');
      chevron.setAttribute('aria-expanded', String(this.menuOpen));
      chevron.append(ChatIcons.span(ChatIcons.CHEVRON_DOWN, '[&>svg]:size-3'));
      chevron.addEventListener('click', () => this.toggleMenu());
      split.append(install, chevron);
      if (this.menuOpen) {
        split.append(this.targetMenu(target));
      }
      const where = document.createElement('span');
      where.className = 'chat-install-where';
      where.dataset.ref = 'install-target';
      where.textContent = target === 'project' ? 'into this project' : 'into my library';
      row.append(split, where);
    } else {
      row.append(install);
    }
    const buttons = document.createElement('div');
    buttons.className = 'chat-approval-buttons';
    if (approval.canAllowAlways) {
      const always = this.decisionButton('allow-always', 'Always', 'btn-ghost chat-approval-secondary');
      always.title = 'Install this, and let the agent install packages without asking from now on. Settings → Agent turns it off.';
      buttons.append(always);
    }
    buttons.append(this.decisionButton('deny', 'Deny', 'btn-ghost chat-approval-secondary'));
    row.append(buttons);
    return row;
  }

  /** The Install button's places, as the Hub panel's: My library and This project. */
  private targetMenu(current: InstallTarget): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'chat-install-menu';
    menu.dataset.ref = 'install-targets';
    menu.setAttribute('role', 'menu');
    const option = (value: InstallTarget, title: string, hint: string) => {
      const selected = value === current;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-install-option';
      button.dataset.target = value;
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(selected));
      button.append(ChatIcons.span(ChatIcons.CHECK, `[&>svg]:size-3.5 chat-install-option-check${selected ? '' : ' invisible'}`));
      const words = document.createElement('span');
      words.className = 'chat-install-option-text';
      const name = document.createElement('span');
      name.textContent = title;
      const sub = document.createElement('span');
      sub.className = 'chat-install-option-hint';
      sub.textContent = hint;
      words.append(name, sub);
      button.append(words);
      button.addEventListener('click', () => this.chooseTarget(value));
      return button;
    };
    menu.append(
      option('library', 'My library', 'Every project can use it; this project uses it.'),
      option('project', 'This project', 'A copy in its packages/ folder, committed with it.'),
    );
    return menu;
  }

  private chooseTarget(target: InstallTarget): void {
    const changed = target !== this.chosenTarget();
    this.target = target;
    this.closeMenu();
    this.paintApproval();
    if (changed) {
      this.ctx.onInstallTargetChosen?.(target);
    }
  }

  private toggleMenu(): void {
    if (this.menuOpen) {
      this.closeMenu();
    } else {
      this.menuOpen = true;
      document.addEventListener('pointerdown', this.onPointerDown, true);
      document.addEventListener('keydown', this.onKeyDown, true);
    }
    this.paintApproval();
  }

  private closeMenu(): void {
    if (!this.menuOpen) {
      return;
    }
    this.menuOpen = false;
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
  }

  /**
   * A press outside the split button closes the menu. The menu is taken out
   * in place, not by a repaint: a press on Always or Deny must still land on
   * the button it started on.
   */
  private readonly onPointerDown = (e: PointerEvent): void => {
    const split = this.approval.querySelector('.chat-install-split');
    if (split?.contains(e.target as Node)) {
      return;
    }
    this.dropMenu();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.dropMenu();
    }
  };

  private dropMenu(): void {
    this.closeMenu();
    this.approval.querySelector('[data-ref="install-targets"]')?.remove();
    this.approval.querySelector('[data-ref="target-menu"]')?.setAttribute('aria-expanded', 'false');
  }

  private decisionButton(decision: ApprovalDecision, label: string, variant: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.ref = decision;
    button.className = `btn btn-xs ${variant}`;
    button.disabled = this.deciding !== null;
    if (this.deciding === decision) {
      const spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-xs';
      button.append(spinner);
    }
    button.append(text(label));
    button.addEventListener('click', () => void this.decide(decision));
    return button;
  }

  private async decide(decision: ApprovalDecision): Promise<void> {
    const approval = this.part.approval;
    if (!approval || this.deciding !== null || !this.ctx.decideApproval || this.part.state !== 'awaiting-approval') {
      return;
    }
    const target = decision === 'deny' ? null : this.chosenTarget();
    this.deciding = decision;
    this.closeMenu();
    this.paintApproval();
    const ok = await (target ? this.ctx.decideApproval(approval.id, decision, target) : this.ctx.decideApproval(approval.id, decision));
    // Taken: the part's update settles the card. Refused while it still waits: answer again.
    if (!ok && this.part.state === 'awaiting-approval' && this.part.approval?.id === approval.id) {
      this.deciding = null;
      this.paintApproval();
    }
  }

  /** A write refused for unsaved changes: which file, and a way to it. */
  private paintDirty(show: boolean): void {
    this.dirty.replaceChildren();
    this.dirty.classList.toggle('hidden', !show);
    if (!show) {
      return;
    }
    const part = this.part;
    const file = dirtyFileName(part);
    const words = document.createElement('div');
    words.className = 'min-w-0 flex-1';
    const name = document.createElement('span');
    name.className = 'chat-tool-dirty-file';
    name.dataset.ref = 'dirty-file';
    name.textContent = file;
    words.append(name, text(' has unsaved changes in the editor, so the agent left it alone. Save it, then ask again.'));
    this.dirty.append(ChatIcons.span(ChatIcons.WARNING, '[&>svg]:size-3.5 mt-px'), words);
    const absPath = dirtyAbsPath(part);
    if (this.ctx.openSource && absPath) {
      const open = document.createElement('button');
      open.type = 'button';
      open.dataset.ref = 'open-file';
      open.className = 'btn btn-xs btn-ghost chat-approval-secondary shrink-0';
      open.textContent = 'Show in editor';
      open.title = `Open ${file} in the editor`;
      open.addEventListener('click', () => this.ctx.openSource?.(absPath, 1, 1));
      this.dirty.append(open);
    }
  }

  private paintOutcome(outcome: RenderOutcomeView | null): void {
    this.outcome.replaceChildren();
    this.outcome.classList.toggle('hidden', outcome === null);
    if (!outcome) {
      return;
    }
    this.outcome.dataset.outcome = outcome.state;
    switch (outcome.state) {
      case 'rendered':
        this.outcome.append(ChatIcons.span(ChatIcons.CHECK, '[&>svg]:size-3.5 text-success'), text('Rendered'));
        return;
      case 'compile-error':
        this.outcome.append(this.outcomeRow('Compile error', outcome.message, outcome.location));
        return;
      case 'render-failed':
        this.outcome.append(this.outcomeRow('Render failed', outcome.message));
        return;
      case 'build-error':
        if (outcome.errors.length === 0) {
          this.outcome.append(this.outcomeRow('Build error', 'A feature failed to build.'));
        }
        for (const error of outcome.errors) {
          this.outcome.append(this.outcomeRow(`${error.name} failed`, error.message, error.location));
        }
        return;
    }
  }

  private outcomeRow(label: string, message: string, location?: SourceLocation): HTMLElement {
    const row = document.createElement('div');
    row.className = 'chat-tool-outcome-row';
    row.append(ChatIcons.span(ChatIcons.ERROR, '[&>svg]:size-3.5 text-error'));
    const words = document.createElement('span');
    const strong = document.createElement('span');
    strong.className = 'font-medium';
    strong.textContent = `${label}: `;
    words.append(strong, text(message));
    row.append(words);
    if (location) {
      const name = location.filePath.split(/[\\/]/).pop() ?? location.filePath;
      const where = `${name}:${location.line}`;
      if (this.ctx.openSource) {
        const link = document.createElement('button');
        link.type = 'button';
        link.dataset.ref = 'source-link';
        link.className = 'link link-hover font-mono text-[11px] shrink-0';
        link.textContent = where;
        link.title = `Show ${location.filePath}, line ${location.line}`;
        link.addEventListener('click', () => this.ctx.openSource?.(location.filePath, location.line, location.column ?? 1));
        row.append(link);
      } else {
        const plain = document.createElement('span');
        plain.className = 'font-mono text-[11px] shrink-0 opacity-70';
        plain.textContent = where;
        row.append(plain);
      }
    }
    return row;
  }

  private paintImages(names: string[]): void {
    const current = [...this.images.querySelectorAll('img')].map((img) => img.dataset.file);
    if (current.length === names.length && current.every((n, i) => n === names[i])) {
      return;
    }
    this.images.replaceChildren();
    for (const name of names) {
      const img = document.createElement('img');
      img.dataset.file = name;
      img.src = this.ctx.fileUrl(name);
      img.alt = 'An image the tool returned';
      img.loading = 'lazy';
      img.addEventListener('click', () => img.classList.toggle('chat-tool-image-full'));
      this.images.append(img);
    }
    this.images.classList.toggle('hidden', names.length === 0);
  }

  private paintDetails(): void {
    const part = this.part;
    this.details.replaceChildren();
    const name = document.createElement('div');
    name.className = 'chat-tool-name';
    name.textContent = part.source === 'agent' ? `${part.name} (the agent's own tool)` : part.name;
    this.details.append(name);
    // While the call waits, the change shows above the buttons already. Once
    // answered, what it did to the model comes first: the input of a write
    // is the whole file.
    if (this.preview.shown && part.state !== 'awaiting-approval') {
      this.details.append(previewSection(this.preview.el));
    }
    // The package an install was about, as its card showed it.
    if (part.install && part.state !== 'awaiting-approval') {
      this.details.append(labelled('Package', installSummaryView(part.install)));
    }
    this.details.append(section('Input', formatInput(part.input)));
    if (part.diff && part.state !== 'awaiting-approval') {
      this.details.append(diffSection(part.diff));
    }
    if (part.output?.text) {
      this.details.append(section('Output', clipOutput(prettyJson(part.output.text))));
    }
    if (part.error) {
      this.details.append(section(part.state === 'denied' ? 'Not run' : 'Error', part.error));
    }
  }
}

function statusIcon(state: ToolPart['state']): HTMLElement {
  switch (state) {
    case 'running': {
      const spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-xs text-base-content/50';
      return spinner;
    }
    case 'awaiting-approval':
      return ChatIcons.span(ChatIcons.WAITING, '[&>svg]:size-3.5 text-warning');
    case 'done':
      return ChatIcons.span(ChatIcons.CHECK, '[&>svg]:size-3.5 text-success');
    case 'error':
      return ChatIcons.span(ChatIcons.ERROR, '[&>svg]:size-3.5 text-error');
    case 'denied':
      return ChatIcons.span(ChatIcons.DENIED, '[&>svg]:size-3.5 text-base-content/50');
  }
}

function div(className: string, ref: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `${className} hidden`;
  el.dataset.ref = ref;
  return el;
}

function text(value: string): Text {
  return document.createTextNode(value);
}

/** A tool's own refusal is JSON (`{ code, message, details }`): its message is what to read. */
export function readableError(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) {
    return value;
  }
  try {
    const json = JSON.parse(trimmed);
    return typeof json?.message === 'string' && json.message.trim() !== '' ? json.message : value;
  } catch {
    // Cut short (the transcript keeps 20 000 characters): pull the message out by hand.
    const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(trimmed);
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        return value;
      }
    }
    return value;
  }
}

function firstLine(value: string): string {
  const line = value.trim().split('\n')[0] ?? '';
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

function formatInput(input: unknown): string {
  if (input === undefined) {
    return '';
  }
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

/** JSON output indented for reading; anything else as it is. */
function prettyJson(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('[')) || trimmed.length > 200_000) {
    return value;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function clipOutput(value: string): string {
  return value.length > OUTPUT_CHARS ? `${value.slice(0, OUTPUT_CHARS)}\n… (${value.length - OUTPUT_CHARS} more characters)` : value;
}

function section(label: string, body: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-tool-section';
  const heading = document.createElement('div');
  heading.className = 'chat-tool-section-label';
  heading.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = body;
  wrap.append(heading, pre);
  return wrap;
}

/** The quiet line of an allowed call. */
function allowedLine(approval: NonNullable<ToolPart['approval']>): string {
  switch (approval.decision) {
    case 'allow-session':
      return 'You allowed this for the session';
    case 'allow-always':
      return approval.standing ? 'Installed without asking: you chose Always for package installs' : 'You allowed package installs always';
    default:
      return 'You allowed this';
  }
}

/** What the approval asks, by what the call does. */
function approvalQuestion(part: ToolPart): string {
  if (part.name === 'install_package') {
    // The one thing to know before saying yes (the packages docs say the same of every install).
    return 'A package\'s code runs in FluidCAD with your permissions. Install it?';
  }
  switch (part.kind) {
    case 'edit':
      return part.diff ? 'Apply this change?' : 'Allow this change?';
    case 'outside':
      return 'This reaches outside the project. Allow it?';
    default:
      return 'Allow this action?';
  }
}

/** The file a dirty-buffer refusal names (workspace-relative), from the card's error, else its title. */
export function dirtyFileName(part: ToolPart): string {
  const match = /^Not written: (.+?) has unsaved changes/.exec(part.error ?? '');
  if (match) {
    return match[1];
  }
  const input = part.input as { path?: unknown } | null;
  return typeof input?.path === 'string' ? input.path : part.title;
}

/** The absolute path of the refused file, from the tool's own refusal (its `details`, else its message). */
export function dirtyAbsPath(part: ToolPart): string | null {
  const raw = part.output?.text;
  if (raw && raw.trimStart().startsWith('{')) {
    try {
      const json = JSON.parse(raw);
      const files = json?.details?.dirtyFiles;
      if (Array.isArray(files)) {
        const rel = dirtyFileName(part).replace(/\\/g, '/');
        const hit = files.find((f: unknown) => typeof f === 'string' && f.replace(/\\/g, '/').endsWith(rel)) ?? files[0];
        if (typeof hit === 'string') {
          return hit;
        }
      }
      const quoted = typeof json?.message === 'string' ? /"([^"]+)"/.exec(json.message) : null;
      if (quoted) {
        return quoted[1];
      }
    } catch {
      // Not the tool's JSON.
    }
  }
  const input = part.input as { path?: unknown } | null;
  return typeof input?.path === 'string' && /^([A-Za-z]:)?[\\/]/.test(input.path) ? input.path : null;
}

/** An install's summary from the call's own input: what a card from an older engine (no `install`) still knows. */
function installFromInput(input: unknown): InstallSummary {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    state: 'unavailable',
    name: typeof i.name === 'string' ? i.name : '',
    version: typeof i.version === 'string' && i.version !== '' ? i.version : null,
    target: i.target === 'library' || i.target === 'project' ? i.target : null,
    upgrade: i.upgrade === true,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** Where the install puts the package, in the user's words. */
function installTarget(target: InstallSummary['target']): string {
  switch (target) {
    case 'project':
      return 'Copied into this project’s packages/ folder';
    case 'library':
      return 'Goes to your package library';
    default:
      return 'Goes where Settings → Packages puts new packages';
  }
}

/**
 * The package an install waits on (§ install cards): its name and version,
 * who publishes it, its license and installs, its description and what it
 * exports, where it goes, and a note for an upgrade, a copy already here, a
 * deprecation or a hub that could not say. The hub's text is the
 * publisher's: it is set as text only. `placeShown`: the card's buttons
 * say where it goes (the place menu), so the facts leave it out.
 */
export function installSummaryView(install: InstallSummary, options: { placeShown?: boolean } = {}): HTMLElement {
  const card = document.createElement('div');
  card.className = 'chat-install';
  card.dataset.ref = 'install';
  card.dataset.state = install.state;

  const head = document.createElement('div');
  head.className = 'chat-install-head';
  head.append(ChatIcons.span(ChatIcons.PACKAGE, '[&>svg]:size-4 chat-install-icon'));
  const titles = document.createElement('div');
  titles.className = 'min-w-0 flex-1';
  const nameRow = document.createElement('div');
  nameRow.className = 'chat-install-name-row';
  const name = document.createElement('span');
  name.className = 'chat-install-name';
  name.dataset.ref = 'install-name';
  name.textContent = install.name || 'A package';
  const version = document.createElement('span');
  version.className = 'chat-install-version';
  version.dataset.ref = 'install-version';
  version.textContent = install.version ?? (install.state === 'loading' ? '' : 'latest');
  nameRow.append(name);
  if (version.textContent) {
    nameRow.append(version);
  }
  titles.append(nameRow);
  const meta = [
    install.publisher ? `by ${install.publisher}` : null,
    install.license ?? null,
    typeof install.installs === 'number' ? plural(install.installs, 'install', 'installs') : null,
  ].filter((piece): piece is string => !!piece);
  if (meta.length > 0) {
    const metaLine = document.createElement('div');
    metaLine.className = 'chat-install-meta';
    metaLine.dataset.ref = 'install-meta';
    metaLine.textContent = meta.join(' · ');
    titles.append(metaLine);
  }
  head.append(titles);
  card.append(head);

  if (install.description) {
    const description = document.createElement('p');
    description.className = 'chat-install-description';
    description.dataset.ref = 'install-description';
    description.textContent = install.description;
    card.append(description);
  }

  const facts: string[] = [];
  if (install.contents) {
    const { features, parts, assemblies } = install.contents;
    const exports = [
      features > 0 ? plural(features, 'feature', 'features') : null,
      parts > 0 ? plural(parts, 'part', 'parts') : null,
      assemblies > 0 ? plural(assemblies, 'assembly', 'assemblies') : null,
    ].filter((piece): piece is string => !!piece);
    if (exports.length > 0) {
      facts.push(exports.join(', '));
    }
  }
  if (!options.placeShown) {
    facts.push(installTarget(install.target));
  }
  if (facts.length > 0) {
    const factLine = document.createElement('div');
    factLine.className = 'chat-install-facts';
    factLine.dataset.ref = 'install-facts';
    factLine.textContent = facts.join(' · ');
    card.append(factLine);
  }

  const note = (ref: string, icon: string, words: string, tone = '') => {
    const row = document.createElement('div');
    row.className = `chat-install-note ${tone}`.trim();
    row.dataset.ref = ref;
    row.append(ChatIcons.span(icon, '[&>svg]:size-3.5 mt-px'), text(words));
    card.append(row);
  };
  if (install.upgrade) {
    note('install-upgrade', ChatIcons.INFO, install.pinned ? `Moves this project up from ${install.pinned}` : 'Moves this project to a newer version');
  }
  if (install.version && install.installed?.includes(install.version)) {
    note('install-local', ChatIcons.INFO, 'Already on this machine: nothing to download');
  }
  if (install.deprecated) {
    note('install-deprecated', ChatIcons.WARNING, `Deprecated: ${install.deprecated}`, 'chat-install-warning');
  }
  if (install.state === 'loading') {
    const loading = document.createElement('div');
    loading.className = 'chat-install-loading';
    loading.dataset.ref = 'install-loading';
    const spinner = document.createElement('span');
    spinner.className = 'loading loading-spinner loading-xs';
    loading.append(spinner, text('Reading the package on the hub…'));
    card.append(loading);
  } else if (install.state === 'unavailable' && install.problem) {
    note('install-problem', ChatIcons.INFO, `The hub could not describe it: ${firstLine(readableError(install.problem))}`);
  }
  return card;
}

/** A labelled section of the details holding an element. */
function labelled(label: string, body: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-tool-section';
  const heading = document.createElement('div');
  heading.className = 'chat-tool-section-label';
  heading.textContent = label;
  wrap.append(heading, body);
  return wrap;
}

/** What the change did to the model, in the details, under its label. */
function previewSection(preview: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-tool-section';
  const heading = document.createElement('div');
  heading.className = 'chat-tool-section-label';
  heading.textContent = 'Before and after';
  wrap.append(heading, preview);
  return wrap;
}

/** A unified diff in the details, under its label. */
function diffSection(diff: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-tool-section';
  const heading = document.createElement('div');
  heading.className = 'chat-tool-section-label';
  heading.textContent = 'Change';
  wrap.append(heading, diffView(diff));
  return wrap;
}

/**
 * A unified diff, one row per line: added and removed lines tinted (DaisyUI
 * success and error), hunk headers and the file header quiet. Long diffs
 * scroll inside it.
 */
export function diffView(diff: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'chat-diff';
  pre.dataset.ref = 'diff';
  const lines = diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n');
  // The `---` / `+++` file header comes before the first hunk only: later, a
  // line starting so is a removed `--…` or an added `++…` line.
  let inHunk = false;
  for (const line of lines) {
    const row = document.createElement('span');
    row.className = 'chat-diff-line';
    if (line.startsWith('@@')) {
      inHunk = true;
    }
    if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) {
      row.classList.add('chat-diff-file');
    } else if (line.startsWith('+')) {
      row.classList.add('chat-diff-add');
    } else if (line.startsWith('-')) {
      row.classList.add('chat-diff-del');
    } else if (line.startsWith('@@')) {
      row.classList.add('chat-diff-hunk');
    } else if (line.startsWith('\\')) {
      row.classList.add('chat-diff-note');
    }
    // Block rows carry the line breaks; the text keeps them for copying.
    row.textContent = `${line}\n`;
    pre.append(row);
  }
  return pre;
}
