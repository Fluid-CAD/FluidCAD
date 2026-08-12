import { ToolbarScroller } from './toolbar-scroller';

/**
 * Which workbench a tool group belongs to. The bar shows only the groups of
 * the current mode — part-design tools while a part is open, assembly tools
 * while an assembly is open. Everything registered before the mode concept
 * existed is a part-design group, so `'part'` is the default.
 */
export type NavbarMode = 'part' | 'assembly';

/**
 * A group's workbench membership: one mode, or `'all'` for tools that serve
 * both benches (the Connector tool — parts declare connectors, and from an
 * assembly view it writes into the picked part's own file).
 */
export type NavbarGroupMode = NavbarMode | 'all';

interface ToolbarGroup {
  key: string;
  host: HTMLDivElement;
  /** Divider rendered *before* this group; shown only when a visible group precedes it. */
  divider: HTMLDivElement;
  /** Intended visibility — true when any contributor slot votes visible. */
  visible: boolean;
  /**
   * Per-contributor visibility votes. A group shared by several services
   * (the create group hosts the Sketch and Extrude buttons from different
   * owners) shows while any contributor still needs it.
   */
  slots: Map<string, boolean>;
  /** When visible, suppresses every non-exclusive group (takes over the bar). */
  exclusive: boolean;
  /**
   * `'end'` groups always render after every `'start'` group and are immune to
   * the exclusive-group takeover — used for trailing status groups (region /
   * trim picking) that must stay last and remain visible even while the sketch
   * toolbar owns the bar.
   */
  anchor: 'start' | 'end';
  /**
   * A `'start'` group that survives the exclusive-group takeover in place —
   * used for the create-feature group, which must stay reachable while the
   * sketch toolbar owns the bar (extruding is how a sketch gets finished).
   */
  immune: boolean;
  /** Workbench this group belongs to — hidden while the bar is in another mode ('all' always shows). */
  mode: NavbarGroupMode;
}

/**
 * The secondary tool bar, docked directly below the {@link TopBar}. It is
 * always present so the layout stays stable, and hosts an ordered set of tool
 * *groups*. Each group is shown or hidden independently (via
 * {@link setGroupVisible}) as its activation conditions change — e.g. the
 * sketch group appears only while a sketch is active. Dividers between groups
 * are managed automatically so only visible groups are separated.
 *
 * The groups do not sit on the bar directly but on a {@link ToolbarScroller}
 * track, which lets the bar hold more tools than the window is wide and offers
 * scroll arrows when it does.
 */
