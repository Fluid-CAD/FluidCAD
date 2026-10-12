import type { HubCatalogFeature, HubCatalogModel, HubClient, HubMedia, HubPackage, HubResult, HubVersion, HubVersionSummary, PackagesClient } from '../../api';
import { FeatureParamTable } from './feature-param-table';
import { HubHandle } from './hub-handle';
import { HubIcons, HubImage } from './hub-icons';
import { HubInstallControl, type HubInstalled, type HubInstallTarget } from './hub-install-control';
import { HubMarkdown } from './hub-markdown';
import { HubBadges, HubResultRow, type HubEngine } from './hub-row';
import { HubText } from './hub-text';

export type HubPackageTab = 'features' | 'parts' | 'versions' | 'readme';

export type HubPackageViewDeps = {
  hub: HubClient;
  packages: PackagesClient;
  target: HubInstallTarget;
  /** This FluidCAD's version and feature SDK. */
  engine(): HubEngine;
  /** The hub's address (`https://hub.fluidcad.io`), for its page links. */
  hubUrl(): string | null;
  projectOpen(): boolean;
  /** Open a web page in the user's browser, through the host. */
  openExternal(url: string): void;
  onBack(): void;
  onInstalled(installed: HubInstalled): void;
  /** The byline's `@publisher` was clicked: list that publisher's packages. */
  onPublisher?(handle: string): void;
  now?(): number;
};

/**
 * One package in the Hub panel (hub-plan H11, the signed-off mock with the
 * user's decisions): the header (name, latest version, the publisher,
 * whose handle lists their packages, marks, a deprecated or incompatible
 * notice, the screenshot strip, the Install control, the facts), then four
 * tabs:
 * - **Features:** each feature with its icon and description; opening one
 *   shows its parameter table (decision 4), read from the version's
 *   manifest through the engine;
 * - **Parts:** the parts, then the assemblies, with their captured
 *   thumbnails; Preview opens the hub's package page at `?model=` in the
 *   user's browser (package code never runs here before an install);
 * - **Versions:** each version (the owner also sees an open one), with
 *   Install for a published one this FluidCAD runs;
 * - **Readme:** the version's notes and its README.md as a safe Markdown
 *   subset (decision 8).
 *
 * Every value from the hub is set as text; images are the engine's proxy paths.
 */
export class HubPackageView {
  readonly el: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly openLink: HTMLButtonElement;
  private readonly install: HubInstallControl;
  private name: string | null = null;
  private pkg: HubPackage | null = null;
  private loadError: { code?: string; error: string } | null = null;
  private tab: HubPackageTab = 'features';
  private readonly expanded = new Set<string>();
  private shown: string | null = null;
  private readonly versions = new Map<string, Promise<HubResult<{ version: HubVersion }>>>();
  private readonly readmes = new Map<string, Promise<HubResult<{ text: string }>>>();
  private ticket = 0;
  private readonly versionInstalls = new Map<string, string>();

  constructor(private readonly deps: HubPackageViewDeps) {
    this.el = document.createElement('div');
    this.el.dataset.role = 'hub-package';
    this.el.className = 'flex flex-col flex-1 min-h-0';

    const top = document.createElement('div');
    top.className = 'flex items-center gap-1 h-10 shrink-0 px-1.5 border-b border-base-content/10';
    const back = document.createElement('button');
    back.type = 'button';
    back.dataset.ref = 'back';
    back.className = 'btn btn-ghost btn-xs gap-1 font-normal text-base-content/75';
    back.append(HubIcons.span(HubIcons.BACK, '[&>svg]:size-3.5'), 'Results');
    back.addEventListener('click', () => deps.onBack());
    this.openLink = document.createElement('button');
    this.openLink.type = 'button';
    this.openLink.dataset.ref = 'open-on-hub';
    this.openLink.className = 'btn btn-ghost btn-xs gap-1 font-normal text-base-content/70 ml-auto';
    this.openLink.append('Open on the hub', HubIcons.span(HubIcons.EXTERNAL, '[&>svg]:size-3.5'));
    this.openLink.addEventListener('click', () => {
      const url = this.pageUrl();
      if (url) {
        deps.openExternal(url);
      }
    });
    top.append(back, this.openLink);

    this.body = document.createElement('div');
    this.body.dataset.ref = 'detail';
    this.body.className = 'flex-1 min-h-0 overflow-y-auto';
    this.el.append(top, this.body);

    this.install = new HubInstallControl({
      hub: deps.hub,
      packages: deps.packages,
      target: deps.target,
      onInstalled: (installed) => {
        deps.onInstalled(installed);
        void this.reload();
      },
    });
  }

  get packageName(): string | null {
    return this.name;
  }

