import type { DeliveryResult, DesktopFileFilter } from '../../desktop';
import { HubIcons } from '../hub/hub-icons';
import { ICON_BUG, ICON_CAMERA } from '../icons';
import type { LeftSlot } from '../left-slot';
import { BugReport, type BugReportDraft } from './bug-report';

/** A project file the report can carry. */
export type BugReportFile = {
  /** Workspace-relative, forward slashes: its name in the list and in the archive. */
  path: string;
  /** Absolute, as the scene names its file. */
  absPath: string;
  size: number;
};

export type BugReportPanelDeps = {
  /** `#fluidcad-viewer`, the positioning context every overlay shares. */
  container: HTMLElement;
  /** The left slot it shares with the code editor, the Hub and the Agent. */
  slot: LeftSlot;
  /** The project's files, as the file picker lists them. */
  listFiles(): Promise<BugReportFile[]>;
  /** One project file's bytes. */
  readFile(file: BugReportFile): Promise<Blob>;
  /** The absolute path of the file on screen, which the list puts first; null with no model open. */
  currentFile(): string | null;
  /** A picture of the scene as it is on screen. */
  capture(): Promise<Blob>;
  /**
   * A picture of the whole window (the desktop app): the panel steps out of
   * the way for it, and comes back. Null when the window could not be
   * pictured, which falls back to {@link capture}. Absent in a browser or an
   * editor, where a page cannot picture its own window.
   */
  captureWindow?(): Promise<Blob | null>;
  /** Resolves once the layout has settled after the panel closed (tests); the slot's animation by default. */
  layoutSettled?(): Promise<void>;
  /** The environment lines (`BugReportEnvironment.lines`). */
  environment(): Promise<string[]>;
  /** Put a picture on the clipboard; false when the clipboard refuses. */
  copyImage(image: Blob): Promise<boolean>;
  /** Pack files into one zip. */
  archive(files: { fileName: string; blob: Blob }[]): Promise<Blob>;
  /** Hand a file to the user: a Save dialog on the desktop, a download elsewhere. */
  deliver(blob: Blob, name: string, filters: DesktopFileFilter[]): Promise<DeliveryResult>;
  /** Open a web page in the user's browser, through the host. */
  openExternal(url: string): void;
  onOpenChange?(open: boolean): void;
};

/** What a submitted report left for the user to add on GitHub. */
type Handoff = {
  url: string;
  /** The screenshots in order, each with where it is now. */
  screenshots: HandedShot[];
  /** The archive, and how many files it holds. */
  archive: { blob: Blob; count: number } | null;
};

/** A screenshot in the form: the picture and the object URL its thumbnail shows. */
type Shot = { image: Blob; url: string };

/**
 * A handed-over screenshot. The clipboard holds one picture at a time, so
 * only one is `clipboard` at once; `waiting` ones are copied from the list
 * after the hand-off, `file` ones were saved under `name`, and `nowhere`
 * means neither the clipboard nor a save took it.
 */
type HandedShot = Shot & { name: string; where: 'clipboard' | 'waiting' | 'file' | 'nowhere' };

const MIN_WIDTH = 300;
/** Past this many files the list gets a filter. */
const FILTER_FROM = 9;
/** The most rows the list draws; the filter reaches the rest. */
const MAX_ROWS = 300;

const ZIP_FILTER: DesktopFileFilter = { name: 'Zip archive', extensions: ['zip'] };
const PNG_FILTER: DesktopFileFilter = { name: 'PNG image', extensions: ['png'] };

const LABEL = 'text-hub-xs font-medium text-base-content/75';
const NOTE = 'text-hub-2xs text-base-content/55 leading-snug';
const SECTION = 'flex flex-col gap-1.5';

/**
 * The bug report panel: a title, a description, screenshots (of the whole
 * window in the desktop app, of the scene elsewhere) and
 * any project files, docked on the left from the rail's bug button. Its one
 * action opens GitHub's new-issue page with the title and the text filled in.
 *
 * **Nothing is sent from here.** FluidCAD has no account on GitHub to post
 * with, and GitHub's new-issue link carries text only, so the report is
 * handed to the user in three parts: the issue's text in the link, the
 * screenshots on the clipboard, one at a time (to paste into the issue: the
 * first is copied at the hand-off, the others from the list shown after it),
 * and the chosen files
 * in one zip saved on this computer (to drop into it). The form says so at
 * each control, shows the issue's text exactly as the link carries it, and
 * after the hand-off lists what is left to do on GitHub.
 *
 * It docks in the {@link LeftSlot} like the Hub panel: opening it closes
 * whatever holds the slot. A draft survives closing the panel.
 */
