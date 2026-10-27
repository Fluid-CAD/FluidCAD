// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubPackage, PackageTarget } from '../src/api';
import { FeatureParamTable } from '../src/ui/hub/feature-param-table';
import { HubInstallControl, HubInstallTarget } from '../src/ui/hub/hub-install-control';
import { HubMarkdown } from '../src/ui/hub/hub-markdown';
import { HubPackageView } from '../src/ui/hub/hub-package-view';
import { FakeHubClient } from './fixtures/fake-hub-client';
import { FakePackagesClient, settle } from './fixtures/fake-packages-client';

// A package in the Hub panel (hub-plan H11): the header, the tabs, the
// parameter table from the version's manifest (decision 4), parts with
// Preview on the hub, versions, the README as a Markdown subset (decision
// 8), and the Install control: no consent dialog, the dropdown selects
// the target (decision 6 as corrected on 2026-10-12), and "Upgrade to X"
// moves the pin (decision 7).

const views: HubPackageView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.innerHTML = '';
});

async function mount(pkg: HubPackage = FakeHubClient.pkg(), options: { projectOpen?: boolean; setting?: PackageTarget } = {}) {
  const hub = new FakeHubClient();
  hub.packages.set(pkg.name, pkg);
  hub.versions.set('@acme/feature-tests@0.1.1', FakeHubClient.version());
  const packages = new FakePackagesClient();
  const openExternal = vi.fn();
  const onInstalled = vi.fn();
  const onBack = vi.fn();
  const onPublisher = vi.fn();
  const projectOpen = options.projectOpen ?? true;
  const target = new HubInstallTarget(() => options.setting ?? 'library', () => projectOpen);
  const view = new HubPackageView({
    hub,
    packages,
    target,
    engine: () => ({ engine: '0.0.46', sdk: 1 }),
    hubUrl: () => 'http://localhost:8787',
    projectOpen: () => projectOpen,
    openExternal,
    onBack,
    onInstalled,
    onPublisher,
    signIn: vi.fn(),
    now: () => Date.parse('2026-10-12T12:00:00Z'),
  });
  views.push(view);
  document.body.appendChild(view.el);
  await view.show(pkg.name);
  await settle();
  const $ = <T extends Element = HTMLElement>(selector: string) => view.el.querySelector<T>(selector);
  const $$ = (selector: string) => [...view.el.querySelectorAll<HTMLElement>(selector)];
  const tab = async (name: string) => {
    $(`[data-tab="${name}"]`)!.click();
    await settle();
  };
  const install = () => $<HTMLButtonElement>('[data-ref="install"]')!;
  return { hub, packages, view, target, openExternal, onInstalled, onBack, onPublisher, $, $$, tab, install };
}