  get current(): HubPackage | null {
    return this.pkg;
  }

  /** Show `name`, from the first tab. */
  async show(name: string): Promise<void> {
    if (name !== this.name) {
      this.tab = 'features';
      this.expanded.clear();
      this.shown = null;
      this.versions.clear();
      this.readmes.clear();
      this.versionInstalls.clear();
    }
    this.name = name;
    this.pkg = null;
    this.loadError = null;
    this.render();
    this.body.scrollTop = 0;
    await this.reload();
  }

  /** Read the package again (after an install, its marks), keeping the tab and what is open. */
  async reload(): Promise<void> {
    const name = this.name;
    if (!name) {
      return;
    }
    const ticket = ++this.ticket;
    const answer = await this.deps.hub.package(name);
    if (ticket !== this.ticket || name !== this.name) {
      return;
    }
    if (answer.ok === false) {
      this.loadError = { code: answer.code, error: answer.error };
      this.pkg = null;
    } else {
      this.loadError = null;
      this.pkg = answer.pkg;
    }
    const scroll = this.body.scrollTop;
    this.render();
    this.body.scrollTop = scroll;
  }

  /**
   * The account the engine signs in with changed (a sign-in or a sign-out
   * from the header): what the hub answered for the old one (an owner's
   * open versions, each version read for the Features tab) is forgotten,
   * and the package is read again when it is `showing`; a hidden one is
   * read when it opens again.
   */
  accountChanged(showing: boolean): void {
    this.versions.clear();
    this.readmes.clear();
    if (showing && this.name) {
      void this.reload();
    }
  }

  /** `<hub>/@scope/name`, the package's page on the hub. */
  pageUrl(model?: string): string | null {
    const hub = this.deps.hubUrl();
    if (!hub || !this.name) {
      return null;
    }
    const base = `${hub.replace(/\/+$/, '')}/${this.name}`;
    return model ? `${base}?model=${encodeURIComponent(model)}` : base;
  }

