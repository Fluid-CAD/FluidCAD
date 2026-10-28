import type { HubAppPublishState, HubPublishDocGap, HubPublishStatus, HubPublishSummary, HubPublishWarning, HubVersionStatus } from '../../api';
import { ICON_ALERT_TRIANGLE, ICON_CHEVRON_RIGHT, ICON_CIRCLE_CHECK, ICON_CLOSE } from '../icons';
import { HubIcons } from '../hub/hub-icons';
import { PublishState, PublishText, type PublishSnapshot } from './publish-state';

export type PublishDialogDeps = {
  state: PublishState;
  /**
   * Sign in through the Hub panel's own flow (`HubAccount`): the dialog
   * hides while the panel runs it, and comes back, reading the status
   * again, once the sign-in ends signed in (false: it stays closed; the
   * panel says why).
   */
  signIn(): Promise<boolean>;
  /** Open a web page in the user's browser, through the host (the wizard, the status page, Manage). */
  openExternal(url: string): void;
  /** The block's version changed (a bump wrote `fluidcad.json`): the packages overview follows. */
  onVersionChanged?(): void;
};

/** Release notes are at most this long (the hub's `releaseNotesChars`). */
export const RELEASE_NOTES_CHARS = 280;

const LINE = 'text-xs text-base-content/80 leading-snug';
const MUTED = 'text-[11px] text-base-content/55 leading-snug';
const LINK_BTN = 'btn btn-ghost btn-xs font-normal text-primary px-1.5';
const SMALL_BTN = 'btn btn-ghost btn-xs font-normal';
const CARD = 'rounded-md border border-base-content/10 bg-base-200/40 px-3 py-2.5 flex flex-col gap-1.5';
/** A status row: the sentence on the left, its buttons grouped on the right (wrapping as a group, never one by one). */
const ROW = 'flex items-center gap-x-3 gap-y-1 flex-wrap';
const ROW_ACTIONS = 'flex items-center gap-0.5 shrink-0 ml-auto -my-1';

/**
 * Publishing the workspace's package from the top bar (ui-packages-plan
 * N4, U6–U10): `fluidcad publish` as a dialog, over {@link PublishState}'s
 * routes, step for step and sentence for sentence with the CLI's
 * `PublishView`:
 *
 * 1. **The block** (U7): a `package` block the engine can't read shows its
 *    problem and nothing else; the button was Publish all the same.
 * 2. **Signed out**: the hub's refusal, with Sign in — the Hub panel's own
 *    flow; the dialog comes back signed in and reads the status again.
 * 3. **The header**: the name and version, with the **Publish as** field,
 *    proposing the next major above the hub's latest (the author types over
 *    it); Check and Publish write it into the block first; **the status line**: where the package stands on the hub
 *    (`fluidcad publish --status`): nothing for a package not there yet, a draft with Open the
 *    wizard and Withdraw, in review with its page and Withdraw, rejected
 *    with the note (Publish again), the latest published version with
 *    Manage on the hub.
 * 4. **Release notes** (at most {@link RELEASE_NOTES_CHARS}), shown once a
 *    version was published — the next one goes to review; the hub takes the
 *    CHANGELOG section when they are left empty. Collected before Publish,
 *    since the engine checks their length before it packs.
 * 5. **Check** (a dry run: the hub checks everything and stores nothing) or
 *    **Publish**: the engine's preflight refuses at once (the sentence with
 *    its action: Sign in, a version above the hub's highest,
 *    Withdraw, "Save your files first"), or packs; the **summary** (the
 *    hub, the contents, the files and size, the integrity, what happens
 *    next, and the warnings, a row per file) waits for **Upload** or **Cancel**; then the progress, then the
 *    result: a first version opens the hub's wizard in the browser, once,
 *    and shows its link (U9); a later one was submitted for review, with
 *    its status page. The status line is read again, so what the dialog
 *    shows on reopening is the hub's own state.
 *
 * Closing the dialog never cancels anything: a session waiting to be
 * confirmed waits on in the engine (ten minutes), and reopening picks it
 * up; an upload under way finishes.
 */
export class PublishDialog {
  private readonly overlay: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly problem: HTMLDivElement;
  private readonly versionRow: HTMLDivElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly versionEl: HTMLSpanElement;
  private readonly versionInput: HTMLInputElement;
  private readonly hubStatus: HTMLDivElement;
  private readonly withdrawBox: HTMLDivElement;
  private readonly notes: HTMLDivElement;
  private readonly notesField: HTMLTextAreaElement;
  private readonly notesCount: HTMLSpanElement;
  private readonly notesHint: HTMLParagraphElement;
  private readonly session: HTMLDivElement;
  private readonly notice: HTMLDivElement;
  private readonly footerNote: HTMLSpanElement;
  private readonly checkBtn: HTMLButtonElement;
  private readonly signInBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly bumpControl: HTMLDivElement;
  private readonly publishBtn: HTMLButtonElement;
  private readonly uploadBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly retryBtn: HTMLButtonElement;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeEnded: () => void;
  /** The version a Withdraw asks about; null when none is being asked. */
  private confirmingWithdraw: Pick<HubVersionStatus, 'version' | 'status'> | null = null;
  /** The session whose wizard this page opened, so a draft's wizard opens once. */
  private openedWizardFor: string | null = null;
  /** The author typed in the version field: the proposal stops overwriting it (reset on open). */
  private versionTouched = false;
  /** What the session area was last drawn from (see {@link renderSession}). */
  private sessionKey: string | null = null;
  private destroyed = false;

