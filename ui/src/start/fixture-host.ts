import type {
  Appearance,
  ApplyPinResult,
  EngineOptions,
  HelloReply,
  StartFeed,
  StartProject,
  StartProjectList,
  StartScreenHost,
  UpgradeDiff,
  UpgradePreview,
  UpgradeProgress,
  WindowState,
} from './host';
import { START_SCREEN_PROTOCOL } from './host';

/**
 * A stand-in for the desktop shell, so the start screen can be worked on with
 * `npm run dev:ui` and HMR instead of a packaged app:
 *
 *   http://localhost:3200/start.html?host=fixture
 *
 * Dev builds only — `main.ts` imports it behind `import.meta.env.DEV`, so it is
 * not in `ui/dist-start`. Every state the page can be in is one query
 * parameter away:
 *
 *   recents=0|1|12|mixed        how many recent projects (mixed: one per chip state)
 *   feed=normal|hostile|empty|offline
 *   state=home|resolving|downloading|starting|failed
 *   theme=fluidcad-dark|fluidcad-light
 *
 * Actions behave plausibly: opening walks through resolve → download → start
 * (a project named `broken-*` fails), Cancel returns home, and the engine
 * dialog compares to identical (0.0.45), changed (0.0.44), broken (0.0.43) or
 * a download error (anything else).
 */

const HOME = '/home/you';
const LATEST = '0.0.45';

