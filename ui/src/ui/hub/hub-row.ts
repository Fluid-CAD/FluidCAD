import type { HubLocalMarks, HubSearchRow } from '../../api';
import { HubHandle } from './hub-handle';
import { HubIcons, HubImage } from './hub-icons';
import { HubText } from './hub-text';

/** The engine a search asked about: what the incompatibility message compares with. */
export type HubEngine = { engine: string | null; sdk: number | null };

/** What the badges read of a row: the detail builds the same shape from the package. */
export type HubBadgeSubject = Pick<HubSearchRow, 'version' | 'minEngine' | 'sdkVersion' | 'compatible' | 'deprecated'> & { local: HubLocalMarks };

/**
 * A package's marks (H11, from H9's row and the user's decisions on the
 * mock): why this FluidCAD can't run it (only when the hub says so), what
 * this machine has of it (installed, pinned, update available), and
 * Deprecated with its message on hover. Every value is set as text.
 */
export class HubBadges {
  static of(subject: HubBadgeSubject, engine: HubEngine): HTMLElement[] {
    const badges: HTMLElement[] = [];
    const { installed, pinned, updateAvailable } = subject.local;
    if (subject.compatible === false) {
      const reason = HubText.incompatibility(subject, engine.engine, engine.sdk);
      badges.push(HubBadges.tip(HubBadges.badge(reason.text, 'badge-soft badge-error', 'incompatible'), reason.tip));
    }
    if (installed.length > 0) {
      const label = installed.length === 1 && installed[0] === subject.version ? 'installed' : `installed ${installed.join(', ')}`;
      const badge = HubBadges.badge(label, 'badge-soft badge-success', 'installed');
      badge.title = 'In your library or this project\'s packages/ folder';
      badges.push(badge);
    }
    if (pinned) {
      const badge = HubBadges.badge(pinned === subject.version ? 'pinned' : `pinned ${pinned}`, 'badge-ghost', 'pinned');
      badge.title = `This project uses ${pinned}`;
      badges.push(badge);
    }
    if (updateAvailable) {
      const badge = HubBadges.badge('update available', 'badge-soft badge-info', 'update');
      badge.title = pinned ? `${updateAvailable} is on the hub; this project uses ${pinned}.` : `${updateAvailable} is on the hub.`;
      badges.push(badge);
    }
    if (subject.deprecated) {
      badges.push(HubBadges.tip(HubBadges.badge('Deprecated', 'badge-soft badge-warning', 'deprecated'), subject.deprecated));
    }
    return badges;
  }

  private static badge(text: string, look: string, mark: string): HTMLSpanElement {
    const badge = document.createElement('span');
    badge.className = `badge badge-xs text-hub-2xs ${look} whitespace-nowrap`;
    badge.dataset.mark = mark;
    badge.textContent = text;
    return badge;
  }

  /** The badge under a hover tip (daisyUI's), its text as `data-tip`. */
  private static tip(badge: HTMLElement, tip: string): HTMLSpanElement {
    const wrap = document.createElement('span');
    wrap.className = 'tooltip tooltip-bottom before:max-w-60 before:whitespace-normal';
    wrap.dataset.tip = tip;
    badge.setAttribute('aria-label', `${badge.textContent}: ${tip}`);
    wrap.appendChild(badge);
    return wrap;
  }
}

/**
 * One package in the results (the mock's row): the card thumb (through the
 * engine's media proxy), the mono name and version, the marks, two lines
 * of description, up to three feature chips and `+N` with the contents,
 * likes, installs, license and when it was last updated.
 *
 * The whole row opens the package; its keyboard face is a button laid over
 * the row ("Open @acme/kit"). The name's `@scope` is a control of its own
 * above it ({@link HubHandle}): it lists that publisher's packages and
 * doesn't open this one.
 */