export class Navbar {
  private el: HTMLDivElement;
  private scroller: ToolbarScroller;
  private groups: ToolbarGroup[] = [];
  /** The visible groups behind the last reflow, to spot a wholesale swap. */
  private visibleSignature = '';
  /** Current workbench — only groups of this mode are shown. */
  private mode: NavbarMode = 'part';

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className =
      'absolute top-12 left-0 right-0 h-14 z-[120] flex items-center px-2 ' +
      'panel-bg border-b border-base-content/10 select-none';
    container.appendChild(this.el);
    // Toolbar buttons never take keyboard focus from a click. A clicked
    // button would otherwise hold focus indefinitely, and when the window is
    // re-activated (Alt-Tab back) the browser re-matches the focused element
    // as :focus-visible — which drops daisyUI's soft/ghost styling and flips
    // an armed tool to solid primary under its muted caption. Click handling
    // and Tab focus are unaffected.
    this.el.addEventListener('mousedown', (e) => {
      if (e.target instanceof Element && e.target.closest('button')) {
        e.preventDefault();
      }
    });
    this.scroller = new ToolbarScroller(this.el);
  }

  /**
   * Register a tool group (in call order) and return its content host to fill
   * with buttons. `visible` controls whether the group is shown initially;
   * `exclusive` groups hide every other group whenever they are visible.
   */
  addGroup(
    key: string,
    opts: { visible?: boolean; exclusive?: boolean; anchor?: 'start' | 'end'; immune?: boolean; mode?: NavbarGroupMode } = {},
  ): HTMLElement {
    const divider = document.createElement('div');
    divider.className = 'w-px h-8 bg-base-content/[0.12] mx-1 shrink-0 hidden';

    // Buttons sit close together inside a group; the dividers carry the
    // separation between groups, so the bar fits more tools before it scrolls.
    const host = document.createElement('div');
    host.className = 'flex items-center gap-0.5 shrink-0';

    const group: ToolbarGroup = {
      key,
      host,
      divider,
      visible: opts.visible ?? true,
      slots: new Map([['default', opts.visible ?? true]]),
      exclusive: opts.exclusive ?? false,
      anchor: opts.anchor ?? 'start',
      immune: opts.immune ?? false,
      mode: opts.mode ?? 'part',
    };

    // Keep 'end'-anchored groups after every 'start' group in both the array
    // and the DOM, so a trailing group stays last even when 'start' groups are
    // registered later.
    const firstEnd = group.anchor === 'start'
      ? this.groups.find((g) => g.anchor === 'end')
      : undefined;
    const track = this.scroller.track;
    if (firstEnd) {
      this.groups.splice(this.groups.indexOf(firstEnd), 0, group);
      track.insertBefore(divider, firstEnd.divider);
      track.insertBefore(host, firstEnd.divider);
    } else {
      this.groups.push(group);
      track.appendChild(divider);
      track.appendChild(host);
    }
    this.reflow();
    return host;
  }

  /**
   * Show or hide a group as its activation condition changes. A `slot` names
   * the contributor for groups with several owners — the group shows while
   * any slot votes visible (each owner still hides its own buttons).
   */
  setGroupVisible(key: string, visible: boolean, slot = 'default'): void {
    const group = this.groups.find((g) => g.key === key);
    if (!group) {
      return;
    }
    group.slots.set(slot, visible);
    const next = [...group.slots.values()].some(Boolean);
    if (group.visible === next) {
      return;
    }
    group.visible = next;
    this.reflow();
  }

  /** Content host of an already-registered group, for a second contributor. */
  getGroup(key: string): HTMLElement | null {
    return this.groups.find((g) => g.key === key)?.host ?? null;
  }

  /**
   * Swap the bar to the given workbench. Groups of the other mode disappear
   * wholesale (their owners' visibility votes are kept, so flipping back
   * restores the bar exactly as it was).
   */
  setMode(mode: NavbarMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    this.reflow();
  }

  /** A group shows only if its condition holds and no exclusive group is overriding it. */
  private isEffectivelyVisible(group: ToolbarGroup): boolean {
    if (group.mode !== 'all' && group.mode !== this.mode) {
      return false;
    }
    if (!group.visible) {
      return false;
    }
    // Trailing status groups and immune groups show whenever they have
    // content, even while an exclusive group (e.g. the sketch toolbar) has
    // taken over the bar.
    if (group.anchor === 'end' || group.immune) {
      return true;
    }
    // An exclusive group in the *other* mode is off-bar and must not
    // suppress anything (a lingering sketch-group vote while the scene
    // flips to assembly would otherwise blank the assembly tools).
    const exclusiveActive = this.groups.some(
      (g) => g.exclusive && g.visible && (g.mode === 'all' || g.mode === this.mode),
    );
    return exclusiveActive ? group.exclusive : true;
  }

  /** Apply effective visibility to each group and show a leading divider only
   *  for visible groups that follow another visible group. */
  private reflow(): void {
    let seenVisible = false;
    const visibleKeys: string[] = [];
    for (const group of this.groups) {
      const visible = this.isEffectivelyVisible(group);
      group.host.classList.toggle('hidden', !visible);
      group.divider.classList.toggle('hidden', !(visible && seenVisible));
      if (visible) {
        seenVisible = true;
        visibleKeys.push(group.key);
      }
    }

    // A different set of groups is a different toolbar — entering sketch mode
    // swaps the bar wholesale — so show it from the start rather than stranding
    // the user mid-scroll in tools they have never seen. Buttons appearing and
    // disappearing *within* the same groups only re-measures.
    const signature = visibleKeys.join(',');
    if (signature === this.visibleSignature) {
      this.scroller.refresh();
    } else {
      this.visibleSignature = signature;
      this.scroller.reset();
    }
  }
}
