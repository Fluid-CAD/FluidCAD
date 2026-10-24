import {
  HUB_APP_PUBLISH_RUNNING,
  type HubAppPublishPackage,
  type HubAppPublishRequest,
  type HubAppPublishState,
  type HubPublishStatus,
  type HubPublishSummary,
  type HubVersionStatus,
  type PublishClient,
  type PublishRefusal,
} from '../../api';
import type { HubTimers } from '../hub/hub-panel-state';
import { PackageText } from '../packages/packages-state';

/** Which call is in flight, so the dialog's buttons wait. */
export type PublishBusy = 'load' | 'status' | 'start' | 'confirm' | 'cancel' | 'withdraw' | 'bump';

/** The outcome of an action outside a session (a withdraw, a bump, a refusal), under the dialog's body. */
export type PublishNotice = { tone: 'info' | 'error'; text: string; code?: string };

export type PublishSnapshot = {
  /** The workspace's `package` block, or its problem (U7); null until read. */
  pkg: HubAppPublishPackage | null;
  /** The engine didn't answer the block. */
  pkgRefusal: PublishRefusal | null;
  /** The hub's origin, once known (`GET api/hub/status`, then every session names it). */
  hub: string | null;
  /** Where the package stands on the hub; null until read, or while it can't be. */
  status: HubPublishStatus | null;
  /** Why the status couldn't be read: `signed-out`, `hub-unreachable`, `not-a-package`… */
  statusRefusal: PublishRefusal | null;
  /** The session running or last ended in the engine, as the page follows it. */
  publish: HubAppPublishState | null;
  busy: PublishBusy | null;
  notice: PublishNotice | null;
};

export type PublishStateDeps = {
  /** The hub's origin for the sentences (`GET api/hub/status`); absent, the first session names it. */
  hubUrl?(): Promise<string | null>;
  /** Timers for following a session (tests). */
  timers?: HubTimers;
};

type Listener = (snapshot: PublishSnapshot) => void;
type EndedListener = (publish: HubAppPublishState) => void;

/**
 * What the Publish dialog knows (ui-packages-plan N4): the workspace's
 * package, where it stands on the hub, and the publish session the engine
 * runs for it (`PublishSession`, over `/api/publish/*`), followed the way
 * the Hub panel follows a sign-in.
 *
 * - {@link load}: the block (U7's problem first), the hub's origin, the
 *   status (401 `signed-out` is a state of its own, not an error), and a
 *   session left running in the engine (a reload while one waited to be
 *   confirmed), which is followed again.
 * - {@link start} / {@link confirm} / {@link cancel}: the session's own
 *   calls; `GET api/publish` is read every {@link POLL_MS} while it runs,
 *   and {@link onEnded} hears when a session this page followed ends.
 * - {@link bump} and {@link withdraw}: the actions a refusal names; both
 *   clear a `failed` session they answer, so the dialog is back on Publish.
 */
export class PublishState {
  static readonly POLL_MS = 250;

  private snapshot: PublishSnapshot = {
    pkg: null,
    pkgRefusal: null,
    hub: null,
    status: null,
    statusRefusal: null,
    publish: null,
    busy: null,
    notice: null,
  };
  private readonly listeners = new Set<Listener>();
  private readonly endedListeners = new Set<EndedListener>();
  private readonly timers: HubTimers;
  /** The session followed by polling; null while none runs. */
  private following: string | null = null;
  private timer: unknown = null;
  /** The latest load; an older one's answers are dropped. */
  private ticket = 0;