export class BugReportPanel {
  readonly el: HTMLElement;
  private readonly form: HTMLElement;
  private readonly done: HTMLElement;
  private readonly title: HTMLInputElement;
  private readonly description: HTMLTextAreaElement;
  private readonly shot: HTMLElement;
  private readonly filesHead: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly fileList: HTMLElement;
  private readonly environmentToggle: HTMLInputElement;
  private readonly preview: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly submitBtn: HTMLButtonElement;
  private readonly leaveSlot: () => void;

  private open = false;
  private busy = false;
  private files: BugReportFile[] = [];
  private filesError: string | null = null;
  private readonly selected = new Set<string>();
  private shots: Shot[] = [];
  private capturing = false;
  private environment: string[] = [];
  /** Counts the list reads, so a slow one never overwrites a newer one. */
  private listing = 0;

  constructor(private readonly deps: BugReportPanelDeps) {
    this.leaveSlot = deps.slot.register(this);

    this.el = document.createElement('aside');
    this.el.dataset.role = 'bug-report-panel';
    this.el.setAttribute('aria-label', 'Report a bug');
    this.el.className =
      'absolute left-[var(--fluidcad-rail-width,0px)] top-[var(--fluidcad-chrome-top,104px)] bottom-0 z-[115] '
      + 'flex flex-col bg-base-100 text-base-content border-r border-base-content/10 text-hub-md hidden';

    const header = Dom.el('div', 'flex items-center gap-2 h-11 shrink-0 pl-3 pr-1.5 border-b border-base-content/10');
    const heading = Dom.el('span', 'text-hub-md font-medium text-base-content/90', 'Report a bug');
    const close = Dom.button('btn btn-ghost btn-square btn-xs text-base-content/60 ml-auto', 'close');
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close the bug report panel');
    close.appendChild(HubIcons.span(HubIcons.CLOSE, '[&>svg]:size-4'));
    close.addEventListener('click', () => this.close());
    header.append(HubIcons.span(ICON_BUG, '[&>svg]:size-4 text-base-content/60'), heading, close);

    // ---- The form -----------------------------------------------------------
    this.form = Dom.el('div', 'flex flex-col flex-1 min-h-0');
    this.form.dataset.ref = 'form';
    const body = Dom.el('div', 'flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 px-3 py-3');

    const intro = Dom.el(
      'p',
      'text-hub-xs text-base-content/70 leading-snug',
      'This opens a new issue on GitHub with the title and the text below filled in. '
        + 'Nothing leaves this computer until you submit the issue there, and issues are public.',
    );

    this.title = document.createElement('input');
    this.title.type = 'text';
    this.title.dataset.ref = 'title';
    this.title.className = 'input input-sm w-full text-hub-sm';
    this.title.placeholder = 'What went wrong, in a sentence';
    this.title.maxLength = 200;
    this.title.setAttribute('aria-label', 'Title');
    this.title.addEventListener('input', () => this.changed());

    this.description = document.createElement('textarea');
    this.description.dataset.ref = 'description';
    this.description.className = 'textarea textarea-sm w-full text-hub-sm leading-snug min-h-28 resize-y';
    this.description.setAttribute('aria-label', 'Description');
    this.description.placeholder = 'What you did, what you expected, and what happened instead';
    this.description.addEventListener('input', () => this.changed());

    this.shot = Dom.el('div', 'flex flex-col gap-2');
    this.shot.dataset.ref = 'screenshots';

    this.filesHead = Dom.el('div', 'flex items-center gap-2 min-w-0');
    this.filter = document.createElement('input');
    this.filter.type = 'search';
    this.filter.dataset.ref = 'file-filter';
    this.filter.className = 'input input-xs w-full text-hub-xs hidden';
    this.filter.placeholder = 'Filter files';
    this.filter.setAttribute('aria-label', 'Filter the project files');
    this.filter.addEventListener('input', () => this.renderFiles());
    this.fileList = Dom.el('div', 'flex flex-col max-h-56 overflow-y-auto rounded-md border border-base-content/10');
    this.fileList.dataset.ref = 'files';

    this.environmentToggle = document.createElement('input');
    this.environmentToggle.type = 'checkbox';
    this.environmentToggle.dataset.ref = 'environment';
    this.environmentToggle.className = 'checkbox checkbox-xs';
    this.environmentToggle.checked = true;
    this.environmentToggle.addEventListener('change', () => this.changed());
    const environmentRow = Dom.el('label', 'flex items-center gap-2 text-hub-xs text-base-content/80 cursor-pointer');
    environmentRow.append(this.environmentToggle, Dom.el('span', '', 'Include the FluidCAD version and system details'));

    this.preview = Dom.el(
      'pre',
      'text-hub-2xs font-mono leading-snug whitespace-pre-wrap break-words rounded-md '
        + 'border border-base-content/10 bg-base-200/60 px-2.5 py-2 max-h-64 overflow-y-auto select-text',
    );
    this.preview.dataset.ref = 'preview';

    body.append(
      intro,
      Dom.section('Title', this.title),
      Dom.section('Description', this.description),
      Dom.section(
        'Screenshots',
        this.shot,
        Dom.el(
          'p',
          NOTE,
          'A link can’t carry pictures: the first screenshot is copied to the clipboard for you to paste into the issue, and you copy any others from the next step, one at a time.',
        ),
      ),
      Dom.section(
        'Project files',
        this.filesHead,
        this.filter,
        this.fileList,
        Dom.el(
          'p',
          NOTE,
          `A link can’t carry files either: the ones you tick are saved as ${BugReport.ARCHIVE_NAME} on this computer for you to drop into the issue. Only ticked files go in it.`,
        ),
      ),
      Dom.section(
        'Issue text',
        Dom.el('p', NOTE, 'Exactly what the link fills in on GitHub. You can still edit it there.'),
        this.preview,
        environmentRow,
      ),
    );

    const footer = Dom.el('div', 'flex flex-col gap-2 px-3 py-3 border-t border-base-content/10 shrink-0');
    this.notice = Dom.el('p', 'text-hub-xs text-error leading-snug hidden');
    this.notice.dataset.ref = 'notice';
    this.notice.setAttribute('role', 'alert');
    this.submitBtn = Dom.button('btn btn-primary btn-sm w-full gap-1.5', 'submit');
    this.submitBtn.append(Dom.el('span', '', 'Continue on GitHub'), HubIcons.span(HubIcons.EXTERNAL, '[&>svg]:size-4'));
    this.submitBtn.addEventListener('click', () => void this.submit());
    footer.append(this.notice, this.submitBtn);
    this.form.append(body, footer);

    // ---- After the hand-off -------------------------------------------------
    this.done = Dom.el('div', 'flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 px-3 py-3 hidden');
    this.done.dataset.ref = 'done';

    this.el.append(header, this.form, this.done, deps.slot.resizeHandle());
    deps.container.appendChild(this.el);
    this.renderScreenshots();
    this.renderFiles();
    this.changed();
    window.addEventListener('resize', this.onResize);
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) {
      this.close();
    } else {
      this.show();
    }
  }

  /** Open the panel; the file list and the environment are read again each time. */
  show(): void {
    if (!this.open) {
      this.deps.slot.take(this, { el: this.el, minWidth: MIN_WIDTH });
      this.open = true;
      this.el.classList.remove('hidden');
      this.deps.onOpenChange?.(true);
    }
    void this.loadFiles();
    void this.loadEnvironment();
    if (!this.form.classList.contains('hidden')) {
      this.title.focus();
    }
  }

  close(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.el.classList.add('hidden');
    this.deps.slot.release(this);
    this.deps.onOpenChange?.(false);
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.leaveSlot();
    this.dropScreenshots();
    this.el.remove();
  }

  /** The report as the form stands. */
  get draft(): BugReportDraft {
    return {
      title: this.title.value,
      description: this.description.value,
      screenshots: this.shots.length,
      files: this.chosenFiles().map((file) => file.path),
      environment: this.environmentToggle.checked ? this.environment : [],
    };
  }

  /** Take another screenshot of the scene as it is now (the Capture button; tests). */
  async captureScreenshot(): Promise<void> {
    if (this.capturing || this.shots.length >= BugReport.MAX_SCREENSHOTS) {
      return;
    }
    this.capturing = true;
    this.renderScreenshots();
    try {
      const image = await this.picture();
      this.shots.push({ image, url: URL.createObjectURL(image) });
      this.say(null);
    } catch {
      this.say('The scene could not be captured.');
    } finally {
      this.capturing = false;
      this.renderScreenshots();
      this.changed();
    }
  }

  /**
   * The picture a capture takes: the whole window where the host can take
   * one, the scene otherwise. The panel is not part of what is being
   * reported, so it closes for a window capture (the scene takes its width
   * back, as it was before the panel opened) and reopens after it.
   */
  private async picture(): Promise<Blob> {
    if (!this.deps.captureWindow) {
      return this.deps.capture();
    }
    const wasOpen = this.open;
    this.close();
    let image: Blob | null = null;
    try {
      await (this.deps.layoutSettled ?? Layout.settled)();
      image = await this.deps.captureWindow();
    } finally {
      if (wasOpen) {
        this.show();
      }
    }
    return image ?? this.deps.capture();
  }

  /** Take the screenshot at `index` out of the report (its Remove button; tests). */
  removeScreenshot(index: number): void {
    const [removed] = this.shots.splice(index, 1);
    if (removed) {
      URL.revokeObjectURL(removed.url);
    }
    this.renderScreenshots();
    this.changed();
  }

  /**
   * Hand the report over: the first screenshot to the clipboard (first, while the
   * click still counts as the user's), the ticked files to a zip the user
   * saves, then GitHub's new-issue page. A cancelled save stops it with
   * nothing opened, since the issue's text would ask for a file that was
   * never saved.
   */
  async submit(): Promise<void> {
    if (this.busy) {
      return;
    }
    const draft = this.draft;
    const problem = this.problem(draft);
    if (problem) {
      this.say(problem);
      return;
    }
    const chosen = this.chosenFiles();
    this.setBusy(true);
    this.say(null);
    try {
      const handoff: Handoff = {
        url: BugReport.url(draft),
        screenshots: this.shots.map((shot, index) => ({
          ...shot,
          name: BugReport.screenshotName(index, this.shots.length),
          where: 'waiting',
        })),
        archive: null,
      };
      // The clipboard holds one picture: the first now, the others from the list after the hand-off.
      const clipboard = handoff.screenshots.length > 0 && await this.deps.copyImage(handoff.screenshots[0].image);
      if (clipboard) {
        handoff.screenshots[0].where = 'clipboard';
      }
      if (chosen.length > 0) {
        const archive = await this.pack(chosen);
        if (archive.size > BugReport.MAX_ARCHIVE_BYTES) {
          this.say(`The files make a ${BugReport.size(archive.size)} archive, and GitHub takes ${BugReport.size(BugReport.MAX_ARCHIVE_BYTES)} at most. Untick some.`);
          return;
        }
        const outcome = await this.deps.deliver(archive, BugReport.ARCHIVE_NAME, [ZIP_FILTER]);
        if (outcome === 'cancelled') {
          this.say('The files were not saved, so nothing was opened. Save them, or untick them.');
          return;
        }
        if (outcome === 'failed') {
          this.say('The files could not be saved, so nothing was opened.');
          return;
        }
        handoff.archive = { blob: archive, count: chosen.length };
      }
      if (!clipboard) {
        // The clipboard refused the picture (an editor's webview, a browser that asks first): files instead.
        for (const shot of handoff.screenshots) {
          shot.where = await this.save(shot) ? 'file' : 'nowhere';
        }
      }
      this.deps.openExternal(handoff.url);
      this.showDone(handoff);
    } catch (err: any) {
      this.say(err?.message ?? String(err));
    } finally {
      this.setBusy(false);
    }
  }

  // ---------------------------------------------------------------------------

  /** Why the report can't be handed over as it stands; null when it can. */
  private problem(draft: BugReportDraft): string | null {
    if (!draft.title.trim()) {
      return 'Give the report a title.';
    }
    const overflow = BugReport.overflow(draft);
    if (overflow > 0) {
      return `The text is about ${overflow} characters too long for a GitHub link. Shorten the description; you can add the rest on GitHub.`;
    }
    return null;
  }

  /** The form changed: the preview follows, and a text too long for a link says so before the click. */
  private changed(): void {
    const draft = this.draft;
    const title = draft.title.trim();
    this.preview.textContent = `${title || '(no title yet)'}\n\n${BugReport.body(draft) || '(no text yet)'}`;
    const overflow = BugReport.overflow(draft);
    if (overflow > 0) {
      this.say(this.problem({ ...draft, title: title || 'x' }));
    } else if (!this.busy) {
      this.say(null);
    }
    this.submitBtn.disabled = this.busy || overflow > 0;
  }

  private say(message: string | null): void {
    this.notice.textContent = message ?? '';
    this.notice.classList.toggle('hidden', !message);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.submitBtn.disabled = busy || BugReport.overflow(this.draft) > 0;
    this.submitBtn.firstElementChild!.textContent = busy ? 'Preparing…' : 'Continue on GitHub';
  }

  /** The ticked files that are still in the project, in the list's order. */
  private chosenFiles(): BugReportFile[] {
    return this.files.filter((file) => this.selected.has(file.path));
  }

  /** Save a screenshot as a file; whether it was saved. */
  private async save(shot: HandedShot): Promise<boolean> {
    const outcome = await this.deps.deliver(shot.image, shot.name, [PNG_FILTER]);
    return outcome === 'saved' || outcome === 'downloaded';
  }

  private async pack(files: BugReportFile[]): Promise<Blob> {
    const entries: { fileName: string; blob: Blob }[] = [];
    for (const file of files) {
      try {
        entries.push({ fileName: file.path, blob: await this.deps.readFile(file) });
      } catch (err: any) {
        throw new Error(`${file.path} could not be read: ${err?.message ?? String(err)}`);
      }
    }
    return this.deps.archive(entries);
  }

  private async loadFiles(): Promise<void> {
    const turn = ++this.listing;
    try {
      const files = await this.deps.listFiles();
      if (turn !== this.listing) {
        return;
      }
      const current = this.deps.currentFile();
      // The file on screen first: it is the one a report most often needs.
      this.files = [...files].sort((a, b) => Number(b.absPath === current) - Number(a.absPath === current));
      this.filesError = null;
    } catch {
      if (turn !== this.listing) {
        return;
      }
      this.files = [];
      this.filesError = 'The project’s files could not be listed.';
    }
    this.renderFiles();
    this.changed();
  }

  private async loadEnvironment(): Promise<void> {
    try {
      this.environment = await this.deps.environment();
    } catch {
      this.environment = [];
    }
    this.changed();
  }

  private renderScreenshots(): void {
    this.shot.replaceChildren();
    if (this.shots.length > 0) {
      const grid = Dom.el('div', 'grid grid-cols-2 gap-2');
      this.shots.forEach((shot, index) => {
        const cell = Dom.el('figure', 'relative rounded-md border border-base-content/10 bg-base-200 overflow-hidden');
        cell.dataset.shot = String(index);
        const img = document.createElement('img');
        img.src = shot.url;
        img.alt = `Screenshot ${index + 1}`;
        img.className = 'w-full aspect-[16/10] object-contain';
        const remove = Dom.button('btn btn-xs btn-circle absolute top-1 right-1 bg-base-100/90 border border-base-content/15', 'remove-screenshot');
        remove.title = 'Remove';
        remove.setAttribute('aria-label', `Remove screenshot ${index + 1}`);
        remove.appendChild(HubIcons.span(HubIcons.CLOSE, '[&>svg]:size-3.5'));
        remove.addEventListener('click', () => this.removeScreenshot(index));
        const number = Dom.el('figcaption', 'absolute bottom-1 left-1 badge badge-xs bg-base-100/90 border-base-content/15 tabular-nums', String(index + 1));
        cell.append(img, remove, number);
        grid.append(cell);
      });
      this.shot.append(grid);
    }
    const full = this.shots.length >= BugReport.MAX_SCREENSHOTS;
    const capture = Dom.button('btn btn-sm btn-ghost border border-base-content/15 gap-1.5 font-normal text-hub-sm self-start', 'capture');
    const first = this.deps.captureWindow ? 'Capture the window' : 'Capture the scene';
    const label = this.capturing ? 'Capturing…' : this.shots.length === 0 ? first : 'Capture another';
    capture.append(HubIcons.span(ICON_CAMERA, '[&>svg]:size-4'), Dom.el('span', '', label));
    capture.disabled = this.capturing || full;
    capture.addEventListener('click', () => void this.captureScreenshot());
    this.shot.append(capture);
    if (full) {
      this.shot.append(Dom.el('p', NOTE, `A report takes ${BugReport.MAX_SCREENSHOTS} screenshots at most.`));
    }
  }

  private dropScreenshots(): void {
    for (const shot of this.shots) {
      URL.revokeObjectURL(shot.url);
    }
    this.shots = [];
  }

  private renderFiles(): void {
    const chosen = this.chosenFiles();
    this.filesHead.replaceChildren();
    this.filter.classList.toggle('hidden', this.files.length < FILTER_FROM);

    if (this.files.length > 0) {
      const all = document.createElement('input');
      all.type = 'checkbox';
      all.dataset.ref = 'all-files';
      all.className = 'checkbox checkbox-xs';
      all.checked = chosen.length === this.files.length;
      all.indeterminate = chosen.length > 0 && chosen.length < this.files.length;
      all.addEventListener('change', () => {
        this.selected.clear();
        if (all.checked) {
          for (const file of this.files) {
            this.selected.add(file.path);
          }
        }
        this.renderFiles();
        this.changed();
      });
      const allRow = Dom.el('label', 'flex items-center gap-2 text-hub-xs text-base-content/80 cursor-pointer');
      allRow.append(all, Dom.el('span', '', `All ${this.files.length} files`));
      const total = chosen.reduce((sum, file) => sum + file.size, 0);
      const count = Dom.el(
        'span',
        'ml-auto text-hub-2xs text-base-content/55 tabular-nums shrink-0',
        chosen.length === 0 ? 'None ticked' : `${chosen.length} ticked, ${BugReport.size(total)}`,
      );
      count.dataset.ref = 'files-count';
      this.filesHead.append(allRow, count);
    }

    this.fileList.replaceChildren();
    if (this.files.length === 0) {
      this.fileList.append(Dom.el('p', 'px-2.5 py-2 text-hub-xs text-base-content/55', this.filesError ?? 'This project has no files to attach.'));
      return;
    }
    const needle = this.filter.value.trim().toLowerCase();
    const matching = needle ? this.files.filter((file) => file.path.toLowerCase().includes(needle)) : this.files;
    const current = this.deps.currentFile();
    for (const file of matching.slice(0, MAX_ROWS)) {
      this.fileList.append(this.fileRow(file, file.absPath === current));
    }
    if (matching.length === 0) {
      this.fileList.append(Dom.el('p', 'px-2.5 py-2 text-hub-xs text-base-content/55', 'No file matches.'));
    } else if (matching.length > MAX_ROWS) {
      this.fileList.append(Dom.el('p', 'px-2.5 py-2 text-hub-2xs text-base-content/55', `${matching.length - MAX_ROWS} more: filter to find them.`));
    }
  }

  private fileRow(file: BugReportFile, current: boolean): HTMLElement {
    const row = Dom.el('label', 'flex items-center gap-2 px-2.5 py-1 cursor-pointer hover:bg-base-content/5 min-w-0');
    row.dataset.file = file.path;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'checkbox checkbox-xs shrink-0';
    box.checked = this.selected.has(file.path);
    box.addEventListener('change', () => {
      if (box.checked) {
        this.selected.add(file.path);
      } else {
        this.selected.delete(file.path);
      }
      this.renderFiles();
      this.changed();
    });
    const name = Dom.el('span', 'font-mono text-hub-2xs text-base-content/85 truncate', file.path);
    name.title = file.path;
    row.append(box, name);
    if (current) {
      row.append(Dom.el('span', 'badge badge-xs badge-soft badge-primary shrink-0', 'open'));
    }
    row.append(Dom.el('span', 'ml-auto text-hub-2xs text-base-content/50 tabular-nums shrink-0', BugReport.size(file.size)));
    return row;
  }

  /** What is left to do on GitHub, once its page is open. */
  private showDone(handoff: Handoff): void {
    this.form.classList.add('hidden');
    this.done.classList.remove('hidden');
    this.done.replaceChildren();

    const head = Dom.el('div', 'flex flex-col gap-1');
    head.append(
      Dom.el('h3', 'text-hub-md font-medium text-base-content/90', 'Finish the issue on GitHub'),
      Dom.el(
        'p',
        'text-hub-xs text-base-content/70 leading-snug',
        'The new-issue page is open in your browser with the title and the text filled in. Nothing is posted until you submit it there.',
      ),
    );
    this.done.append(head);

    const steps = Dom.el('ol', 'flex flex-col gap-3');
    const shots = handoff.screenshots;
    if (shots.length > 0) {
      const text = Dom.el('p', 'text-hub-xs text-base-content/80 leading-snug');
      const list = Dom.el('ul', 'flex flex-col gap-1.5');
      list.dataset.ref = 'handed-screenshots';
      const render = (): void => {
        text.textContent = BugReportPanel.screenshotSteps(shots);
        list.replaceChildren(...shots.map((shot, index) => this.handedRow(shots, index, render)));
      };
      render();
      steps.append(Dom.step(shots.length === 1 ? 'Add the screenshot' : `Add the ${shots.length} screenshots`, text, list));
    }
    const archive = handoff.archive;
    if (archive) {
      const again = Dom.button('btn btn-xs btn-ghost border border-base-content/15 font-normal text-hub-xs self-start', 'save-again', 'Save it again');
      again.addEventListener('click', () => void this.deps.deliver(archive.blob, BugReport.ARCHIVE_NAME, [ZIP_FILTER]));
      steps.append(Dom.step(
        'Add the files',
        Dom.el(
          'p',
          'text-hub-xs text-base-content/80 leading-snug',
          `${archive.count === 1 ? 'The file you ticked is' : `The ${archive.count} files you ticked are`} in ${BugReport.ARCHIVE_NAME}, saved on this computer: drop it into the issue’s description.`,
        ),
        again,
      ));
    }
    steps.append(Dom.step(
      shots.length > 0 || archive ? 'Submit the issue' : 'Review and submit the issue',
      Dom.el('p', 'text-hub-xs text-base-content/80 leading-snug', 'Read it over on GitHub, then create the issue. It is public once you do.'),
    ));
    this.done.append(steps);

    const actions = Dom.el('div', 'flex flex-col gap-2 mt-auto');
    const reopen = Dom.button('btn btn-sm btn-ghost border border-base-content/15 w-full gap-1.5 font-normal', 'reopen');
    reopen.append(Dom.el('span', '', 'Open GitHub again'), HubIcons.span(HubIcons.EXTERNAL, '[&>svg]:size-4'));
    reopen.addEventListener('click', () => this.deps.openExternal(handoff.url));
    const back = Dom.button('btn btn-sm btn-ghost w-full font-normal text-base-content/75', 'back', 'Back to the report');
    back.addEventListener('click', () => this.showForm());
    const fresh = Dom.button('btn btn-sm btn-ghost w-full font-normal text-base-content/75', 'new-report', 'Start a new report');
    fresh.addEventListener('click', () => {
      this.reset();
      this.showForm();
    });
    actions.append(reopen, back, fresh);
    this.done.append(actions);
  }

  /** What to do with the handed-over screenshots, for where they are now. */
  private static screenshotSteps(shots: HandedShot[]): string {
    const paste = `click into the issue’s description and paste it (${Keys.paste()})`;
    const held = shots.findIndex((shot) => shot.where === 'clipboard');
    if (shots.length === 1) {
      switch (shots[0].where) {
        case 'clipboard':
          return `The screenshot is on the clipboard: ${paste}.`;
        case 'file':
          return `The clipboard didn’t take the screenshot, so it was saved as ${shots[0].name}: drop that file into the issue’s description.`;
        default:
          return 'The screenshot is not on the clipboard and was not saved. Copy or save it here, then add it to the issue’s description.';
      }
    }
    if (held >= 0) {
      return `The clipboard holds one picture at a time. Screenshot ${held + 1} is on it now: ${paste}. Then copy the next one here and paste it the same way.`;
    }
    if (shots.every((shot) => shot.where === 'file')) {
      return 'The clipboard didn’t take the screenshots, so they were saved as files: drop them into the issue’s description.';
    }
    return 'Copy a screenshot here and paste it into the issue’s description, or save it and drop the file there; one at a time.';
  }

  /** One handed-over screenshot: its picture, where it is, and Copy and Save. */
  private handedRow(shots: HandedShot[], index: number, render: () => void): HTMLElement {
    const shot = shots[index];
    const row = Dom.el('li', 'flex items-center gap-2 min-w-0');
    row.dataset.shot = String(index);
    const img = document.createElement('img');
    img.src = shot.url;
    img.alt = '';
    img.className = 'w-14 aspect-[16/10] object-contain rounded border border-base-content/10 bg-base-200 shrink-0';
    const state = shot.where === 'clipboard'
      ? 'On the clipboard'
      : shot.where === 'file'
        ? `Saved as ${shot.name}`
        : '';
    const label = Dom.el('span', 'flex flex-col min-w-0 text-hub-xs text-base-content/85');
    label.append(Dom.el('span', '', `Screenshot ${index + 1}`));
    if (state) {
      const stateEl = Dom.el('span', `text-hub-2xs truncate ${shot.where === 'clipboard' ? 'text-primary' : 'text-base-content/55'}`, state);
      stateEl.title = state;
      label.append(stateEl);
    }
    const button = 'btn btn-xs btn-ghost border border-base-content/15 font-normal text-hub-xs shrink-0';
    const copy = Dom.button(`${button} ml-auto`, 'copy-screenshot', shot.where === 'clipboard' ? 'Copy again' : 'Copy');
    copy.addEventListener('click', async () => {
      if (await this.deps.copyImage(shot.image)) {
        // The clipboard holds this one now, and no longer the one it held.
        for (const other of shots) {
          if (other.where === 'clipboard') {
            other.where = 'waiting';
          }
        }
        shot.where = 'clipboard';
      } else if (await this.save(shot)) {
        shot.where = 'file';
      }
      render();
    });
    const save = Dom.button(button, 'save-screenshot', 'Save');
    save.addEventListener('click', async () => {
      if (await this.save(shot) && shot.where !== 'clipboard') {
        shot.where = 'file';
      }
      render();
    });
    row.append(img, label, copy, save);
    return row;
  }

  private showForm(): void {
    this.done.classList.add('hidden');
    this.form.classList.remove('hidden');
    this.title.focus();
  }

  /** An empty form again. */
  private reset(): void {
    this.title.value = '';
    this.description.value = '';
    this.selected.clear();
    this.filter.value = '';
    this.dropScreenshots();
    this.renderScreenshots();
    this.renderFiles();
    this.changed();
  }

  /** The window changed size: cover the scene below 640 px, or stop covering it. */
  private readonly onResize = (): void => {
    if (this.open) {
      this.deps.slot.layout();
    }
  };
}