  destroy(): void {
    this.install.destroy();
    this.el.remove();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(): void {
    this.openLink.disabled = !this.pageUrl();
    this.openLink.title = this.pageUrl() ? `Opens ${this.pageUrl()} in your browser` : 'The hub address is not known yet';
    if (this.loadError) {
      this.body.replaceChildren(this.failure(this.loadError));
      return;
    }
    const pkg = this.pkg;
    if (!pkg) {
      this.body.replaceChildren(HubPackageView.skeleton());
      return;
    }
    this.body.replaceChildren(this.header(pkg), this.tabs(pkg), this.tabBody(pkg));
  }

  private header(pkg: HubPackage): HTMLDivElement {
    const engine = this.deps.engine();
    const latest = pkg.latest;
    const head = document.createElement('div');
    head.className = 'px-3 pt-3 pb-3 flex flex-col gap-2.5 border-b border-base-content/10';

    const titleBlock = document.createElement('div');
    titleBlock.className = 'flex flex-col gap-0.5';
    const title = document.createElement('div');
    title.className = 'flex items-baseline gap-1.5 min-w-0';
    title.appendChild(HubResultRow.name(pkg.name, 'text-[15px]'));
    if (latest) {
      const version = document.createElement('span');
      version.dataset.ref = 'latest';
      version.className = 'font-mono text-xs text-base-content/50 tabular-nums';
      version.textContent = latest.version;
      const badge = document.createElement('span');
      badge.className = 'badge badge-xs badge-outline text-base-content/55 ml-0.5';
      badge.textContent = 'Latest';
      title.append(version, badge);
    }
    const byline = document.createElement('div');
    byline.dataset.ref = 'byline';
    byline.className = 'text-[11px] text-base-content/50';
    const published = latest?.publishedAt ? `published ${HubText.ago(latest.publishedAt, this.now())}` : null;
    const rest = [published, HubText.plural(pkg.counts.installs, 'install')].filter(Boolean).join(' · ');
    const onPublisher = this.deps.onPublisher;
    if (pkg.publisher && onPublisher && HubHandle.isHandle(pkg.publisher)) {
      byline.append(HubHandle.button(pkg.publisher, onPublisher), rest ? ` · ${rest}` : '');
    } else {
      byline.textContent = [pkg.publisher ? `@${pkg.publisher}` : null, rest].filter(Boolean).join(' · ');
    }
    titleBlock.append(title, byline);
    head.appendChild(titleBlock);

    if (pkg.description) {
      const description = document.createElement('p');
      description.dataset.ref = 'description';
      description.className = 'text-xs text-base-content/75 leading-snug';
      description.textContent = pkg.description;
      head.appendChild(description);
    }

    if (latest) {
      const badges = HubBadges.of({
        version: latest.version,
        minEngine: latest.minEngine,
        sdkVersion: latest.sdkVersion,
        compatible: pkg.compatibility ? pkg.compatibility.latestCompatible : null,
        deprecated: pkg.deprecatedMessage,
        local: pkg.local,
      }, engine);
      if (badges.length > 0) {
        const marks = document.createElement('div');
        marks.dataset.ref = 'marks';
        marks.className = 'flex flex-wrap gap-1';
        marks.append(...badges);
        head.appendChild(marks);
      }
    }

    const notice = this.notice(pkg, engine);
    if (notice) {
      head.appendChild(notice);
    }
    head.appendChild(this.media(pkg.listing.media));

    const offered = pkg.compatibility ? pkg.compatibility.newestCompatible : latest?.version ?? null;
    const offeredSize = pkg.versions.find((v) => v.version === offered)?.size ?? latest?.size ?? null;
    this.install.update({
      name: pkg.name,
      offered,
      local: pkg.local,
      projectOpen: this.deps.projectOpen(),
      host: this.host(),
      size: offeredSize,
      unavailable: latest ? HubPackageView.unavailable(pkg, engine) : 'Nothing of this package is published yet.',
    });
    head.appendChild(this.install.el);

    if (latest) {
      head.appendChild(this.facts(pkg));
    }
    return head;
  }

  /** Deprecated, or nothing this FluidCAD runs, or an older version offered than the latest. */
  private notice(pkg: HubPackage, engine: HubEngine): HTMLElement | null {
    const latest = pkg.latest;
    if (!latest) {
      return null;
    }
    const compatibility = pkg.compatibility;
    if (compatibility && !compatibility.latestCompatible) {
      const reason = HubText.incompatibility({ minEngine: latest.minEngine, sdkVersion: latest.sdkVersion }, engine.engine, engine.sdk);
      if (compatibility.newestCompatible) {
        return HubPackageView.notice('error', `${latest.version}: ${reason.text}`,
          `${reason.tip} ${compatibility.newestCompatible} works with it, so Install offers that one.`);
      }
      return HubPackageView.notice('error', reason.text,
        `${reason.tip} No published version of ${pkg.name} works with this FluidCAD.`);
    }
    if (pkg.deprecatedMessage) {
      return HubPackageView.notice('warning', `Deprecated${pkg.publisher ? ` by @${pkg.publisher}` : ''}`,
        `“${pkg.deprecatedMessage}” You can still install ${latest.version}.`);
    }
    return null;
  }

  /** Why Install is off when nothing is offered. */
  private static unavailable(pkg: HubPackage, engine: HubEngine): string {
    const latest = pkg.latest!;
    const reason = HubText.incompatibility({ minEngine: latest.minEngine, sdkVersion: latest.sdkVersion }, engine.engine, engine.sdk);
    if (reason.kind === 'engine') {
      return `Install turns on with FluidCAD ${latest.minEngine} or newer, or when a version for this FluidCAD is published.`;
    }
    return 'Install turns on when a version for this FluidCAD is published.';
  }

  private static notice(tone: 'warning' | 'error', title: string, text: string): HTMLDivElement {
    const box = document.createElement('div');
    box.dataset.ref = 'notice';
    box.dataset.tone = tone;
    box.className = `flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-snug ${tone === 'warning' ? 'bg-warning/15' : 'bg-error/10 border border-error/30'}`;
    box.appendChild(HubIcons.span(HubIcons.WARNING, `[&>svg]:size-4 mt-px ${tone === 'warning' ? 'text-warning' : 'text-error'}`));
    const words = document.createElement('span');
    words.className = 'flex flex-col gap-0.5';
    const heading = document.createElement('span');
    heading.className = 'font-medium text-base-content/90';
    heading.textContent = title;
    const sentence = document.createElement('span');
    sentence.className = 'text-base-content/80';
    sentence.textContent = text;
    words.append(heading, sentence);
    box.appendChild(words);
    return box;
  }

  /** The screenshot strip: the chosen one large with its caption, the others beside it. */
  private media(media: HubMedia[]): HTMLElement {
    const shots = [...media].sort((a, b) => a.position - b.position);
    if (shots.length === 0) {
      const none = document.createElement('div');
      none.dataset.ref = 'no-media';
      none.className = 'rounded-md bg-base-200 border border-base-content/[0.06] h-16 grid place-items-center text-[11px] text-base-content/45';
      none.textContent = 'No screenshots yet';
      return none;
    }
    const current = shots.find((shot) => shot.id === this.shown) ?? shots.find((shot) => shot.isCard) ?? shots[0];
    const strip = document.createElement('div');
    strip.dataset.ref = 'media';
    strip.className = 'flex gap-1.5';
    const figure = document.createElement('figure');
    figure.className = 'relative flex-1 min-w-0 rounded-md overflow-hidden bg-base-200 border border-base-content/[0.06] aspect-[4/3] max-h-40';
    const img = document.createElement('img');
    img.src = current.url;
    img.alt = current.caption;
    img.className = 'size-full object-contain';
    figure.appendChild(img);
    const label = current.caption || (current.modelModule ? current.modelModule.split('/').pop()! : '');
    if (label) {
      const caption = document.createElement('figcaption');
      caption.className = 'absolute left-1.5 bottom-1.5 px-1.5 py-0.5 rounded bg-base-100/85 text-[10px] font-mono text-base-content/70 max-w-[90%] truncate';
      caption.textContent = label;
      figure.appendChild(caption);
    }
    strip.appendChild(figure);
    const others = shots.filter((shot) => shot !== current).slice(0, 3);
    if (others.length > 0) {
      const column = document.createElement('div');
      column.className = 'flex flex-col gap-1.5 w-14 shrink-0';
      for (const shot of others) {
        const thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.dataset.media = shot.id;
        thumb.className = 'block rounded overflow-hidden bg-base-200 border border-base-content/[0.06] aspect-[4/3] hover:border-primary/50';
        thumb.title = shot.caption || 'Show this screenshot';
        const small = document.createElement('img');
        small.src = shot.url;
        small.alt = '';
        small.loading = 'lazy';
        small.className = 'size-full object-contain';
        thumb.appendChild(small);
        thumb.addEventListener('click', () => {
          this.shown = shot.id;
          strip.replaceWith(this.media(media));
        });
        column.appendChild(thumb);
      }
      strip.appendChild(column);
    }
    return strip;
  }

  private facts(pkg: HubPackage): HTMLDListElement {
    const latest = pkg.latest!;
    const list = document.createElement('dl');
    list.dataset.ref = 'facts';
    list.className = 'grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1 text-[11px] items-baseline';
    const license = pkg.listing.license ?? latest.license;
    const items: [string, string, boolean][] = [
      ['Engine', `≥ ${latest.minEngine}`, true],
      ['Feature SDK', String(latest.sdkVersion), true],
      ['Unit', latest.unit, true],
      ['License', HubText.license(license), false],
      ['Size', HubPackageView.bytes(latest.size), false],
    ];
    for (const [term, value, mono] of items) {
      const dt = document.createElement('dt');
      dt.className = 'text-base-content/50 whitespace-nowrap';
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.className = `text-base-content/85 truncate${mono ? ' font-mono' : ''}`;
      dd.title = value;
      dd.textContent = value;
      list.append(dt, dd);
    }
    return list;
  }

  private tabs(pkg: HubPackage): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'px-3 pt-3 pb-2';
    const join = document.createElement('div');
    join.dataset.ref = 'tabs';
    join.setAttribute('role', 'tablist');
    join.className = 'join w-full';
    const counts: Record<HubPackageTab, number | null> = {
      features: pkg.latest?.features.length ?? 0,
      parts: pkg.latest?.models.length ?? 0,
      versions: pkg.versions.length,
      readme: null,
    };
    const labels: Record<HubPackageTab, string> = { features: 'Features', parts: 'Parts', versions: 'Versions', readme: 'Readme' };
    for (const key of ['features', 'parts', 'versions', 'readme'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.tab = key;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(key === this.tab));
      button.className = `btn btn-sm join-item flex-1 gap-1 px-1 ${key === this.tab ? 'btn-soft btn-primary' : 'font-normal'}`;
      button.append(labels[key]);
      const count = counts[key];
      if (count !== null) {
        const n = document.createElement('span');
        n.className = 'tabular-nums opacity-60 text-[11px]';
        n.textContent = String(count);
        button.appendChild(n);
      }
      button.addEventListener('click', () => {
        this.tab = key;
        const scroll = this.body.scrollTop;
        this.render();
        this.body.scrollTop = scroll;
      });
      join.appendChild(button);
    }
    wrap.appendChild(join);
    return wrap;
  }