  constructor(readonly client: PublishClient, private readonly deps: PublishStateDeps = {}) {
    this.timers = deps.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as number) };
  }

  get current(): PublishSnapshot {
    return this.snapshot;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A session this page followed (started here, or found running) ended: `done`, `declined` or `failed`. */
  onEnded(fn: EndedListener): () => void {
    this.endedListeners.add(fn);
    return () => this.endedListeners.delete(fn);
  }

  /** Whether a session is running in the engine, as last seen. */
  get running(): boolean {
    return this.snapshot.publish !== null && PublishState.isRunning(this.snapshot.publish);
  }

  /** The dialog opened: read everything, and follow a session left running. */
  async load(): Promise<void> {
    const ticket = ++this.ticket;
    this.update({ busy: 'load', notice: null });
    const [info, hub] = await Promise.all([this.client.packageInfo(), this.deps.hubUrl?.() ?? Promise.resolve(null)]);
    if (ticket !== this.ticket) {
      return;
    }
    if (info.ok === false) {
      this.update({ pkg: null, pkgRefusal: info, hub: hub ?? this.snapshot.hub, busy: null });
      return;
    }
    this.update({ pkg: info.package, pkgRefusal: null, hub: hub ?? this.snapshot.hub });
    if (info.package.package) {
      await this.readStatus(ticket);
      if (ticket !== this.ticket) {
        return;
      }
    } else {
      this.update({ status: null, statusRefusal: null });
    }
    const session = await this.client.current();
    if (ticket !== this.ticket) {
      return;
    }
    if (session.ok !== false) {
      this.update({ publish: session.publish, hub: session.publish?.hub ?? this.snapshot.hub });
      if (session.publish && PublishState.isRunning(session.publish)) {
        this.follow(session.publish);
      }
    }
    this.update({ busy: null });
  }

  /** Read the status again (a sign-in finished, a Try again). */
  async reloadStatus(): Promise<void> {
    if (!this.snapshot.pkg?.package) {
      return;
    }
    const ticket = this.ticket;
    this.update({ busy: 'status' });
    await this.readStatus(ticket);
    if (ticket === this.ticket) {
      this.update({ busy: null });
    }
  }

  /** The dialog closed: stop following; {@link load} picks a running session up again. */
  stopFollowing(): void {
    this.following = null;
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stopFollowing();
    this.listeners.clear();
    this.endedListeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** Check (dry run) or Publish: the engine answers once the preflight is through. */
  async start(request: HubAppPublishRequest): Promise<void> {
    if (this.snapshot.busy !== null || this.running) {
      return;
    }
    this.update({ busy: 'start', notice: null });
    const answer = await this.client.start(request);
    if (answer.ok === false) {
      if (answer.code === 'publish-running') {
        // Another page started one: follow it rather than refuse.
        const session = await this.client.current();
        if (session.ok !== false && session.publish) {
          this.update({ publish: session.publish, hub: session.publish.hub, busy: null });
          if (PublishState.isRunning(session.publish)) {
            this.follow(session.publish);
          }
          return;
        }
      }
      this.update({ busy: null, notice: PublishState.refused(answer) });
      return;
    }
    this.update({ publish: answer.publish, hub: answer.publish.hub, busy: null });
    if (PublishState.isRunning(answer.publish)) {
      this.follow(answer.publish);
    } else {
      this.ended(answer.publish);
    }
  }

  /** Upload what the session packed. */
  async confirm(): Promise<void> {
    if (this.snapshot.busy !== null || this.snapshot.publish?.status !== 'awaiting-confirm') {
      return;
    }
    this.update({ busy: 'confirm' });
    const answer = await this.client.confirm();
    if (answer.ok === false) {
      this.update({ busy: null, notice: PublishState.refused(answer) });
      await this.resync();
      return;
    }
    this.update({ publish: answer.publish, busy: null });
    if (PublishState.isRunning(answer.publish)) {
      this.follow(answer.publish);
    } else {
      this.ended(answer.publish);
    }
  }

  /** Stop the session before anything is sent. */
  async cancel(): Promise<void> {
    if (this.snapshot.busy !== null || !this.running) {
      return;
    }
    this.update({ busy: 'cancel' });
    const answer = await this.client.cancel();
    if (answer.ok === false) {
      this.update({ busy: null, notice: PublishState.refused(answer) });
      return;
    }
    this.update({ publish: answer.publish, busy: null });
    if (answer.publish && !PublishState.isRunning(answer.publish)) {
      this.ended(answer.publish);
    }
  }

  /** Withdraw the draft or the version in review (the dialog asked first); an ended session's card goes with it. */
  async withdraw(): Promise<void> {
    if (this.snapshot.busy !== null) {
      return;
    }
    this.update({ busy: 'withdraw', notice: null });
    const answer = await this.client.withdraw();
    if (answer.ok === false) {
      this.update({ busy: null, notice: PublishState.refused(answer) });
      return;
    }
    const name = this.snapshot.pkg?.package?.name ?? answer.withdrawn.name;
    // The withdraw answers an ended session (the refusal it names, or the upload that made the draft): a clean slate.
    const publish = this.running ? this.snapshot.publish : null;
    this.update({ publish, notice: { tone: 'info', text: `Withdrew ${name}@${answer.withdrawn.version} from ${this.snapshot.hub ?? 'the hub'}.` } });
    await this.readStatus(this.ticket);
    this.update({ busy: null });
  }

  /** Bump the block's version (`patch`, `minor`, `major` or a version); the header follows. */
  async bump(spec: string): Promise<void> {
    if (this.snapshot.busy !== null || this.running) {
      return;
    }
    this.update({ busy: 'bump', notice: null });
    const answer = await this.client.bumpVersion(spec);
    if (answer.ok === false) {
      this.update({ busy: null, notice: PublishState.refused(answer) });
      return;
    }
    const info = await this.client.packageInfo();
    const publish = PublishState.answers(this.snapshot.publish, ['version-exists', 'version-not-greater']) ? null : this.snapshot.publish;
    this.update({
      pkg: info.ok === false ? this.snapshot.pkg : info.package,
      publish,
      busy: null,
      notice: { tone: 'info', text: `${answer.change.name} is ${answer.change.to} now (was ${answer.change.from}).` },
    });
  }

  // ---------------------------------------------------------------------------

  private async readStatus(ticket: number): Promise<void> {
    const answer = await this.client.status();
    if (ticket !== this.ticket) {
      return;
    }
    if (answer.ok === false) {
      this.update({ status: null, statusRefusal: answer });
    } else {
      this.update({ status: answer.status, statusRefusal: null });
    }
  }

  /** The engine's session after a refused call (a confirm that came too late): read it as it is. */
  private async resync(): Promise<void> {
    const session = await this.client.current();
    if (session.ok !== false) {
      this.update({ publish: session.publish });
      if (session.publish && PublishState.isRunning(session.publish) && this.following !== session.publish.id) {
        this.follow(session.publish);
      }
    }
  }

  private follow(publish: HubAppPublishState): void {
    this.following = publish.id;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
    }
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.poll();
    }, PublishState.POLL_MS);
  }

  private async poll(): Promise<void> {
    const following = this.following;
    if (following === null) {
      return;
    }
    const answer = await this.client.current();
    if (this.following !== following) {
      return;
    }
    if (answer.ok === false || !answer.publish) {
      // The engine didn't answer this time: ask again.
      this.schedule();
      return;
    }
    if (answer.publish.id !== following) {
      // A session this page didn't start replaced it: show it, follow it while it runs.
      this.update({ publish: answer.publish });
      if (PublishState.isRunning(answer.publish)) {
        this.follow(answer.publish);
      } else {
        this.stopFollowing();
      }
      return;
    }
    this.update({ publish: answer.publish });
    if (PublishState.isRunning(answer.publish)) {
      this.schedule();
      return;
    }
    this.ended(answer.publish);
  }

  /** A session this page followed ended: stop following it, then tell whoever listens. */
  private ended(publish: HubAppPublishState): void {
    this.stopFollowing();
    for (const fn of this.endedListeners) {
      fn(publish);
    }
  }

  private update(patch: Partial<PublishSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) {
      fn(this.snapshot);
    }
  }

  /** Whether the session ended `failed` with one of `codes` (the action that answers it clears it). */
  private static answers(publish: HubAppPublishState | null, codes: string[]): boolean {
    return publish?.status === 'failed' && publish.error !== null && codes.includes(publish.error.code);
  }

  private static refused(refusal: PublishRefusal): PublishNotice {
    return { tone: 'error', text: refusal.error, code: refusal.code };
  }

  static isRunning(publish: HubAppPublishState): boolean {
    return HUB_APP_PUBLISH_RUNNING.includes(publish.status);
  }
}