/** The clipboard, for the screenshots. */
export class BugReportClipboard {
  /** Put a PNG on the clipboard; false when the browser has no image clipboard or refuses the write. */
  static async copyImage(image: Blob): Promise<boolean> {
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        return false;
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
      return true;
    } catch {
      return false;
    }
  }
}

class Layout {
  /** The left slot's width animation (180 ms) has run and the scene has drawn at its new size. */
  static async settled(): Promise<void> {
    await new Promise((resolve) => window.setTimeout(resolve, 260));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
}

class Keys {
  /** The paste shortcut as this machine writes it. */
  static paste(): string {
    return /mac/i.test(navigator.platform ?? '') ? '⌘V' : 'Ctrl+V';
  }
}

class Dom {
  static el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) {
      el.textContent = text;
    }
    return el;
  }

  static button(className: string, ref: string, text?: string): HTMLButtonElement {
    const button = Dom.el('button', className, text);
    button.type = 'button';
    button.dataset.ref = ref;
    return button;
  }

  /** A labelled block of the form. */
  static section(label: string, ...children: HTMLElement[]): HTMLElement {
    const section = Dom.el('section', SECTION);
    section.append(Dom.el('h3', LABEL, label), ...children);
    return section;
  }

  /** One numbered thing left to do on GitHub. */
  static step(title: string, ...children: HTMLElement[]): HTMLElement {
    const item = Dom.el('li', 'flex flex-col gap-1.5 rounded-md border border-base-content/10 px-2.5 py-2');
    item.append(Dom.el('h4', 'text-hub-xs font-medium text-base-content/90', title), ...children);
    return item;
  }
}