  constructor(container: HTMLElement, private readonly deps: PublishDialogDeps) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[1100] bg-black/50 flex items-center justify-center hidden';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Publish this package');
    this.overlay.dataset.role = 'publish';
    this.overlay.innerHTML = `
      <div data-ref="box" class="w-[560px] max-w-[92vw] max-h-[86vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-3 shrink-0">
          <h3 data-ref="title" class="text-sm font-medium text-base-content/90 truncate">Publish</h3>
          <button data-ref="close" class="btn btn-ghost btn-square btn-xs text-base-content/60" title="Close" aria-label="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <div data-ref="body" class="overflow-y-auto min-h-0 flex flex-col gap-3">
          <div data-ref="problem" class="hidden"></div>
          <div data-ref="version-row" class="hidden flex items-center justify-between gap-x-4 gap-y-2 flex-wrap">
            <div class="flex items-baseline gap-2 min-w-0">
              <span data-ref="name" class="text-sm font-medium text-base-content/90 truncate"></span>
              <span data-ref="version" class="text-xs text-base-content/60 font-mono tabular-nums"></span>
            </div>
            <div data-ref="bump" class="flex items-center gap-2 shrink-0">
              <label class="${MUTED}" for="fluidcad-publish-version">Publish as</label>
              <input id="fluidcad-publish-version" data-ref="version-input" class="input input-xs input-bordered w-[5.5rem] font-mono" spellcheck="false">
            </div>
          </div>
          <div data-ref="hub-status" class="hidden flex flex-col gap-1"></div>
          <div data-ref="withdraw-box" class="hidden"></div>
          <div data-ref="notes" class="hidden flex flex-col gap-1">
            <label class="flex items-baseline justify-between text-xs text-base-content/80" for="fluidcad-publish-notes">
              <span>Release notes</span>
              <span data-ref="notes-count" class="${MUTED} tabular-nums"></span>
            </label>
            <textarea id="fluidcad-publish-notes" data-ref="notes-field" class="textarea textarea-sm textarea-bordered w-full text-xs leading-snug" rows="3" maxlength="${RELEASE_NOTES_CHARS}" placeholder="What changed in this version"></textarea>
            <p data-ref="notes-hint" class="${MUTED}"></p>
          </div>
          <div data-ref="session" class="hidden flex flex-col gap-2"></div>
          <div data-ref="notice" class="hidden text-xs leading-snug"></div>
        </div>
        <div data-ref="footer" class="flex items-center justify-end gap-2 pt-4 shrink-0">
          <span data-ref="footer-note" class="${MUTED} mr-auto hidden"></span>
          <button data-ref="done" type="button" class="btn btn-ghost btn-sm">Close</button>
          <button data-ref="cancel" type="button" class="btn btn-ghost btn-sm hidden">Cancel</button>
          <button data-ref="retry" type="button" class="btn btn-sm hidden">Try again</button>
          <button data-ref="check" type="button" class="btn btn-sm hidden" title="A dry run: the hub checks everything and stores nothing">Check</button>
          <button data-ref="sign-in" type="button" class="btn btn-sm btn-primary gap-1.5 hidden">${HubIcons.span(HubIcons.SIGN_IN, '[&>svg]:size-3.5').outerHTML}Sign in</button>
          <button data-ref="publish" type="button" class="btn btn-sm btn-primary hidden">Publish</button>
          <button data-ref="upload" type="button" class="btn btn-sm btn-primary hidden">Upload</button>
        </div>
      </div>
    `;
    container.appendChild(this.overlay);
    const $ = <T extends HTMLElement>(ref: string) => this.overlay.querySelector<T>(`[data-ref="${ref}"]`)!;
    this.title = $('title');
    this.problem = $('problem');
    this.versionRow = $('version-row');
    this.nameEl = $('name');
    this.versionEl = $('version');
    this.versionInput = $('version-input');
    this.hubStatus = $('hub-status');
    this.withdrawBox = $('withdraw-box');
    this.notes = $('notes');
    this.notesField = $('notes-field');
    this.notesCount = $('notes-count');
    this.notesHint = $('notes-hint');
    this.session = $('session');
    this.notice = $('notice');
    this.footerNote = $('footer-note');
    this.retryBtn = $('retry');
    this.checkBtn = $('check');
    this.signInBtn = $('sign-in');
    this.closeBtn = $('done');
    this.bumpControl = $('bump');
    this.publishBtn = $('publish');
    this.uploadBtn = $('upload');
    this.cancelBtn = $('cancel');

    $('close').addEventListener('click', () => this.hide());
    this.closeBtn.addEventListener('click', () => this.hide());
    this.signInBtn.addEventListener('click', () => void this.signIn());
    this.retryBtn.addEventListener('click', () => void this.deps.state.load());
    this.checkBtn.addEventListener('click', () => void this.start(true));
    this.publishBtn.addEventListener('click', () => void this.start(false));
    this.uploadBtn.addEventListener('click', () => void this.deps.state.confirm());
    this.cancelBtn.addEventListener('click', () => void this.deps.state.cancel());
    // Typing takes the field over from the proposal until the dialog is opened again; Enter publishes.
    this.versionInput.addEventListener('input', () => {
      this.versionTouched = true;
    });
    this.versionInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.start(false);
      }
    });
    this.notesField.addEventListener('input', () => this.renderNotesCount());
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });
    document.addEventListener('keydown', this.onKeyDown, true);
    this.unsubscribe = deps.state.subscribe((snapshot) => this.render(snapshot));
    this.unsubscribeEnded = deps.state.onEnded((publish) => this.sessionEnded(publish));
    this.render(deps.state.current);
  }

  isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  /** Open: everything is read again, and a session left running is followed. */
  show(): void {
    this.confirmingWithdraw = null;
    this.versionTouched = false;
    this.render(this.deps.state.current);
    this.overlay.classList.remove('hidden');
    void this.deps.state.load();
  }

  /** Close. Nothing in the engine stops: a waiting session waits on, an upload finishes. */
  hide(): void {
    this.overlay.classList.add('hidden');
    this.deps.state.stopFollowing();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    this.unsubscribeEnded();
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.overlay.remove();
  }

  /** Escape closes the dialog. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.overlay.isConnected && this.isOpen()) {
      e.stopPropagation();
      this.hide();
    }
  };

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Check or Publish: the version field is applied first (the block is
   * written through the engine when the field differs from it; a refusal
   * stops here with its sentence and the field focused), then the session
   * starts. An empty field publishes the block's version as it is.
   */
  private async start(dryRun: boolean): Promise<void> {
    const pkg = this.deps.state.current.pkg?.package ?? null;
    const typed = this.versionInput.value.trim();
    if (pkg && typed !== '' && typed !== pkg.version) {
      await this.deps.state.bump(typed);
      if (this.deps.state.current.notice?.tone !== 'info') {
        this.versionInput.focus();
        return;
      }
      this.deps.onVersionChanged?.();
    }
    const notes = this.notes.classList.contains('hidden') ? null : this.notesField.value.trim() || null;
    await this.deps.state.start({ notes, dryRun });
  }

  /** The version Publish would upload: the field's, else the block's. */
  private publishVersion(pkg: { version: string }): string {
    return this.versionInput.value.trim() || pkg.version;
  }

  /** Sign in: the Hub panel takes over; the dialog is back once signed in. */
  private async signIn(): Promise<void> {
    this.hide();
    const signedIn = await this.deps.signIn();
    if (signedIn && !this.destroyed) {
      this.show();
    }
  }

  /** Withdraw asks first, with the CLI's warning; the second press withdraws. */
  private askWithdraw(open: Pick<HubVersionStatus, 'version' | 'status'>): void {
    this.confirmingWithdraw = open;
    this.render(this.deps.state.current);
  }

  private async withdraw(): Promise<void> {
    this.confirmingWithdraw = null;
    await this.deps.state.withdraw();
  }

  /** A session this page followed ended: a first version's wizard opens once (U9); the status is read again. */
  private sessionEnded(publish: HubAppPublishState): void {
    if (publish.status !== 'done' || publish.dryRun) {
      return;
    }
    const result = publish.result;
    if (result?.status === 'draft' && result.wizardUrl && this.openedWizardFor !== publish.id) {
      this.openedWizardFor = publish.id;
      this.deps.openExternal(result.wizardUrl);
    }
    void this.deps.state.reloadStatus();
  }

  // ---------------------------------------------------------------------------
  // Markup
  // ---------------------------------------------------------------------------

  private render(s: PublishSnapshot): void {
    const pkg = s.pkg?.package ?? null;
    const problem = s.pkg?.problem ?? null;
    const running = s.publish !== null && PublishState.isRunning(s.publish);
    const loading = s.pkg === null && s.pkgRefusal === null;
    const signedOut = s.statusRefusal?.code === 'signed-out';
    // The name sits in the header row with its version; the title stays one word.
    this.title.textContent = 'Publish';

    this.renderProblem(s, loading);
    this.renderVersionRow(s, pkg, running);
    this.renderHubStatus(s, pkg, running);
    this.renderWithdraw(s, pkg);
    this.renderNotes(s, pkg, running);
    this.renderSession(s, loading);
    this.renderNotice(s);

    // The footer: every primary action lives here (Sign in, Publish, Upload),
    // never inside a row, so the dialog reads top to bottom and ends on what
    // to do next. Close is the ghost at the group's left, as the Export
    // dialog's Cancel is; Cancel takes its place while a session can be stopped.
    const canPublish = pkg !== null && problem === null && !signedOut;
    const idle = !running;
    const busy = s.busy !== null;
    const status = s.publish?.status;
    const rejected = s.status?.package?.rejectedVersion !== null && s.status?.package?.rejectedVersion !== undefined && !s.status?.package?.openVersion;
    // A revoked token surfaces as a failed session rather than a status refusal.
    const needsSignIn = pkg !== null && problem === null && (signedOut || (status === 'failed' && s.publish?.error?.code === 'signed-out'));
    const cancellable = status === 'checking' || status === 'packing' || status === 'awaiting-confirm';
    PublishDialog.toggle(this.retryBtn, !loading && (s.pkgRefusal !== null || problem !== null));
    PublishDialog.toggle(this.signInBtn, needsSignIn);
    PublishDialog.toggle(this.checkBtn, canPublish && idle);
    PublishDialog.toggle(this.publishBtn, canPublish && idle);
    this.publishBtn.textContent = rejected ? 'Publish again' : 'Publish';
    PublishDialog.toggle(this.uploadBtn, status === 'awaiting-confirm');
    PublishDialog.toggle(this.cancelBtn, cancellable);
    PublishDialog.toggle(this.closeBtn, !cancellable);
    // The version is the author's to change only when publishing is on the table.
    PublishDialog.toggle(this.bumpControl, canPublish && idle);
    const uploading = status === 'uploading' || status === 'verifying';
    PublishDialog.toggle(this.footerNote, uploading);
    this.footerNote.textContent = uploading ? "Closing this window doesn't stop the upload." : '';
    for (const button of [this.retryBtn, this.signInBtn, this.checkBtn, this.publishBtn, this.uploadBtn, this.cancelBtn]) {
      button.disabled = busy;
    }
  }

  private renderProblem(s: PublishSnapshot, loading: boolean): void {
    this.problem.replaceChildren();
    const pkg = s.pkg;
    let text: string | null = null;
    let lead: string | null = null;
    if (s.pkgRefusal) {
      text = s.pkgRefusal.error;
    } else if (pkg?.problem) {
      // U7: the block is there but can't be read — the first refusal.
      text = pkg.problem;
      lead = 'Fix fluidcad.json, then try again.';
    } else if (pkg && !pkg.package && !loading) {
      text = 'This workspace has no package block in its fluidcad.json. Publishing needs a package workspace (New Package on the start screen, or fluidcad init --package @handle/name).';
    }
    PublishDialog.toggle(this.problem, text !== null);
    if (text === null) {
      return;
    }
    this.problem.appendChild(PublishDialog.alert('error', text, lead));
    this.problem.dataset.code = s.pkgRefusal ? s.pkgRefusal.code : pkg?.problem ? 'bad-config' : 'not-a-package';
  }

  private renderVersionRow(s: PublishSnapshot, pkg: { name: string; version: string } | null, running: boolean): void {
    PublishDialog.toggle(this.versionRow, pkg !== null);
    if (!pkg) {
      return;
    }
    this.nameEl.textContent = pkg.name;
    this.versionEl.textContent = pkg.version;
    const disabled = s.busy !== null || running;
    // The field proposes the next major above the hub's latest (the block's
    // own version when nothing is published yet, or it is already above);
    // the author's typing wins until the dialog is opened again.
    const latest = s.status?.latest?.version ?? null;
    if (!this.versionTouched && document.activeElement !== this.versionInput) {
      this.versionInput.value = PublishText.proposedVersion(pkg.version, latest);
    }
    this.versionInput.title = latest
      ? `The version to publish; the hub's latest is ${latest} and the package is ${pkg.version} now`
      : `The version to publish; the package is ${pkg.version} now`;
    this.versionInput.disabled = disabled;
  }

  private renderHubStatus(s: PublishSnapshot, pkg: { name: string; version: string } | null, running: boolean): void {
    this.hubStatus.replaceChildren();
    delete this.hubStatus.dataset.state;
    PublishDialog.toggle(this.hubStatus, pkg !== null);
    if (!pkg) {
      return;
    }
    const hub = s.hub ?? 'the hub';
    if (s.statusRefusal) {
      if (s.statusRefusal.code === 'signed-out') {
        // The sentence alone; Sign in is the footer's primary button.
        this.hubStatus.dataset.state = 'signed-out';
        this.hubStatus.appendChild(PublishDialog.line('signed-out', s.statusRefusal.error));
        return;
      }
      this.hubStatus.dataset.state = 'unknown';
      const retry = PublishDialog.button('status-retry', 'Try again', SMALL_BTN, () => void this.deps.state.reloadStatus());
      retry.disabled = s.busy !== null;
      const row = PublishDialog.row('status-problem', s.statusRefusal.error, [retry]);
      row.prepend(PublishDialog.icon(ICON_ALERT_TRIANGLE, 'text-warning'));
      this.hubStatus.appendChild(row);
      return;
    }
    if (!s.status) {
      this.hubStatus.dataset.state = 'reading';
      this.hubStatus.appendChild(PublishDialog.wait('Reading where the package stands on the hub…'));
      return;
    }
    this.hubStatus.dataset.state = 'known';
    for (const line of this.statusLines(s.status, pkg.name, hub, s.busy !== null || running)) {
      this.hubStatus.appendChild(line);
    }
  }

  /** `fluidcad publish --status`'s lines, with buttons where it names pages and commands. */
  private statusLines(status: HubPublishStatus, name: string, hub: string, disabled: boolean): HTMLElement[] {
    const lines: HTMLElement[] = [];
    const pkg = status.package;
    if (!pkg) {
      // Nothing on the hub yet: no line (the user's call); Publish in the footer says what comes next.
      return lines;
    }
    const open = pkg.openVersion;
    const rejected = pkg.rejectedVersion;
    if (open) {
      const at = PublishText.at(name, open.version);
      if (open.status === 'draft') {
        // The CLI adds "finish publishing in your browser: <url>"; here the button is that sentence.
        const actions: HTMLElement[] = [];
        if (open.wizardUrl) {
          const url = open.wizardUrl;
          actions.push(PublishDialog.button('open-wizard', 'Open the wizard', LINK_BTN, () => this.deps.openExternal(url), HubIcons.EXTERNAL));
        }
        actions.push(this.withdrawButton(open, disabled));
        // Short on purpose: the row keeps its two buttons beside it at the dialog's width.
        lines.push(PublishDialog.row('open-draft', `${at} is a draft.`, actions));
        if (open.draftExpiresAt) {
          lines.push(PublishDialog.line('draft-expires', `A draft nobody touches is deleted on ${PublishText.day(open.draftExpiresAt)}.`, MUTED));
        }
      } else if (open.status === 'in_review') {
        const actions: HTMLElement[] = [];
        if (open.reviewUrl) {
          const url = open.reviewUrl;
          actions.push(PublishDialog.button('open-review', 'View its status', LINK_BTN, () => this.deps.openExternal(url), HubIcons.EXTERNAL));
        }
        actions.push(this.withdrawButton(open, disabled));
        lines.push(PublishDialog.row('open-in-review', `${at} is in review${open.submittedAt ? ` since ${PublishText.day(open.submittedAt)}` : ''}.`, actions));
      } else {
        lines.push(PublishDialog.line('open-uploading', `${at} is being uploaded.`));
      }
    } else if (rejected) {
      lines.push(PublishDialog.line('rejected', `${PublishText.at(name, rejected.version)} was rejected${rejected.reviewNote ? `: ${rejected.reviewNote}` : '.'}`));
      lines.push(PublishDialog.line('rejected-next', 'Fix it, then publish again (the same version number is free).', MUTED));
    }
    if (status.latest) {
      const when = status.latest.publishedAt ? ` on ${PublishText.day(status.latest.publishedAt)}` : '';
      const lead = open || rejected ? 'Latest published' : `${name}: latest published`;
      const manage = PublishDialog.button('manage', 'Manage on the hub', LINK_BTN, () => this.deps.openExternal(PublishText.manageUrl(hub, name)), HubIcons.EXTERNAL);
      lines.push(PublishDialog.row('latest', `${lead} ${status.latest.version}${when}.`, [manage]));
    }
    if (pkg.status !== 'active') {
      lines.push(PublishDialog.line('package-status', `the package is ${pkg.status} by the hub's admins`, `${MUTED} text-warning`));
    }
    return lines;
  }

  private renderWithdraw(s: PublishSnapshot, pkg: { name: string; version: string } | null): void {
    this.withdrawBox.replaceChildren();
    const asking = this.confirmingWithdraw;
    PublishDialog.toggle(this.withdrawBox, asking !== null && pkg !== null);
    if (!asking || !pkg) {
      return;
    }
    const box = document.createElement('div');
    box.dataset.ref = 'withdraw-confirm';
    box.className = `${CARD} border-warning/40 bg-warning/10`;
    const text = document.createElement('p');
    text.className = LINE;
    text.textContent = PublishText.withdrawWarning(pkg.name, asking, s.hub ?? 'the hub');
    const actions = document.createElement('div');
    actions.className = 'flex items-center justify-end gap-2';
    const keep = PublishDialog.button('withdraw-keep', 'Keep it', 'btn btn-xs', () => {
      this.confirmingWithdraw = null;
      this.render(this.deps.state.current);
    });
    const go = PublishDialog.button('withdraw-go', 'Withdraw it', 'btn btn-xs btn-warning', () => void this.withdraw());
    go.disabled = s.busy !== null;
    actions.append(keep, go);
    box.append(text, actions);
    this.withdrawBox.appendChild(box);
  }

  private renderNotes(s: PublishSnapshot, pkg: { name: string; version: string } | null, running: boolean): void {
    const finished = s.publish?.status === 'done' && !s.publish.dryRun;
    const show = pkg !== null && s.pkg?.problem === null && s.status?.latest != null && !running && !finished;
    PublishDialog.toggle(this.notes, show);
    if (!show) {
      return;
    }
    this.notesField.disabled = s.busy !== null;
    const version = this.publishVersion(pkg!);
    this.notesHint.textContent = `${version} goes to review. Left empty, the hub takes the CHANGELOG section for ${version}.`;
    this.renderNotesCount();
  }

  private renderNotesCount(): void {
    this.notesCount.textContent = `${this.notesField.value.length} / ${RELEASE_NOTES_CHARS}`;
  }

  private renderSession(s: PublishSnapshot, loading: boolean): void {
    // A poll that brings the same session back leaves its nodes alone: drawn
    // again every POLL_MS, a click whose press and release straddle a redraw
    // lands on nothing (a warning that won't unfold).
    const failed = s.publish?.status === 'failed';
    const key = JSON.stringify([loading, s.publish, failed ? s.busy : null, failed ? s.status?.package?.openVersion ?? null : null]);
    if (key === this.sessionKey) {
      return;
    }
    this.sessionKey = key;
    this.session.replaceChildren();
    delete this.session.dataset.status;
    if (loading) {
      PublishDialog.toggle(this.session, true);
      this.session.appendChild(PublishDialog.wait('Reading the package…'));
      return;
    }
    const publish = s.publish;
    PublishDialog.toggle(this.session, publish !== null);
    if (!publish) {
      return;
    }
    this.session.dataset.status = publish.status;
    switch (publish.status) {
      case 'checking':
        this.session.appendChild(PublishDialog.wait('Checking with the hub…'));
        return;
      case 'packing':
        this.session.appendChild(PublishDialog.wait('Packing…'));
        return;
      case 'awaiting-confirm':
        this.session.append(...PublishDialog.summary(publish.summary!));
        if (publish.confirmBy) {
          const until = new Date(publish.confirmBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          this.session.appendChild(PublishDialog.line('confirm-by', `Nothing is sent until you upload. This waits until ${until}.`, MUTED));
        }
        return;
      case 'uploading':
        this.session.appendChild(PublishDialog.progress(publish.progress ?? { sent: 0, total: publish.summary?.size ?? 0 }));
        return;
      case 'verifying':
        this.session.appendChild(PublishDialog.wait('The hub is checking the archive…'));
        return;
      case 'done':
        this.renderDone(publish);
        return;
      case 'declined':
        this.session.appendChild(PublishDialog.line('declined', publish.error?.message ?? 'Nothing was uploaded.', MUTED));
        return;
      case 'failed':
        this.renderFailed(s, publish);
        return;
    }
  }

  private renderDone(publish: HubAppPublishState): void {
    const result = publish.result!;
    const card = document.createElement('div');
    card.dataset.ref = 'result';
    card.className = `${CARD} border-success/40 bg-success/10`;
    if (publish.dryRun) {
      card.appendChild(PublishDialog.lineWithIcon(ICON_CIRCLE_CHECK, 'text-success', PublishText.dryRun(publish)));
      this.session.appendChild(card);
      if (publish.summary) {
        this.session.append(...PublishDialog.summary(publish.summary));
      }
      return;
    }
    const at = PublishText.at(result.name, result.version);
    if (result.replaced) {
      card.appendChild(PublishDialog.line('replaced', `Replaced the draft of ${at}; the wizard keeps what you filled in.`, MUTED));
    }
    // The CLI prints the integrity here too; the dialog leaves it out (the summary already showed it).
    if (result.status === 'draft') {
      card.appendChild(PublishDialog.lineWithIcon(ICON_CIRCLE_CHECK, 'text-success', `Uploaded ${at}. Finish publishing in your browser:`));
      if (result.wizardUrl) {
        card.appendChild(this.link('wizard-link', result.wizardUrl));
      }
    } else {
      card.appendChild(PublishDialog.lineWithIcon(ICON_CIRCLE_CHECK, 'text-success', `Submitted ${at} for review.`));
      if (result.reviewUrl) {
        card.appendChild(this.link('review-link', result.reviewUrl));
      }
    }
    this.session.appendChild(card);
  }

  /** The refusal's sentence with the action its code calls for (U10). */
  private renderFailed(s: PublishSnapshot, publish: HubAppPublishState): void {
    const error = publish.error ?? { message: 'The publish failed.', code: 'internal' };
    const details = (error.details ?? {}) as Record<string, unknown>;
    const card = document.createElement('div');
    card.dataset.ref = 'failed';
    card.dataset.code = error.code;
    card.className = `${CARD} border-error/40 bg-error/10`;
    card.appendChild(PublishDialog.lineWithIcon(ICON_ALERT_TRIANGLE, 'text-error', error.message));
    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-2 flex-wrap';
    // `signed-out` has no row action: the footer shows Sign in for it.
    switch (error.code) {
      case 'version-exists':
      case 'version-not-greater':
        // The sentence names the hub's highest version; the author types one above it in the header, and Publish applies it.
        this.versionInput.focus();
        break;
      case 'in-review':
      case 'open-version-exists': {
        const open = s.status?.package?.openVersion
          ?? (typeof details.version === 'string' ? { version: details.version, status: (details.status as HubVersionStatus['status']) ?? 'in_review' } : null);
        if (open) {
          actions.appendChild(this.withdrawButton(open, s.busy !== null, 'btn btn-xs'));
        }
        break;
      }
      case 'unsaved-changes':
        actions.appendChild(PublishDialog.line('save-first', 'Save your files first.', `${LINE} font-medium`));
        break;
      default:
        break;
    }
    if (actions.childElementCount > 0) {
      card.appendChild(actions);
    }
    this.session.appendChild(card);
  }

  private renderNotice(s: PublishSnapshot): void {
    const notice = s.notice;
    PublishDialog.toggle(this.notice, notice !== null);
    this.notice.textContent = notice?.text ?? '';
    this.notice.className = `text-xs leading-snug ${notice === null ? 'hidden' : notice.tone === 'error' ? 'text-error' : 'text-base-content/60'}`;
    if (notice?.code) {
      this.notice.dataset.code = notice.code;
    } else {
      delete this.notice.dataset.code;
    }
  }

  // ---------------------------------------------------------------------------
  // Pieces
  // ---------------------------------------------------------------------------

  private withdrawButton(open: Pick<HubVersionStatus, 'version' | 'status'>, disabled: boolean, cls = LINK_BTN): HTMLButtonElement {
    const button = PublishDialog.button('withdraw', 'Withdraw', cls, () => this.askWithdraw(open));
    button.title = open.status === 'draft' ? 'Delete the draft on the hub; its number is free again' : 'Take the version out of review; its number is free again';
    button.disabled = disabled;
    return button;
  }

  /** A URL as a link that leaves through the host. */
  private link(ref: string, url: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.ref = ref;
    button.className = 'link link-hover text-left text-[11px] font-mono text-primary break-all self-start';
    button.textContent = url;
    button.addEventListener('click', () => this.deps.openExternal(url));
    return button;
  }

  /**
   * What will be uploaded (`PublishView.printSummary`, laid out for reading
   * rather than printed): a table of where it goes and what it holds, what
   * happens after the upload, then the warnings, each one row per file.
   */
  private static summary(summary: HubPublishSummary): HTMLElement[] {
    const card = document.createElement('div');
    card.dataset.ref = 'summary';
    card.className = CARD;
    const rows = document.createElement('div');
    rows.className = 'grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 items-baseline';
    const row = (ref: string, label: string, text: string, cls = LINE): HTMLSpanElement => {
      const value = document.createElement('span');
      value.dataset.ref = ref;
      value.className = `${cls} min-w-0`;
      value.textContent = text;
      rows.append(PublishDialog.label(label), value);
      return value;
    };
    row('summary-hub', 'Hub', PublishText.host(summary.hub)).title = summary.hub;
    row('summary-handle', 'As', `@${summary.handle}`);
    row('summary-contents', 'Contents', PublishText.summaryContents(summary));
    row('summary-size', 'Archive', PublishText.summarySize(summary));
    row('summary-integrity', 'Integrity', summary.integrity, `${MUTED} font-mono truncate`).title = summary.integrity;
    if (summary.notes) {
      row('summary-notes', 'Notes', summary.notes);
    }
    card.appendChild(rows);
    // What happens next, set off from the table.
    const becomes = PublishDialog.line('becomes', PublishText.becomes(summary), `${LINE} text-base-content/90 mt-1 pt-2 border-t border-base-content/10`);
    card.appendChild(becomes);
    return summary.warnings.length > 0 ? [card, PublishDialog.warnings(summary.warnings)] : [card];
  }

  /**
   * The warnings: a heading that says they don't stop anything, then a row
   * per warning — the file, and what is wrong in a few words. A file's
   * fields without a description fold under its row, by owner.
   */
  private static warnings(warnings: HubPublishWarning[]): HTMLDivElement {
    const box = document.createElement('div');
    box.dataset.ref = 'warnings';
    box.className = 'rounded-md border border-warning/30 bg-warning/5 flex flex-col';
    const head = document.createElement('div');
    head.className = `flex items-center gap-2 px-3 py-2 ${LINE}`;
    const lead = document.createElement('span');
    lead.dataset.ref = 'warnings-lead';
    lead.className = 'font-medium text-base-content/90';
    lead.textContent = PublishText.warningsLead(warnings.length);
    const why = document.createElement('span');
    why.className = MUTED;
    why.textContent = "They don't stop the upload.";
    head.append(PublishDialog.icon(ICON_ALERT_TRIANGLE, 'text-warning'), lead, why);
    box.appendChild(head);
    const list = document.createElement('ul');
    list.className = 'flex flex-col border-t border-warning/20 divide-y divide-base-content/5';
    for (const warning of warnings) {
      list.appendChild(PublishDialog.warning(warning));
    }
    box.appendChild(list);
    if (warnings.some((w) => w.code === 'undocumented-fields')) {
      const hint = document.createElement('p');
      hint.dataset.ref = 'warnings-hint';
      hint.className = `${MUTED} px-3 py-2 border-t border-warning/20`;
      const code = document.createElement('code');
      code.className = 'font-mono';
      code.textContent = 'description';
      hint.append('Descriptions are optional: give each field listed a ', code, ' to clear these.');
      box.appendChild(hint);
    }
    return box;
  }

  /** One warning's row: the file, its sentence; the fields fold out under it. */
  private static warning(warning: HubPublishWarning): HTMLLIElement {
    const item = document.createElement('li');
    item.dataset.ref = 'warning';
    item.dataset.code = warning.code;
    const file = document.createElement('span');
    file.dataset.ref = 'warning-file';
    file.className = 'font-mono text-[11px] text-base-content/85 truncate min-w-0';
    file.textContent = warning.file;
    file.title = warning.file;
    const text = document.createElement('span');
    text.dataset.ref = 'warning-text';
    text.className = `${MUTED} min-w-0`;
    text.textContent = PublishText.warningSummary(warning);
    const fields = warning.code === 'undocumented-fields' ? warning.fields ?? [] : [];
    // The file, after a chevron (a blank of its width when nothing folds out), so every file starts in one column.
    const chevron = document.createElement('span');
    chevron.className = 'shrink-0 self-center flex w-3 mr-1.5 text-base-content/40 transition-transform group-open:rotate-90 [&>svg]:size-2.5';
    chevron.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'flex items-baseline min-w-0';
    label.append(chevron, file);
    const rowClass = 'flex items-baseline gap-x-3 gap-y-0.5 flex-wrap px-3 py-1.5';
    if (fields.length === 0) {
      const row = document.createElement('div');
      row.className = rowClass;
      row.append(label, text);
      item.appendChild(row);
      return item;
    }
    // A <details>: the file's fields stay folded until asked for.
    chevron.innerHTML = ICON_CHEVRON_RIGHT;
    const details = document.createElement('details');
    details.className = 'group';
    const head = document.createElement('summary');
    head.className = `${rowClass} cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-base-content/5`;
    head.append(label, text);
    details.appendChild(head);
    const body = document.createElement('div');
    body.dataset.ref = 'warning-fields';
    body.className = 'flex flex-col gap-1.5 pr-3 pb-2 pl-7.5';
    const byOwner = new Map<string, HubPublishDocGap[]>();
    for (const gap of fields) {
      byOwner.set(gap.owner, [...(byOwner.get(gap.owner) ?? []), gap]);
    }
    for (const [owner, gaps] of byOwner) {
      const group = document.createElement('div');
      group.className = 'flex flex-col gap-1';
      if (byOwner.size > 1) {
        const name = document.createElement('span');
        name.className = `${MUTED} font-mono`;
        name.textContent = owner;
        group.appendChild(name);
      }
      const chips = document.createElement('div');
      chips.className = 'flex flex-wrap gap-1';
      for (const gap of gaps) {
        const chip = document.createElement('span');
        chip.dataset.ref = 'warning-field';
        chip.className = 'font-mono text-[10.5px] leading-4 px-1.5 rounded bg-base-content/[0.07] text-base-content/75';
        chip.textContent = PublishText.gapName(gap);
        if (gap.label !== gap.name) {
          chip.title = gap.label;
        }
        chips.appendChild(chip);
      }
      group.appendChild(chips);
      body.appendChild(group);
    }
    details.appendChild(body);
    item.appendChild(details);
    return item;
  }

  private static progress(progress: { sent: number; total: number }): HTMLDivElement {
    const box = document.createElement('div');
    box.dataset.ref = 'progress';
    box.className = 'flex flex-col gap-1';
    const bar = document.createElement('progress');
    bar.className = 'progress progress-primary w-full h-1.5';
    bar.max = Math.max(progress.total, 1);
    bar.value = Math.min(progress.sent, bar.max);
    box.append(bar, PublishDialog.line('progress-text', PublishText.uploading(progress), MUTED));
    return box;
  }

  private static wait(text: string): HTMLDivElement {
    const row = document.createElement('div');
    row.dataset.ref = 'wait';
    row.className = `flex items-center gap-2 ${LINE}`;
    const spinner = document.createElement('span');
    spinner.className = 'loading loading-spinner loading-xs text-base-content/40';
    row.append(spinner, text);
    return row;
  }

  private static alert(tone: 'error' | 'warning', text: string, lead: string | null): HTMLDivElement {
    const box = document.createElement('div');
    box.className = `flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-snug border ${tone === 'error' ? 'border-error/40 bg-error/10' : 'border-warning/40 bg-warning/10'}`;
    box.appendChild(PublishDialog.icon(ICON_ALERT_TRIANGLE, tone === 'error' ? 'text-error' : 'text-warning'));
    const body = document.createElement('div');
    body.className = 'flex-1 min-w-0 flex flex-col gap-1';
    const sentence = document.createElement('span');
    sentence.dataset.ref = 'problem-text';
    sentence.className = 'text-base-content/90';
    sentence.textContent = text;
    body.appendChild(sentence);
    if (lead) {
      const next = document.createElement('span');
      next.className = 'text-base-content/60';
      next.textContent = lead;
      body.appendChild(next);
    }
    box.appendChild(body);
    return box;
  }

  /** The summary table's label column: `Hub`, `Contents`, `Integrity`. */
  private static label(text: string): HTMLSpanElement {
    const label = document.createElement('span');
    label.className = MUTED;
    label.textContent = text;
    return label;
  }

  /** A sentence with its buttons grouped at the right end of the row (see {@link ROW}). */
  private static row(ref: string, text: string, actions: HTMLElement[]): HTMLDivElement {
    const row = document.createElement('div');
    row.dataset.ref = ref;
    row.className = ROW;
    const span = document.createElement('span');
    span.className = `${LINE} min-w-0`;
    span.textContent = text;
    row.appendChild(span);
    if (actions.length > 0) {
      const group = document.createElement('span');
      group.className = ROW_ACTIONS;
      group.append(...actions);
      row.appendChild(group);
    }
    return row;
  }

  private static line(ref: string, text: string, cls = LINE): HTMLDivElement {
    const row = document.createElement('div');
    row.dataset.ref = ref;
    row.className = cls;
    const span = document.createElement('span');
    span.textContent = text;
    row.appendChild(span);
    return row;
  }

  private static lineWithIcon(svg: string, tone: string, text: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = `flex items-start gap-2 ${LINE} text-base-content/90`;
    row.appendChild(PublishDialog.icon(svg, tone));
    const span = document.createElement('span');
    span.dataset.ref = 'result-text';
    span.className = 'flex-1 min-w-0 break-words';
    span.textContent = text;
    row.appendChild(span);
    return row;
  }

  private static icon(svg: string, tone: string): HTMLSpanElement {
    const icon = document.createElement('span');
    icon.className = `shrink-0 mt-px [&>svg]:size-4 ${tone}`;
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = svg;
    return icon;
  }

  private static button(ref: string, label: string, cls: string, onClick: () => void, svg?: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.ref = ref;
    button.className = cls;
    if (svg) {
      button.appendChild(HubIcons.span(svg, '[&>svg]:size-3.5'));
    }
    button.append(label);
    button.addEventListener('click', onClick);
    return button;
  }

  private static toggle(el: HTMLElement, shown: boolean): void {
    el.classList.toggle('hidden', !shown);
  }
}