/**
 * How the dialog words publishing: `PublishView` in `bin/commands/publish.js`
 * (the CLI), sentence for sentence, with buttons where the CLI names
 * commands.
 */
export class PublishText {
  /** `@acme/kit@0.1.0`. */
  static at(name: string, version: string): string {
    return `${name}@${version}`;
  }

  /** The summary's first line: `Publishing @acme/kit 0.1.0 on http://… as @acme:`. */
  static summaryTitle(summary: HubPublishSummary): string {
    return `${summary.dryRun ? 'Checking' : 'Publishing'} ${summary.name} ${summary.version} on ${summary.hub} as @${summary.handle}:`;
  }

  /** The folder rows: `features/` → `2 features`, …, `docs/` only when there are pages. */
  static summaryRows(summary: HubPublishSummary): [string, string][] {
    const { contents } = summary;
    const rows: [string, string][] = [
      ['features/', PublishText.count(contents.features.length, 'feature')],
      ['parts/', PublishText.count(contents.parts.length, 'part')],
      ['assemblies/', PublishText.count(contents.assemblies.length, 'assembly', 'assemblies')],
    ];
    if (contents.docs?.length > 0) {
      rows.push(['docs/', PublishText.count(contents.docs.length, 'page')]);
    }
    return rows;
  }