export class HubResultRow {
  static create(
    row: HubSearchRow,
    engine: HubEngine,
    onOpen: (name: string) => void,
    onPublisher?: (handle: string) => void,
    now: number = Date.now(),
  ): HTMLDivElement {
    const el = document.createElement('div');
    el.dataset.package = row.fullName;
    el.className = 'group relative w-full text-left flex gap-3 px-3 py-3 border-b border-base-content/[0.07] hover:bg-base-content/[0.04] cursor-pointer';
    el.addEventListener('click', () => onOpen(row.fullName));
    const open = document.createElement('button');
    open.type = 'button';
    open.dataset.ref = 'open';
    open.className = 'absolute inset-0 w-full h-full outline-none focus-visible:bg-base-content/[0.05] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40';
    open.setAttribute('aria-label', `Open ${row.fullName}`);
    el.appendChild(open);

    const thumb = document.createElement('span');
    thumb.dataset.ref = 'thumb';
    thumb.className = `size-14 shrink-0 rounded-md bg-base-200 border border-base-content/[0.06] overflow-hidden grid place-items-center${row.compatible === false ? ' opacity-60' : ''}`;
    const placeholder = () => HubIcons.span(HubIcons.BOX, '[&>svg]:size-6 text-base-content/30');
    thumb.appendChild(row.cardImageUrl ? HubImage.create(row.cardImageUrl, 'size-full object-cover', placeholder) : placeholder());

    const body = document.createElement('span');
    body.className = 'flex-1 min-w-0 flex flex-col gap-1';

    const head = document.createElement('span');
    head.className = 'flex items-baseline gap-1.5 min-w-0';
    head.appendChild(HubResultRow.name(row.fullName, 'text-hub-md', onPublisher));
    const version = document.createElement('span');
    version.dataset.ref = 'version';
    version.className = 'font-mono text-hub-xs text-base-content/45 tabular-nums shrink-0';
    version.textContent = row.version;
    head.appendChild(version);
    body.appendChild(head);

    const badges = HubBadges.of(row, engine);
    if (badges.length > 0) {
      const marks = document.createElement('span');
      marks.dataset.ref = 'marks';
      marks.className = 'flex flex-wrap gap-1';
      marks.append(...badges);
      body.appendChild(marks);
    }

    if (row.description) {
      const description = document.createElement('span');
      description.dataset.ref = 'description';
      description.className = 'text-hub-sm text-base-content/70 leading-snug line-clamp-2';
      description.textContent = row.description;
      body.appendChild(description);
    }

    const contents = HubText.contents(row.counts);
    if (row.features.length > 0 || contents) {
      const line = document.createElement('span');
      line.className = 'flex items-center gap-1 flex-wrap';
      for (const feature of row.features) {
        line.appendChild(HubResultRow.chip(feature.label, feature.iconUrl));
      }
      if (row.moreFeatures > 0) {
        const more = document.createElement('span');
        more.dataset.ref = 'more';
        more.className = 'text-hub-xs text-base-content/50 tabular-nums';
        more.textContent = `+${row.moreFeatures}`;
        line.appendChild(more);
      }
      if (contents) {
        const counts = document.createElement('span');
        counts.className = `text-hub-xs text-base-content/50 whitespace-nowrap${row.features.length > 0 ? ' ml-1' : ''}`;
        counts.textContent = contents;
        line.appendChild(counts);
      }
      body.appendChild(line);
    }

    // Each fact stays whole: in a narrow panel the last ones move to a line of their own rather than breaking.
    const facts = document.createElement('span');
    facts.className = 'flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-hub-xs text-base-content/50 [&>*]:whitespace-nowrap';
    facts.append(
      HubResultRow.stat(HubIcons.HEART, row.likes, 'Likes'),
      HubResultRow.stat(HubIcons.DOWNLOAD, row.installs, 'Installs'),
    );
    const license = document.createElement('span');
    license.dataset.ref = 'license';
    license.textContent = HubText.license(row.license);
    facts.appendChild(license);
    const updated = document.createElement('span');
    updated.className = 'ml-auto';
    updated.textContent = HubText.ago(row.updatedAt, now);
    facts.appendChild(updated);
    body.appendChild(facts);

    el.append(thumb, body);
    return el;
  }

  /**
   * `@acme/feature-tests`, the scope dimmed; with `onPublisher`, the scope
   * is a {@link HubHandle} that lists the publisher's packages.
   */
  static name(fullName: string, size: 'text-hub-md' | 'text-hub-xl', onPublisher?: (handle: string) => void): HTMLSpanElement {
    const slash = fullName.indexOf('/');
    const name = document.createElement('span');
    name.dataset.ref = 'name';
    name.className = `font-mono ${size} font-medium text-base-content/90 truncate min-w-0`;
    const scope = document.createElement('span');
    scope.className = 'text-base-content/45';
    const handle = onPublisher ? HubHandle.scopeOf(fullName) : null;
    if (handle && onPublisher) {
      // Above the row's own button, so the scope takes its own clicks.
      scope.classList.add('relative', 'z-[1]');
      scope.append(HubHandle.button(handle, onPublisher), '/');
    } else {
      scope.textContent = slash > 0 ? fullName.slice(0, slash + 1) : '';
    }
    name.append(scope, document.createTextNode(slash > 0 ? fullName.slice(slash + 1) : fullName));
    return name;
  }

  private static chip(label: string, iconUrl: string | null): HTMLSpanElement {
    const chip = document.createElement('span');
    chip.dataset.ref = 'chip';
    chip.className = 'inline-flex items-center gap-1 h-5 pl-1 pr-1.5 rounded bg-base-200 text-hub-xs text-base-content/75 max-w-[9rem]';
    if (iconUrl) {
      chip.appendChild(HubImage.create(iconUrl, 'size-3.5 object-contain shrink-0'));
    }
    const text = document.createElement('span');
    text.className = 'truncate';
    text.textContent = label;
    chip.appendChild(text);
    return chip;
  }

  private static stat(icon: string, value: number, title: string): HTMLSpanElement {
    const stat = document.createElement('span');
    stat.className = 'inline-flex items-center gap-0.5';
    stat.title = title;
    stat.appendChild(HubIcons.span(icon, '[&>svg]:size-3'));
    const text = document.createElement('span');
    text.className = 'tabular-nums';
    text.textContent = HubText.count(value);
    stat.appendChild(text);
    return stat;
  }
}
