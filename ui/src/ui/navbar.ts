interface ToolbarGroup {
  key: string;
  host: HTMLDivElement;
  /** Divider rendered *before* this group; shown only when a visible group precedes it. */
  divider: HTMLDivElement;
  /** Intended visibility from the group's activation condition. */
  visible: boolean;
  /** When visible, suppresses every non-exclusive group (takes over the bar). */
  exclusive: boolean;
  /**
   * `'end'` groups always render after every `'start'` group and are immune to
   * the exclusive-group takeover — used for trailing status groups (region /
   * trim picking) that must stay last and remain visible even while the sketch
   * toolbar owns the bar.
   */
  anchor: 'start' | 'end';
}

/**
 * The secondary tool bar, docked directly below the {@link TopBar}. It is
 * always present so the layout stays stable, and hosts an ordered set of tool
 * *groups*. Each group is shown or hidden independently (via
 * {@link setGroupVisible}) as its activation conditions change — e.g. the
 * sketch group appears only while a sketch is active. Dividers between groups
 * are managed automatically so only visible groups are separated.
 */
export class Navbar {
  private el: HTMLDivElement;
  private groups: ToolbarGroup[] = [];

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className =
      'absolute top-12 left-0 right-0 h-11 z-[120] flex items-center px-2 ' +
      'panel-bg border-b border-base-content/10 select-none';
    container.appendChild(this.el);
  }

  /**
   * Register a tool group (in call order) and return its content host to fill
   * with buttons. `visible` controls whether the group is shown initially;
   * `exclusive` groups hide every other group whenever they are visible.
   */
  addGroup(
    key: string,
    opts: { visible?: boolean; exclusive?: boolean; anchor?: 'start' | 'end' } = {},
  ): HTMLElement {
    const divider = document.createElement('div');
    divider.className = 'w-px h-5 bg-base-content/[0.12] mx-1 shrink-0 hidden';

    const host = document.createElement('div');
    host.className = 'flex items-center gap-0.5';

    const group: ToolbarGroup = {
      key,
      host,
      divider,
      visible: opts.visible ?? true,
      exclusive: opts.exclusive ?? false,
      anchor: opts.anchor ?? 'start',
    };

    // Keep 'end'-anchored groups after every 'start' group in both the array
    // and the DOM, so a trailing group stays last even when 'start' groups are
    // registered later.
    const firstEnd = group.anchor === 'start'
      ? this.groups.find((g) => g.anchor === 'end')
      : undefined;
    if (firstEnd) {
      this.groups.splice(this.groups.indexOf(firstEnd), 0, group);
      this.el.insertBefore(divider, firstEnd.divider);
      this.el.insertBefore(host, firstEnd.divider);
    } else {
      this.groups.push(group);
      this.el.appendChild(divider);
      this.el.appendChild(host);
    }
    this.reflow();
    return host;
  }

  /** Show or hide a group as its activation condition changes. */
  setGroupVisible(key: string, visible: boolean): void {
    const group = this.groups.find((g) => g.key === key);
    if (!group || group.visible === visible) {
      return;
    }
    group.visible = visible;
    this.reflow();
  }

  /** A group shows only if its condition holds and no exclusive group is overriding it. */
  private isEffectivelyVisible(group: ToolbarGroup): boolean {
    if (!group.visible) {
      return false;
    }
    // Trailing status groups show whenever they have content, even while an
    // exclusive group (e.g. the sketch toolbar) has taken over the bar.
    if (group.anchor === 'end') {
      return true;
    }
    const exclusiveActive = this.groups.some((g) => g.exclusive && g.visible);
    return exclusiveActive ? group.exclusive : true;
  }

  /** Apply effective visibility to each group and show a leading divider only
   *  for visible groups that follow another visible group. */
  private reflow(): void {
    let seenVisible = false;
    for (const group of this.groups) {
      const visible = this.isEffectivelyVisible(group);
      group.host.classList.toggle('hidden', !visible);
      group.divider.classList.toggle('hidden', !(visible && seenVisible));
      if (visible) {
        seenVisible = true;
      }
    }
  }
}