  /** `5 files, 1.1 kB`. */
  static summarySize(summary: HubPublishSummary): string {
    return `${PublishText.count(summary.files, 'file')}, ${PackageText.bytes(summary.size)}`;
  }

  /** What happens after the upload. */
  static becomes(summary: Pick<HubPublishSummary, 'becomes' | 'replacesDraft' | 'version'>): string {
    if (summary.replacesDraft) {
      return `replaces the draft of ${summary.version} on the hub (the wizard keeps what you filled in)`;
    }
    if (summary.becomes === 'draft') {
      return 'first version: you finish publishing in your browser (screenshots, license, release notes)';
    }
    return 'goes straight to review: an admin approves it before it is public';
  }

  /** `2 warnings (nothing is refused for them):`. */
  static warningsLead(count: number): string {
    return `${PublishText.count(count, 'warning')} (nothing is refused for them):`;
  }

  /** The dry run's line. */
  static dryRun(publish: HubAppPublishState): string {
    const result = publish.result!;
    const next = result.status === 'draft' ? 'a draft you finish in your browser' : 'submitted for review';
    return `Dry run: ${publish.hub} accepts ${PublishText.at(result.name, result.version)} · ${result.integrity} · it would be ${next}. Nothing was stored.`;
  }

  /** `Uploading 12.3 kB of 48.6 kB (25%)`. */
  static uploading(progress: { sent: number; total: number }): string {
    const percent = progress.total === 0 ? 100 : Math.floor((progress.sent / progress.total) * 100);
    return `Uploading ${PackageText.bytes(progress.sent)} of ${PackageText.bytes(progress.total)} (${percent}%)`;
  }

  /** The withdraw confirmation: `… is the draft on <hub>. Withdrawing deletes it there; its number is free again.` */
  static withdrawWarning(name: string, open: Pick<HubVersionStatus, 'version' | 'status'>, hub: string): string {
    const state = open.status === 'draft' ? 'the draft' : 'in review';
    return `${PublishText.at(name, open.version)} is ${state} on ${hub}. Withdrawing deletes it there; its number is free again.`;
  }

  /** The Manage page of a package on the hub: `<hub>/@scope/name/manage`. */
  static manageUrl(hub: string, name: string): string {
    return `${hub.replace(/\/$/, '')}/${name}/manage`;
  }

  /** `0.1.0` bumped by `patch` → `0.1.1`; null when the version isn't `x.y.z`. */
  static bumped(version: string, part: 'patch' | 'minor' | 'major'): string | null {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
    if (!match) {
      return null;
    }
    const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (part === 'major') {
      return `${major + 1}.0.0`;
    }
    if (part === 'minor') {
      return `${major}.${minor + 1}.0`;
    }
    return `${major}.${minor}.${patch + 1}`;
  }

  /** `2026-10-24T…` → `2026-10-24`. */
  static day(iso: string): string {
    return iso.slice(0, 10);
  }

  static count(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
  }
}