/** A square-ish picture standing in for a real preview, in the proportions previews come in. */
function fakeThumbnail(width: number, height: number, hue: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<polygon points="${width / 2},4 ${width - 4},${height / 3} ${width / 2},${(2 * height) / 3} 4,${height / 3}" fill="hsl(${hue} 70% 70%)"/>` +
    `<polygon points="4,${height / 3} ${width / 2},${(2 * height) / 3} ${width / 2},${height - 4} 4,${(2 * height) / 3}" fill="hsl(${hue} 70% 50%)"/>` +
    `<polygon points="${width - 4},${height / 3} ${width / 2},${(2 * height) / 3} ${width / 2},${height - 4} ${width - 4},${(2 * height) / 3}" fill="hsl(${hue} 70% 38%)"/>` +
    '</svg>';
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function project(name: string, overrides: Partial<StartProject>): StartProject {
  return {
    path: `${HOME}/cad/${name}`,
    name,
    engine: LATEST,
    engineSource: 'pin',
    latest: true,
    upgradeTo: null,
    lastOpenedAt: hoursAgo(1),
    open: false,
    thumbnail: null,
    ...overrides,
  };
}

/** One project per engine-chip state, plus a failing one and a preview-less one. */
function mixedProjects(): StartProject[] {
  return [
    project('bracket', { thumbnail: fakeThumbnail(200, 200, 212), lastOpenedAt: hoursAgo(0.001) }),
    project('gearbox-housing', { open: true, thumbnail: fakeThumbnail(160, 240, 30), lastOpenedAt: hoursAgo(0.5) }),
    project('lantern', { engine: '0.0.42', latest: false, upgradeTo: LATEST, thumbnail: fakeThumbnail(240, 140, 140), lastOpenedAt: hoursAgo(5) }),
    project('clamp', { engine: '0.0.44', latest: false, thumbnail: fakeThumbnail(200, 200, 280), lastOpenedAt: hoursAgo(26) }),
    project('fork', { engine: '0.0.41', engineSource: 'own', latest: false, lastOpenedAt: hoursAgo(24 * 4) }),
    project('scratch', { engine: null, engineSource: null, latest: false, lastOpenedAt: hoursAgo(24 * 40) }),
    project('broken-assembly', { path: `/mnt/shared/projects/with a very long folder name/broken-assembly`, lastOpenedAt: hoursAgo(24 * 9) }),
  ];
}

function projectsFor(recents: string | null): StartProject[] {
  if (recents === '0') {
    return [];
  }
  if (recents === '1') {
    return [project('bracket', { thumbnail: fakeThumbnail(200, 200, 212) })];
  }
  if (recents === '12') {
    return Array.from({ length: 12 }, (_, i) =>
      project(`part-${i + 1}`, { thumbnail: i % 3 === 2 ? null : fakeThumbnail(200, 160 + (i % 4) * 30, (i * 37) % 360), lastOpenedAt: hoursAgo(i * 7) }),
    );
  }
  return mixedProjects();
}

const TUTORIALS: StartFeed['tutorials'] = [
  { id: 't1', title: 'Your first part', description: 'Sketch, extrude and fillet a mounting bracket.', url: 'https://fluidcad.io/docs/tutorials/bracket', thumbnail: fakeThumbnail(200, 200, 200) },
  { id: 't2', title: 'Desk organizer', description: 'Shells, patterns and a lid that fits.', url: 'https://fluidcad.io/docs/tutorials/desk-organizer', thumbnail: fakeThumbnail(200, 200, 50) },
  { id: 't3', title: 'Assemblies and mates', description: 'Put parts together and make them move, with a description long enough to wrap onto a third line and get clamped.', url: 'https://fluidcad.io/docs/tutorials/hinge', thumbnail: '' },
];

const HOSTILE_BODY =
  '<p>FluidCAD 0.0.46 is out. <a href="https://fluidcad.io/blog" onclick="alert(1)">Read the notes</a>.' +
  '<script>alert("script")</script><img src="x" onerror="alert(\'img\')">' +
  '<a href="javascript:alert(\'js\')">sneaky link</a> <b style="color:red">bold</b>' +
  '<iframe src="https://example.com"></iframe><svg><circle r="5"/></svg><form><button>submit</button></form></p>';

function feedFor(kind: string | null): StartFeed | null {
  switch (kind) {
    case 'empty':
      return { tutorials: [], notifications: [] };
    case 'offline':
      return null;
    case 'hostile':
      return { tutorials: TUTORIALS, notifications: [{ id: 'n-hostile', body: HOSTILE_BODY, expiresAt: null, minVersion: null }] };
    default:
      return {
        tutorials: TUTORIALS,
        notifications: [
          { id: 'n1', body: '<p><b>New:</b> the start screen now lives in the main window. <a href="https://fluidcad.io/blog">What changed</a></p>', expiresAt: null, minVersion: null },
        ],
      };
  }
}

function initialState(kind: string | null, projects: StartProject[]): WindowState {
  const target = { path: projects[0]?.path ?? `${HOME}/cad/bracket`, name: projects[0]?.name ?? 'bracket' };
  switch (kind) {
    case 'resolving':
      return { phase: 'opening', project: target, status: { step: 'resolving' } };
    case 'downloading':
      return { phase: 'opening', project: target, status: { step: 'downloading', version: '0.0.42', receivedBytes: 12_400_000, totalBytes: 31_800_000 } };
    case 'starting':
      return { phase: 'opening', project: target, status: { step: 'starting', version: '0.0.41', source: 'project' } };
    case 'failed':
      return { phase: 'failed', project: target, message: 'Engine 0.0.39 predates the desktop app (it needs 0.0.41 or newer).\nOpen the project with `npx fluidcad serve` instead, or change its engine.' };
    default:
      return { phase: 'home' };
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FixtureStartHost implements StartScreenHost {
  private projects: StartProject[];
  private readonly feedData: StartFeed | null;
  private state: WindowState;
  private readonly theme: string;
  private readonly stateHandlers: ((state: WindowState) => void)[] = [];
  private readonly changedHandlers: (() => void)[] = [];
  private readonly progressHandlers: ((progress: UpgradeProgress) => void)[] = [];
  /** Bumped by Cancel, so an open in flight notices it was abandoned. */
  private openGeneration = 0;

  constructor(params: URLSearchParams) {
    this.projects = projectsFor(params.get('recents'));
    this.feedData = feedFor(params.get('feed'));
    this.state = initialState(params.get('state'), this.projects);
    this.theme = params.get('theme') ?? document.documentElement.dataset.theme ?? 'fluidcad-dark';
  }

  async hello(protocol: number): Promise<HelloReply> {
    return { ok: protocol === START_SCREEN_PROTOCOL, appVersion: LATEST, platform: 'linux', home: HOME };
  }

  async windowState(): Promise<WindowState> {
    return this.state;
  }

  onWindowState(handler: (state: WindowState) => void): void {
    this.stateHandlers.push(handler);
  }

  async cancelOpen(): Promise<void> {
    this.openGeneration += 1;
    this.setState({ phase: 'home' });
  }

  async retryOpen(): Promise<void> {
    if (this.state.phase === 'failed') {
      void this.walkOpen(this.state.project);
    }
  }

  async appearance(): Promise<Appearance> {
    return { theme: this.theme };
  }

  async list(): Promise<StartProjectList> {
    return { projects: this.projects.map((entry) => ({ ...entry })) };
  }

  async feed(): Promise<StartFeed> {
    await delay(150);
    if (!this.feedData) {
      throw new Error('offline');
    }
    return this.feedData;
  }

  async dismissNotification(id: string): Promise<void> {
    console.info(`[fixture] dismissed notification ${id}`);
  }

  async open(path: string): Promise<void> {
    const entry = this.projects.find((candidate) => candidate.path === path);
    if (entry?.open) {
      console.info(`[fixture] would focus the window that has ${path}`);
      return;
    }
    await this.walkOpen({ path, name: entry?.name ?? path.split('/').pop() ?? path });
  }

  async openDialog(): Promise<void> {
    await delay(300);
    console.info('[fixture] the native Open dialog was cancelled');
  }

  async newProject(): Promise<void> {
    await delay(300);
    console.info('[fixture] the native New Project dialog was cancelled');
  }

  async forget(path: string): Promise<void> {
    this.projects = this.projects.filter((entry) => entry.path !== path);
    this.changed();
  }

  async openLink(url: string): Promise<void> {
    console.info(`[fixture] would open ${url} in the browser`);
  }

  async engineOptions(path: string): Promise<EngineOptions> {
    const entry = this.projects.find((candidate) => candidate.path === path);
    return {
      current: entry?.engine ?? null,
      currentSource: entry?.engineSource ?? null,
      latest: LATEST,
      choices: [
        { version: LATEST, builtin: true, installed: true },
        { version: '0.0.44', builtin: false, installed: true },
        { version: '0.0.43', builtin: false, installed: true },
      ],
    };
  }

  async previewUpgrade(path: string, version: string): Promise<UpgradePreview> {
    const entry = this.projects.find((candidate) => candidate.path === path);
    const from = entry?.engine ?? LATEST;
    for (const message of [`Downloading engine ${version}… 40%`, `Building with the current engine ${from}…`, `Building with engine ${version}…`]) {
      await delay(500);
      this.progress(path, message);
    }
    await delay(400);
    this.progress(path, '');
    const diff = this.diffFor(from, version);
    return diff ? { diff } : { error: `Engine ${version} could not be downloaded: no release has that version.` };
  }

  async applyPin(path: string, version: string): Promise<ApplyPinResult> {
    await delay(600);
    if (!/^0\.0\.4[3-5]$/.test(version)) {
      return { ok: false, error: `Engine ${version} could not be downloaded: no release has that version.` };
    }
    this.projects = this.projects.map((entry) =>
      entry.path === path ? { ...entry, engine: version, engineSource: 'pin', latest: version === LATEST, upgradeTo: null } : entry,
    );
    this.changed();
    return { ok: true };
  }

  onUpgradeProgress(handler: (progress: UpgradeProgress) => void): void {
    this.progressHandlers.push(handler);
  }

  onChanged(handler: () => void): void {
    this.changedHandlers.push(handler);
  }

  private diffFor(from: string, to: string): UpgradeDiff | null {
    const models = ['bracket.part.js', 'parts/lid.part.js', 'assembly.assembly.js'];
    if (to === LATEST) {
      return { from, to, identical: true, skipped: [], models: models.map((file) => ({ file, status: 'identical', notes: [] })) };
    }
    if (to === '0.0.44') {
      return {
        from,
        to,
        identical: false,
        skipped: ['extra/one.part.js', 'extra/two.part.js'],
        models: [
          { file: models[0], status: 'changed', notes: ['Volume 12 400.0 mm³ → 12 398.2 mm³', 'Fillet 2 now rounds 4 edges (was 3)'] },
          { file: models[1], status: 'identical', notes: [] },
          { file: models[2], status: 'fixed', notes: ['Built without errors (was: Mate 3 failed to solve)'] },
        ],
      };
    }
    if (to === '0.0.43') {
      return {
        from,
        to,
        identical: false,
        skipped: [],
        models: [
          { file: models[0], status: 'broken', notes: ['Extrude 1: the sketch has no closed region'] },
          { file: models[1], status: 'identical', notes: [] },
        ],
      };
    }
    return null;
  }

  private async walkOpen(target: { path: string; name: string }): Promise<void> {
    const generation = ++this.openGeneration;
    const live = () => generation === this.openGeneration;
    this.setState({ phase: 'opening', project: target, status: { step: 'resolving' } });
    await delay(500);
    const total = 31_800_000;
    for (let received = 0; received <= total && live(); received += 3_180_000) {
      this.setState({ phase: 'opening', project: target, status: { step: 'downloading', version: '0.0.42', receivedBytes: received, totalBytes: total } });
      await delay(180);
    }
    if (!live()) {
      return;
    }
    this.setState({ phase: 'opening', project: target, status: { step: 'starting', version: '0.0.42', source: 'downloaded' } });
    await delay(900);
    if (!live()) {
      return;
    }
    if (target.name.startsWith('broken')) {
      this.setState({ phase: 'failed', project: target, message: 'The FluidCAD engine exited with code 1 before it was ready.\n\nError: EADDRINUSE 127.0.0.1:3100' });
      return;
    }
    console.info(`[fixture] ${target.name} is ready; the desktop app would now show the project`);
    this.setState({ phase: 'home' });
  }

  private setState(state: WindowState): void {
    this.state = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }

  private changed(): void {
    for (const handler of this.changedHandlers) {
      handler();
    }
  }

  private progress(workspacePath: string, message: string): void {
    for (const handler of this.progressHandlers) {
      handler({ workspacePath, message });
    }
  }
}