describe('the header', () => {
  it('names the package, its latest version, publisher, marks, screenshots and facts', async () => {
    const h = await mount(FakeHubClient.pkg({ local: { installed: ['0.1.0'], pinned: '0.1.0', updateAvailable: '0.1.1' } }));
    expect(h.$('[data-ref="name"]')!.textContent).toBe('@acme/feature-tests');
    expect(h.$('[data-ref="latest"]')!.textContent).toBe('0.1.1');
    expect(h.$('[data-ref="byline"]')!.textContent).toBe('published 1 day ago · 2 installs');
    expect(h.$$('[data-ref="marks"] [data-mark]').map((m) => m.textContent)).toEqual(['installed 0.1.0', 'pinned 0.1.0', 'update available']);
    expect(h.$<HTMLImageElement>('[data-ref="media"] figure img')!.getAttribute('src')).toBe('api/hub/media/@acme/feature-tests/card-1');
    h.$('[data-media="shot-2"]')!.click();
    expect(h.$<HTMLImageElement>('[data-ref="media"] figure img')!.getAttribute('src')).toBe('api/hub/media/@acme/feature-tests/shot-2');
    expect(h.$('[data-ref="facts"]')!.textContent).toContain('≥ 0.0.45');
  });

  it('shows no integrity and no keywords (the user, 2026-10-12): Engine, Feature SDK, Unit, License and Size', async () => {
    const h = await mount();
    expect(h.$$('[data-ref="facts"] dt').map((dt) => dt.textContent)).toEqual(['Engine', 'Feature SDK', 'Unit', 'License', 'Size']);
    expect(h.$('[data-ref="integrity"]')).toBeNull();
    expect(h.view.el.textContent).not.toContain('sha256-');
    expect(h.view.el.textContent).not.toContain('e2e-search');
    expect(h.$('[aria-label="Copy the integrity"]')).toBeNull();
  });

  it("the name's @scope lists that publisher's packages, as a button, and the byline doesn't repeat the handle", async () => {
    const h = await mount();
    const handle = h.$<HTMLButtonElement>('[data-ref="name"] [data-ref="publisher"]')!;
    expect(handle.tagName).toBe('BUTTON');
    expect(handle.textContent).toBe('@acme');
    expect(h.$('[data-ref="name"]')!.textContent).toBe('@acme/feature-tests');
    expect(h.$('[data-ref="byline"] [data-ref="publisher"]')).toBeNull();
    expect(h.$('[data-ref="byline"]')!.textContent).toBe('published 1 day ago · 2 installs');
    handle.click();
    expect(h.onPublisher).toHaveBeenCalledWith('acme');
  });

  it('opens the package page on the hub through the host', async () => {
    const h = await mount();
    h.$('[data-ref="open-on-hub"]')!.click();
    expect(h.openExternal).toHaveBeenCalledWith('http://localhost:8787/@acme/feature-tests');
    h.$('[data-ref="back"]')!.click();
    expect(h.onBack).toHaveBeenCalled();
  });

  it('says why when this FluidCAD runs only an older version, or none (decision 3), and that a package is deprecated', async () => {
    const engine = FakeHubClient.pkg({ compatibility: { engine: '0.0.46', sdk: 1, latestCompatible: false, newestCompatible: '0.1.0' } });
    engine.latest = { ...engine.latest!, minEngine: '0.0.47' };
    const h = await mount(engine);
    expect(h.$('[data-ref="notice"]')!.textContent).toContain('0.1.1: Requires FluidCAD 0.0.47+');
    expect(h.$('[data-ref="notice"]')!.textContent).toContain('0.1.0 works with it');
    expect(h.install().textContent).toBe('Install 0.1.0');

    const none = FakeHubClient.pkg({ compatibility: { engine: '0.0.46', sdk: 1, latestCompatible: false, newestCompatible: null } });
    none.latest = { ...none.latest!, minEngine: '0.1.0', sdkVersion: 2 };
    views.splice(0).forEach((v) => v.destroy());
    const n = await mount(none);
    expect(n.$('[data-ref="notice"]')!.textContent).toContain('Requires FluidCAD 0.1.0+');
    expect(n.install().disabled).toBe(true);
    expect(n.$('[data-ref="caption"]')!.textContent).toBe('Install turns on with FluidCAD 0.1.0 or newer, or when a version for this FluidCAD is published.');
    expect(n.view.el.textContent).not.toMatch(/feature SDK 2/);

    views.splice(0).forEach((v) => v.destroy());
    const d = await mount(FakeHubClient.pkg({ deprecatedMessage: 'Use @acme/kit2' }));
    expect(d.$('[data-ref="notice"]')!.textContent).toContain('Deprecated by @acme');
    expect(d.$('[data-ref="notice"]')!.textContent).toContain('“Use @acme/kit2”');
  });
});