  private tabBody(pkg: HubPackage): HTMLElement {
    const body = document.createElement('div');
    body.dataset.ref = `tab-${this.tab}`;
    body.className = 'border-t border-base-content/[0.07]';
    if (this.tab === 'features') {
      this.features(pkg, body);
    } else if (this.tab === 'parts') {
      this.parts(pkg, body);
    } else if (this.tab === 'versions') {
      this.versionList(pkg, body);
    } else {
      this.readme(pkg, body);
    }
    return body;
  }

  // ---------------------------------------------------------------------------
  // Features: each with its parameter table
  // ---------------------------------------------------------------------------

  private features(pkg: HubPackage, into: HTMLElement): void {
    const features = pkg.latest?.features ?? [];
    if (features.length === 0) {
      into.appendChild(HubPackageView.note('This package adds no features: its parts and assemblies are in the Parts tab.'));
      return;
    }
    for (const feature of features) {
      into.appendChild(this.featureRow(pkg, feature));
    }
  }

  private featureRow(pkg: HubPackage, feature: HubCatalogFeature): HTMLDivElement {
    const open = this.expanded.has(feature.id);
    const row = document.createElement('div');
    row.dataset.feature = feature.id;
    row.className = 'border-b border-base-content/[0.07]';
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-expanded', String(open));
    button.className = 'w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-base-content/[0.04]';
    const iconBox = document.createElement('span');
    iconBox.className = 'size-8 rounded-md bg-base-200 border border-base-content/[0.06] grid place-items-center shrink-0';
    const generic = () => HubIcons.span(HubIcons.BOX, '[&>svg]:size-4 text-base-content/35');
    iconBox.appendChild(feature.iconUrl ? HubImage.create(feature.iconUrl, 'size-5 object-contain', generic) : generic());
    const text = document.createElement('span');
    text.className = 'flex-1 min-w-0 flex flex-col gap-0.5';
    const head = document.createElement('span');
    head.className = 'flex items-baseline gap-1.5 min-w-0';
    const label = document.createElement('span');
    label.className = 'text-[13px] font-medium text-base-content/90';
    label.textContent = feature.label;
    const id = document.createElement('span');
    id.className = 'font-mono text-[11px] text-base-content/45 truncate';
    id.textContent = feature.id;
    head.append(label, id);
    text.appendChild(head);
    if (feature.description) {
      const description = document.createElement('span');
      description.className = 'text-xs text-base-content/65 leading-snug';
      description.textContent = feature.description;
      text.appendChild(description);
    }
    const meta = document.createElement('span');
    meta.className = 'text-[11px] text-base-content/45';
    meta.textContent = [feature.group === 'modify' ? 'Changes geometry' : 'Creates geometry', HubText.plural(feature.paramCount, 'parameter')].join(' · ');
    text.appendChild(meta);
    const chevron = HubIcons.span(HubIcons.CHEVRON_DOWN, `[&>svg]:size-4 mt-1 text-base-content/40 transition-transform${open ? ' rotate-180' : ''}`);
    button.append(iconBox, text, chevron);
    button.addEventListener('click', () => {
      if (this.expanded.has(feature.id)) {
        this.expanded.delete(feature.id);
      } else {
        this.expanded.add(feature.id);
      }
      row.replaceWith(this.featureRow(pkg, feature));
    });
    row.appendChild(button);
    if (open) {
      row.appendChild(this.paramTable(pkg, feature));
    }
    return row;
  }