describe('the tabs', () => {
  it('Features: each feature, and its parameter table from the version manifest (decision 4)', async () => {
    const h = await mount();
    expect(h.$$('[data-feature]').map((f) => f.dataset.feature)).toEqual(['fastener', 'standoff']);
    h.$('[data-feature="fastener"] button')!.click();
    await settle();
    expect(h.hub.version).toHaveBeenCalledWith('@acme/feature-tests', '0.1.1');
    const rows = h.$$('[data-feature="fastener"] [data-param]').map((r) => r.dataset.param);
    // The dialog's order, from the layout (the hub's jsonb doesn't keep the params' key order).
    expect(rows).toEqual(['at', 'standard', 'size', 'head', 'depth', 'marking', 'finishes']);
    const sizeImages = [...h.$('[data-feature="fastener"] [data-param="size"]')!.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sizeImages[0]).toMatch(/^api\/hub\/files\/@acme\/feature-tests\/0\.1\.1\/features\/fastener\//);
    // Folding it again asks nothing more.
    h.$('[data-feature="fastener"] button')!.click();
    h.$('[data-feature="fastener"] button')!.click();
    await settle();
    expect(h.hub.version).toHaveBeenCalledTimes(1);
  });

  it('Parts: parts, then assemblies, with captured thumbnails; Preview opens the hub page at ?model=; a factory has no preview', async () => {
    const h = await mount();
    await h.tab('parts');
    expect(h.$$('[data-model]').map((m) => m.dataset.export)).toEqual(['hubFlange', 'pinion', 'plateStack']);
    expect(h.$<HTMLImageElement>('[data-model="parts/hub-flange.part.js"] [data-ref="thumb"] img')!.getAttribute('src')).toBe('api/hub/media/@acme/feature-tests/shot-2');
    h.$('[data-model="assemblies/plate-stack.assembly.js"] [data-ref="preview"]')!.click();
    expect(h.openExternal).toHaveBeenCalledWith('http://localhost:8787/@acme/feature-tests?model=assemblies%2Fplate-stack.assembly.js');
    expect(h.$('[data-model="parts/pinion.part.js"] [data-ref="preview"]')).toBeNull();
    expect(h.$('[data-model="parts/pinion.part.js"] [data-ref="no-preview"]')!.textContent).toBe('no preview');
  });

  it('Versions: each with its marks, and Install for one this FluidCAD runs, into the library, pinned when the project pins none', async () => {
    const h = await mount();
    await h.tab('versions');
    expect(h.$$('[data-version]').map((v) => v.dataset.version)).toEqual(['0.1.1', '0.1.0']);
    h.$('[data-version="0.1.0"] [data-ref="install-version"]')!.click();
    await settle();
    expect(h.hub.inspect).toHaveBeenCalledWith({ name: '@acme/feature-tests', version: '0.1.0', target: 'library' });
    expect(h.packages.install).toHaveBeenCalledWith({ token: 'token-@acme/feature-tests-0.1.0-library', target: 'library', pin: true });
    expect(h.onInstalled).toHaveBeenCalledWith(expect.objectContaining({ name: '@acme/feature-tests', version: '0.1.0', upgrade: false }));
  });

  it('Readme: the notes and README.md as a Markdown subset, or what is missing', async () => {
    const h = await mount();
    await h.tab('readme');
    await settle();
    expect(h.$('[data-ref="notes"]')!.textContent).toContain('Notes for 0.1.1');
    expect(h.view.el.textContent).toContain('0.1.1 has no README.md.');

    const version = FakeHubClient.version();
    version.readmeUrl = 'api/hub/files/@acme/feature-tests/0.1.1/README.md';
    views.splice(0).forEach((v) => v.destroy());
    const r = await mount();
    r.hub.versions.set('@acme/feature-tests@0.1.1', version);
    r.hub.texts.set(version.readmeUrl, '# Kit\n\nSee [the docs](https://example.com/docs).');
    await r.tab('readme');
    await settle();
    expect(r.$('[data-role="readme"] h3')!.textContent).toBe('Kit');
    r.$<HTMLAnchorElement>('[data-role="readme"] a')!.click();
    expect(r.openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });
});

describe('Install (decisions 6 and 7)', () => {
  it('downloads, then installs with the token into the library pinned in the project: no consent dialog, the result inline', async () => {
    const h = await mount();
    expect(h.install().textContent).toBe('Install 0.1.1');
    expect(h.$('[data-ref="target"]')!.textContent).toBe('into my library');
    h.install().click();
    expect(h.install().textContent).toContain('Downloading…');
    await settle();
    expect(h.hub.inspect).toHaveBeenCalledWith({ name: '@acme/feature-tests', version: '0.1.1', target: 'library' });
    expect(h.packages.install).toHaveBeenCalledWith({ token: 'token-@acme/feature-tests-0.1.1-library', target: 'library', pin: true, upgrade: false, replace: false });
    expect(h.hub.inspect.mock.invocationCallOrder[0]).toBeLessThan(h.packages.install.mock.invocationCallOrder[0]);
    expect(document.querySelector('[data-role="package-consent"]')).toBeNull();
    expect(h.$('[data-ref="result"]')!.textContent).toContain('this project uses it');
    expect(h.$('[data-ref="note"]')!.textContent).toMatch(/feature SDK/);
    expect(h.onInstalled).toHaveBeenCalledWith(expect.objectContaining({ version: '0.1.1', upgrade: false }));
  });

  it("selects the target from the dropdown, shows it beside the button, and installs there; This project needs a project", async () => {
    const h = await mount();
    h.$('[data-ref="target-menu"]')!.click();
    expect(h.$$('[data-target]').map((t) => `${t.dataset.target}:${t.getAttribute('aria-checked')}`)).toEqual(['library:true', 'project:false']);
    h.$('[data-target="project"]')!.click();
    expect(h.target.current).toBe('project');
    expect(h.$('[data-ref="target"]')!.textContent).toBe('into this project');
    h.install().click();
    await settle();
    expect(h.hub.inspect).toHaveBeenCalledWith({ name: '@acme/feature-tests', version: '0.1.1', target: 'project' });
    expect(h.packages.install).toHaveBeenCalledWith(expect.objectContaining({ target: 'project', pin: true }));

    views.splice(0).forEach((v) => v.destroy());
    const alone = await mount(FakeHubClient.pkg(), { projectOpen: false, setting: 'project' });
    expect(alone.target.current).toBe('library');
    alone.$('[data-ref="target-menu"]')!.click();
    expect(alone.$<HTMLButtonElement>('[data-target="project"]')!.disabled).toBe(true);
  });

  it('each project remembers its last target: restored at start, saved on a choice, never without a project (H12)', async () => {
    const saved: PackageTarget[] = [];
    const memory = (remembered: PackageTarget | null) => ({ load: vi.fn(async () => remembered), save: vi.fn((target: PackageTarget) => void saved.push(target)) });

    const remembered = memory('project');
    const target = new HubInstallTarget(() => 'library', () => true, remembered);
    expect(target.current).toBe('library');
    await target.restore();
    expect(target.current).toBe('project');
    target.set('library');
    expect(target.current).toBe('library');
    expect(saved).toEqual(['library']);

    // Nothing remembered: the setting, which is My library unless changed.
    const fresh = new HubInstallTarget(() => 'library', () => true, memory(null));
    await fresh.restore();
    expect(fresh.current).toBe('library');

    // A choice made before the project's answer arrives wins.
    const slow = memory('library');
    const racing = new HubInstallTarget(() => 'library', () => true, slow);
    const restoring = racing.restore();
    racing.set('project');
    await restoring;
    expect(racing.current).toBe('project');

    // No project: the library, nothing read, nothing saved.
    saved.length = 0;
    const none = memory('project');
    const alone = new HubInstallTarget(() => 'library', () => false, none);
    await alone.restore();
    alone.set('project');
    expect(alone.current).toBe('library');
    expect(none.load).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it('the dropdown’s choice reaches the project’s memory', async () => {
    const h = await mount(FakeHubClient.pkg());
    const save = vi.fn();
    const remembering = new HubInstallTarget(() => 'library', () => true, { load: async () => null, save });
    views.splice(0).forEach((v) => v.destroy());
    const view = new HubPackageView({
      hub: h.hub,
      packages: h.packages,
      target: remembering,
      engine: () => ({ engine: '0.0.46', sdk: 1 }),
      hubUrl: () => 'http://localhost:8787',
      projectOpen: () => true,
      openExternal: vi.fn(),
      onBack: vi.fn(),
      onInstalled: vi.fn(),
      signIn: vi.fn(),
      now: () => Date.parse('2026-10-12T12:00:00Z'),
    });
    views.push(view);
    document.body.appendChild(view.el);
    await view.show('@acme/feature-tests');
    await settle();
    view.el.querySelector<HTMLElement>('[data-ref="target-menu"]')!.click();
    view.el.querySelector<HTMLButtonElement>('[data-target="project"]')!.click();
    await settle();
    expect(save).toHaveBeenCalledWith('project');
    expect(view.el.querySelector('[data-ref="target"]')!.textContent).toBe('into this project');
  });

  it('starts at the "New packages go to" setting', async () => {
    const h = await mount(FakeHubClient.pkg(), { setting: 'project' });
    expect(h.$('[data-ref="target"]')!.textContent).toBe('into this project');
  });

  it('reads "Upgrade to X" when the project uses an older version, and moves the pin with upgrade', async () => {
    const h = await mount(FakeHubClient.pkg({ local: { installed: ['0.1.0'], pinned: '0.1.0', updateAvailable: '0.1.1' } }));
    expect(h.install().textContent).toBe('Upgrade to 0.1.1');
    expect(h.$('[data-ref="caption"]')!.textContent).toBe('This project uses 0.1.0. Upgrade installs 0.1.1 into your library and moves the project to it.');
    h.install().click();
    await settle();
    expect(h.packages.install).toHaveBeenCalledWith(expect.objectContaining({ target: 'library', pin: true, upgrade: true }));
    expect(h.onInstalled).toHaveBeenCalledWith(expect.objectContaining({ upgrade: true }));
  });

  it('reads Installed when the project uses the offered version', async () => {
    const h = await mount(FakeHubClient.pkg({ local: { installed: ['0.1.1'], pinned: '0.1.1', updateAvailable: null } }));
    expect(h.install().textContent!.trim()).toBe('Installed');
    expect(h.install().disabled).toBe(true);
  });

  it('offers Replace for the same version with other contents, downloading it again', async () => {
    const h = await mount();
    h.packages.install.mockResolvedValueOnce({ ok: false, status: 409, error: '@acme/feature-tests 0.1.1 is already in your library with other contents.', code: 'conflict' } as any);
    h.install().click();
    await settle();
    expect(h.$('[data-ref="conflict"]')!.textContent).toContain('already in your library');
    h.$('[data-ref="replace"]')!.click();
    await settle();
    expect(h.hub.inspect).toHaveBeenCalledTimes(2);
    expect(h.packages.install).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
  });

  it("says the hub can't be reached in the panel's words, installing nothing", async () => {
    const h = await mount();
    h.hub.inspectRefusal = { status: 503, error: 'ECONNREFUSED', code: 'hub-unreachable' };
    h.install().click();
    await settle();
    expect(h.$('[data-ref="error"]')!.textContent!.trim()).toBe("Couldn't reach localhost:8787. Nothing was installed; try again when it answers.");
    expect(h.packages.install).not.toHaveBeenCalled();
  });

  it('decides the action from the marks', () => {
    const base = { name: '@acme/kit', offered: '0.2.0', projectOpen: false, host: null, size: null };
    expect(HubInstallControl.action({ ...base, local: { installed: ['0.2.0'], pinned: null, updateAvailable: null } }, 'library').kind).toBe('installed');
    expect(HubInstallControl.action({ ...base, projectOpen: true, local: { installed: ['0.2.0'], pinned: null, updateAvailable: null } }, 'library').caption)
      .toBe('Already in your library: this adds it to this project.');
    expect(HubInstallControl.action({ ...base, projectOpen: true, local: { installed: ['0.3.0'], pinned: '0.3.0', updateAvailable: null } }, 'library').kind).toBe('installed');
    // A plain install says nothing under the button: "into my library" / "into this project" already says where.
    const fresh = { installed: [], pinned: null, updateAvailable: null };
    expect(HubInstallControl.action({ ...base, projectOpen: true, local: fresh }, 'library').caption).toBeNull();
    expect(HubInstallControl.action({ ...base, projectOpen: true, local: fresh }, 'project').caption).toBeNull();
    expect(HubInstallControl.action({ ...base, local: fresh }, 'library').caption).toBeNull();
  });
});

describe('FeatureParamTable', () => {
  it('describes every kind of value of the test bench package, with its default', () => {
    const version = FakeHubClient.version();
    const rows = (id: string) => {
      const feature = version.manifest!.features.find((f) => f.id === id)!;
      return Object.fromEntries(FeatureParamTable.rows(feature.meta, 'mm').map((r) => [r.name, r]));
    };
    const fastener = rows('fastener');
    expect(fastener.at.control).toBe('Pick a connector, point or anchor');
    expect(fastener.at.value).toBe('picked');
    expect(fastener.standard.control).toBe('Buttons: Metric, Imperial');
    expect(fastener.size.control).toMatch(/^Grid with images: M3, M4, M5/);
    expect(fastener.size.images.length).toBeGreaterThan(0);
    expect(fastener.head.control).toBe('Cards with images: Plain, Counterbore, Countersink');
    expect(fastener.depth.control).toBe('Length, slider 1 to 50');
    expect(fastener.depth.value).toBe('10 mm');
    expect(fastener.marking.control).toBe('Text, at most 12 characters');
    expect(fastener.marking.value).toBe('empty');
    expect(fastener.finishes.control).toMatch(/^Select, several: /);
    const all = version.manifest!.features.flatMap((f) => FeatureParamTable.rows(f.meta, 'mm'));
    // An axis picker, a planar face, a boolean, an angle and a whole number are there too.
    const controls = all.map((r) => r.control);
    expect(controls.some((c) => /^Pick an axis/.test(c))).toBe(true);
    expect(controls.some((c) => /^Pick a planar face/.test(c))).toBe(true);
    expect(controls).toContain('Toggle');
    expect(all.some((r) => r.control.startsWith('Angle') && r.value.endsWith('°'))).toBe(true);
    expect(controls.some((c) => c.startsWith('Whole number'))).toBe(true);
    expect(all.some((r) => /^Pick a connector, point or anchor, several/.test(r.control))).toBe(true);
    // Every value of every feature becomes a row.
    const declared = version.manifest!.features.reduce((n, f) => n + Object.keys(f.meta.params ?? {}).length, 0);
    expect(all).toHaveLength(declared);
  });

  it('sets the manifest as text', () => {
    const table = FeatureParamTable.create({ params: { x: { type: 'text', label: '<img src=x onerror=alert(1)>', default: '<b>bold</b>' } } }, 'mm');
    expect(table.querySelector('img')).toBeNull();
    expect(table.querySelector('b')).toBeNull();
    expect(table.textContent).toContain('<b>bold</b>');
  });
});

describe('HubMarkdown', () => {
  it('renders the subset with DOM nodes only, opens links through the host, and loads no image', () => {
    const open = vi.fn();
    const root = HubMarkdown.render([
      '# Mounting',
      '',
      'Plain **bold**, *em* and `code` <script>alert(1)</script>.',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '',
      '```js',
      "import { x } from 'y';",
      '```',
      '',
      '| Screw | Clearance |',
      '|---|---|',
      '| m3 | 3.4 mm |',
      '',
      '> quoted',
      '',
      '![a diagram](diagram.png) [docs](https://example.com) [local](file:///etc/passwd)',
      '',
      '---',
    ].join('\n'), open);
    expect(root.querySelector('h3')!.textContent).toBe('Mounting');
    expect(root.querySelector('strong')!.textContent).toBe('bold');
    expect(root.querySelector('em')!.textContent).toBe('em');
    expect(root.querySelector('p code')!.textContent).toBe('code');
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
    expect([...root.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    expect(root.querySelector('ol li')!.textContent).toBe('first');
    expect(root.querySelector('pre')!.textContent).toBe("import { x } from 'y';");
    expect([...root.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['m3', '3.4 mm']);
    expect(root.querySelector('blockquote')!.textContent).toBe('quoted');
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('[image: a diagram]');
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['docs']);
    links[0].click();
    expect(open).toHaveBeenCalledWith('https://example.com');
    expect(root.textContent).toContain('local');
    expect(root.querySelector('hr')).not.toBeNull();
  });
});