  private paramTable(pkg: HubPackage, feature: HubCatalogFeature): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.dataset.ref = 'params';
    wrap.className = 'px-3 pb-4';
    const loading = HubPackageView.note('Reading the parameters from the package manifest…');
    wrap.appendChild(loading);
    const version = pkg.latest!.version;
    void this.versionOf(pkg.name, version).then((answer) => {
      if (answer.ok === false) {
        wrap.replaceChildren(HubPackageView.note(answer.code === 'hub-unreachable'
          ? 'Couldn’t reach the hub to read the parameters. Try again when it answers.'
          : `Couldn’t read the parameters: ${answer.error}`));
        this.versions.delete(`${pkg.name}@${version}`);
        return;
      }
      const entry = answer.version.manifest?.features.find((f) => f.id === feature.id);
      if (!entry) {
        wrap.replaceChildren(HubPackageView.note('The manifest lists no parameters for this feature.'));
        return;
      }
      const caption = document.createElement('p');
      caption.className = 'text-[11px] text-base-content/50 mt-2 leading-snug';
      caption.textContent = 'Read from the package manifest. Installed, this feature opens a dialog with these parameters under Custom in the toolbar.';
      wrap.replaceChildren(FeatureParamTable.create(entry.meta, answer.version.unit), caption);
    });
    return wrap;
  }

  private versionOf(name: string, version: string): Promise<HubResult<{ version: HubVersion }>> {
    const key = `${name}@${version}`;
    let answer = this.versions.get(key);
    if (!answer) {
      answer = this.deps.hub.version(name, version);
      this.versions.set(key, answer);
    }
    return answer;
  }

  // ---------------------------------------------------------------------------
  // Parts: parts, then assemblies, with Preview on the hub
  // ---------------------------------------------------------------------------

  private parts(pkg: HubPackage, into: HTMLElement): void {
    const models = pkg.latest?.models ?? [];
    if (models.length === 0) {
      into.appendChild(HubPackageView.note('This package has no parts or assemblies.'));
      return;
    }
    const previewable = new Set(models.filter((m) => m.exportKind === 'value').map((m) => m.module));
    for (const [folder, title] of [['parts', 'Parts'], ['assemblies', 'Assemblies']] as const) {
      const list = models.filter((m) => m.folder === folder);
      if (list.length === 0) {
        continue;
      }
      const heading = document.createElement('div');
      heading.className = 'px-3 pt-3 pb-1.5 text-[10px] uppercase tracking-wide text-base-content/45 border-b border-base-content/[0.07]';
      heading.textContent = title;
      into.appendChild(heading);
      for (const model of list) {
        into.appendChild(this.modelRow(pkg, model, previewable.has(model.module)));
      }
    }
    into.appendChild(HubPackageView.note('Preview opens the package page on the hub in your browser, where the model builds in a sandbox with its parameters. Nothing from the package runs in FluidCAD before you install it.'));
  }

  private modelRow(pkg: HubPackage, model: HubCatalogModel, previewable: boolean): HTMLDivElement {
    const row = document.createElement('div');
    row.dataset.model = model.module;
    row.dataset.export = model.exportName;
    row.className = 'flex items-center gap-2.5 px-3 py-2 border-b border-base-content/[0.07]';
    const thumb = document.createElement('span');
    thumb.dataset.ref = 'thumb';
    thumb.className = 'w-12 aspect-[4/3] rounded bg-base-200 border border-base-content/[0.06] overflow-hidden shrink-0 grid place-items-center';
    const capture = pkg.listing.media.find((shot) => shot.modelModule === model.module);
    const generic = () => HubIcons.span(model.kind === 'assembly' ? HubIcons.PACKAGES : HubIcons.CUBE, '[&>svg]:size-5 text-base-content/30');
    thumb.appendChild(capture ? HubImage.create(capture.url, 'size-full object-cover', generic) : generic());
    const text = document.createElement('span');
    text.className = 'flex-1 min-w-0 flex flex-col';
    const name = document.createElement('span');
    name.className = 'text-[13px] text-base-content/90 truncate';
    name.textContent = model.name;
    const where = document.createElement('span');
    where.className = 'font-mono text-[11px] text-base-content/45 truncate';
    where.title = model.module;
    where.textContent = `${model.exportName} · ${model.module}`;
    const params = document.createElement('span');
    params.className = 'text-[11px] text-base-content/50';
    params.textContent = model.exportKind === 'factory'
      ? 'built by a function'
      : model.paramCount === 0 ? 'no parameters' : HubText.plural(model.paramCount, 'parameter');
    text.append(name, where, params);
    row.append(thumb, text);
    if (previewable) {
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.dataset.ref = 'preview';
      preview.className = 'btn btn-ghost btn-xs gap-1 font-normal shrink-0';
      const url = this.pageUrl(model.module);
      preview.title = url ? `Opens ${url} in your browser` : 'Preview';
      preview.append('Preview', HubIcons.span(HubIcons.EXTERNAL, '[&>svg]:size-3.5'));
      preview.addEventListener('click', () => {
        const target = this.pageUrl(model.module);
        if (target) {
          this.deps.openExternal(target);
        }
      });
      row.appendChild(preview);
    } else {
      const none = document.createElement('span');
      none.dataset.ref = 'no-preview';
      none.className = 'text-[11px] text-base-content/45 shrink-0';
      none.textContent = 'no preview';
      row.appendChild(none);
    }
    return row;
  }

  // ---------------------------------------------------------------------------
  // Versions
  // ---------------------------------------------------------------------------

  private versionList(pkg: HubPackage, into: HTMLElement): void {
    const engine = this.deps.engine();
    for (const version of pkg.versions) {
      into.appendChild(this.versionRow(pkg, version, engine));
    }
  }

  private versionRow(pkg: HubPackage, v: HubVersionSummary, engine: HubEngine): HTMLDivElement {
    const row = document.createElement('div');
    row.dataset.version = v.version;
    row.className = `flex items-start gap-2 px-3 py-2.5 border-b border-base-content/[0.07]${v.status !== 'published' ? ' bg-base-200/60' : ''}`;
    const text = document.createElement('div');
    text.className = 'flex-1 min-w-0 flex flex-col gap-0.5';
    const head = document.createElement('div');
    head.className = 'flex items-center gap-1.5 flex-wrap';
    const number = document.createElement('span');
    number.className = 'font-mono text-[13px] font-medium text-base-content/90';
    number.textContent = v.version;
    head.appendChild(number);
    const badge = (label: string, look: string) => {
      const el = document.createElement('span');
      el.className = `badge badge-xs ${look}`;
      el.textContent = label;
      head.appendChild(el);
    };
    if (v.isLatest) {
      badge('Latest', 'badge-outline text-base-content/55');
    }
    if (v.status === 'in_review') {
      badge('in review', 'badge-soft badge-warning');
    } else if (v.status === 'draft') {
      badge('draft', 'badge-soft badge-warning');
    } else if (v.status === 'rejected') {
      badge('rejected', 'badge-soft badge-error');
    }
    if (v.yanked) {
      badge('yanked', 'badge-soft badge-error');
    }
    if (pkg.local.installed.includes(v.version)) {
      badge('installed', 'badge-soft badge-success');
    }
    if (pkg.local.pinned === v.version) {
      badge('pinned', 'badge-ghost');
    }
    text.appendChild(head);
    const meta = document.createElement('div');
    meta.className = 'text-[11px] text-base-content/50';
    const when = v.status === 'published'
      ? `Published ${HubText.ago(v.publishedAt, this.now())}`
      : 'Only you see this version until an admin approves it';
    meta.textContent = [when, v.minEngine ? `Engine ≥ ${v.minEngine}` : null, v.sdkVersion !== null ? `SDK ${v.sdkVersion}` : null, v.size !== null ? HubPackageView.bytes(v.size) : null]
      .filter(Boolean).join(' · ');
    text.appendChild(meta);
    if (v.yanked) {
      const yanked = document.createElement('p');
      yanked.dataset.ref = 'yank-reason';
      yanked.className = 'text-[11px] text-base-content/75 leading-snug';
      yanked.textContent = v.yanked.reason ? `Yanked: ${v.yanked.reason}` : 'Yanked by its publisher';
      yanked.title = 'Installs by name skip a yanked version; a project that pins it keeps installing it by its exact version.';
      text.appendChild(yanked);
    }
    if (v.notes) {
      const notes = document.createElement('p');
      notes.className = 'text-xs text-base-content/75 leading-snug';
      notes.textContent = v.notes;
      text.appendChild(notes);
    }
    const status = this.versionInstalls.get(v.version);
    if (status) {
      const said = document.createElement('p');
      said.dataset.ref = 'version-status';
      said.className = 'text-[11px] text-base-content/60 leading-snug';
      said.textContent = status;
      text.appendChild(said);
    }
    row.appendChild(text);
    const runs = v.status === 'published' && !v.removed
      && (!v.minEngine || !engine.engine || HubText.compareVersions(v.minEngine, engine.engine) <= 0)
      && (v.sdkVersion === null || engine.sdk === null || v.sdkVersion === engine.sdk);
    if (runs && !pkg.local.installed.includes(v.version)) {
      const install = document.createElement('button');
      install.type = 'button';
      install.dataset.ref = 'install-version';
      install.className = 'btn btn-ghost btn-xs font-normal shrink-0';
      install.textContent = 'Install';
      install.title = 'Installs this version into your library';
      install.addEventListener('click', () => void this.installVersion(pkg, v.version, install));
      row.appendChild(install);
    }
    return row;
  }

  /** A version from the list: into the library, pinned only when the project uses no version of the package yet. */
  private async installVersion(pkg: HubPackage, version: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    button.textContent = 'Installing…';
    const inspected = await this.deps.hub.inspect({ name: pkg.name, version, target: 'library' });
    if (inspected.ok === false) {
      this.versionInstalls.set(version, HubInstallControl.refusal(inspected, { name: pkg.name, offered: version, local: pkg.local, projectOpen: this.deps.projectOpen(), host: this.host(), size: null }, version));
      this.render();
      return;
    }
    const pin = this.deps.projectOpen() && !pkg.local.pinned;
    const installed = await this.deps.packages.install({ token: inspected.inspection.token, target: 'library', pin });
    if (installed.ok === false) {
      this.versionInstalls.set(version, installed.error);
      this.render();
      return;
    }
    this.versionInstalls.set(version, pin ? `Installed ${version} in your library, and this project uses it.` : `Installed ${version} in your library.`);
    this.deps.onInstalled({ name: pkg.name, version, outcome: installed.outcome, upgrade: false });
    await this.reload();
  }

  // ---------------------------------------------------------------------------
  // Readme: the notes and README.md
  // ---------------------------------------------------------------------------

  private readme(pkg: HubPackage, into: HTMLElement): void {
    const latest = pkg.latest;
    const wrap = document.createElement('div');
    wrap.className = 'px-3 pb-6 pt-3 flex flex-col gap-3';
    into.appendChild(wrap);
    if (!latest) {
      wrap.appendChild(HubPackageView.note('Nothing of this package is published yet.'));
      return;
    }
    if (latest.notes) {
      const notes = document.createElement('div');
      notes.dataset.ref = 'notes';
      notes.className = 'rounded-md bg-base-200 px-3 py-2';
      const title = document.createElement('div');
      title.className = 'text-[11px] text-base-content/50';
      title.textContent = `Notes for ${latest.version}`;
      const text = document.createElement('p');
      text.className = 'text-xs text-base-content/85';
      text.textContent = latest.notes;
      notes.append(title, text);
      wrap.appendChild(notes);
    }
    const slot = document.createElement('div');
    slot.appendChild(HubPackageView.note('Reading the README…', true));
    wrap.appendChild(slot);
    void this.versionOf(pkg.name, latest.version).then(async (answer) => {
      if (answer.ok === false) {
        slot.replaceChildren(HubPackageView.note(answer.code === 'hub-unreachable' ? 'Couldn’t reach the hub to read the README.' : `Couldn’t read the README: ${answer.error}`, true));
        this.versions.delete(`${pkg.name}@${latest.version}`);
        return;
      }
      const url = answer.version.readmeUrl;
      if (!url) {
        slot.replaceChildren(HubPackageView.note(`${latest.version} has no README.md. The Features and Parts tabs list what it adds.`, true));
        return;
      }
      let text = this.readmes.get(url);
      if (!text) {
        text = this.deps.hub.text(url);
        this.readmes.set(url, text);
      }
      const read = await text;
      if (read.ok === false) {
        this.readmes.delete(url);
        slot.replaceChildren(HubPackageView.note(`Couldn’t read the README: ${read.error}`, true));
        return;
      }
      const rendered = HubMarkdown.render(read.text, (link) => this.deps.openExternal(link));
      const footnote = HubPackageView.note('Rendered as text and a Markdown subset; links open in your browser, images are not loaded.', true);
      slot.replaceChildren(rendered, footnote);
    });
  }

  // ---------------------------------------------------------------------------

  private failure(error: { code?: string; error: string }): HTMLDivElement {
    const box = document.createElement('div');
    box.dataset.state = error.code === 'hub-unreachable' ? 'offline' : 'error';
    box.className = 'flex flex-col items-center text-center gap-2 px-8 pt-14';
    if (error.code === 'hub-unreachable') {
      box.appendChild(HubIcons.span(HubIcons.OFFLINE, '[&>svg]:size-8 text-base-content/35'));
    }
    const title = document.createElement('p');
    title.className = 'text-sm font-medium text-base-content/85';
    title.textContent = error.code === 'hub-unreachable'
      ? `Couldn’t reach ${this.host() ?? 'the hub'}`
      : error.code === 'not-found' ? `${this.name} isn’t on the hub` : 'The hub refused this package';
    const text = document.createElement('p');
    text.className = 'text-xs text-base-content/60 leading-snug';
    text.textContent = error.code === 'hub-unreachable'
      ? 'Check the connection and try again. The packages in your library and in this project keep working.'
      : error.code === 'not-found' ? 'It may have been removed, or it isn’t published yet.' : error.error;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.dataset.ref = 'retry';
    retry.className = 'btn btn-sm mt-2 gap-1.5';
    retry.append(HubIcons.span(HubIcons.REFRESH, '[&>svg]:size-3.5'), 'Try again');
    retry.addEventListener('click', () => {
      if (this.name) {
        void this.show(this.name);
      }
    });
    box.append(title, text, retry);
    return box;
  }

  private static skeleton(): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.dataset.ref = 'loading';
    wrap.setAttribute('aria-busy', 'true');
    wrap.className = 'px-3 pt-3 flex flex-col gap-2.5';
    for (const cls of ['h-4 w-1/2', 'h-2.5 w-1/3', 'h-3 w-full', 'h-3 w-4/5', 'h-32 w-full rounded-md', 'h-8 w-36 rounded-md']) {
      const bar = document.createElement('div');
      bar.className = `skeleton ${cls}`;
      wrap.appendChild(bar);
    }
    return wrap;
  }

  private static note(text: string, flush = false): HTMLParagraphElement {
    const p = document.createElement('p');
    p.className = `${flush ? '' : 'px-3 py-3 '}text-[11px] text-base-content/55 leading-snug`;
    p.textContent = text;
    return p;
  }

  private host(): string | null {
    const url = this.deps.hubUrl();
    if (!url) {
      return null;
    }
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private static bytes(n: number): string {
    if (n < 1024) {
      return `${n} B`;
    }
    if (n < 1024 * 1024) {
      return `${(n / 1024).toFixed(1)} kB`;
    }
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
}
