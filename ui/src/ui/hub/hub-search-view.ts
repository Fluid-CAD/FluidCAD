import type { HubSearchAnswer, HubSort } from '../../api';
import { HubIcons } from './hub-icons';
import type { HubFilter, HubPanelState, HubSearchSnapshot } from './hub-panel-state';
import { HubResultRow, type HubEngine } from './hub-row';
import { HubText } from './hub-text';

export type HubSearchViewDeps = {
  state: HubPanelState;
  /** Open a package's detail. */
  onOpen(name: string): void;
  /** A row's `@scope` was clicked: list that publisher's packages. */
  onPublisher?(handle: string): void;
  /** The hub's host for sentences (`hub.fluidcad.io`), once the status is known. */
  hubHost(): string | null;
  /** This FluidCAD's version and SDK, from the status, before an answer echoes them. */
  engine(): HubEngine;
};

/** A filter's dropdown: its label and how its values are listed. */
type FilterMenu = { filter: HubFilter; label: string };

/**
 * The Hub panel's search (hub-plan H11, the signed-off mock with the user's
 * decisions): the search field (`@handle` narrows to a publisher), the three
 * filters as dropdown buttons with the hub's facet counts (Contents, Units,
 * License; no Keywords: *(2026-10-12, user: keywords only feed search
 * matching)*), the result count, the sort control (decision
 * 1: the direction icon flips the order, disabled on Best match; the name
 * opens the five sorts, Best match only with words), the active filters as
 * removable chips, then the rows, the pager, or the loading, empty,
 * empty-with-filters, offline and error states. No compatibility toggle
 * (decision 2): every package is listed with its badge.
 *
 * The field is built once, so typing keeps the caret; everything else is
 * drawn again from each snapshot of {@link HubPanelState}.
 */
export class HubSearchView {
  static readonly FILTERS: readonly FilterMenu[] = [
    { filter: 'contents', label: 'Contents' },
    { filter: 'units', label: 'Units' },
    { filter: 'license', label: 'License' },
  ];
  private static readonly CONTENTS: readonly [string, string][] = [['features', 'Features'], ['parts', 'Parts'], ['assemblies', 'Assemblies']];
  private static readonly UNITS: readonly [string, string][] = [['metric', 'Metric'], ['imperial', 'Imperial']];
  /** Words the empty state suggests: shapes, not names. */
  private static readonly SUGGESTIONS = ['hole', 'standoff', 'hinge'];

  readonly el: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly spinner: HTMLSpanElement;
  private readonly filtersRow: HTMLDivElement;
  private readonly sortRow: HTMLDivElement;
  private readonly chipsRow: HTMLDivElement;
  private readonly body: HTMLDivElement;
  /** What the field last said as the user typed: a query set any other way (a clicked handle) replaces it even while it has focus. */
  private typed = '';
  private popover: HTMLDivElement | null = null;
  private openMenu: HubFilter | 'sort' | null = null;
  private snapshot: HubSearchSnapshot;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: HubSearchViewDeps) {
    this.el = document.createElement('div');
    this.el.dataset.role = 'hub-search';
    this.el.className = 'flex flex-col flex-1 min-h-0';

    this.head = document.createElement('div');
    this.head.className = 'flex flex-col gap-2 px-3 pt-3 pb-2.5 border-b border-base-content/10 shrink-0 relative';

    const field = document.createElement('label');
    field.className = 'input input-sm w-full gap-2 text-hub-sm';
    field.appendChild(HubIcons.span(HubIcons.SEARCH, '[&>svg]:size-4 text-base-content/45'));
    this.input = document.createElement('input');
    this.input.type = 'search';
    this.input.dataset.ref = 'query';
    this.input.className = 'grow';
    this.input.placeholder = 'Search packages, or @handle for a publisher';
    this.input.setAttribute('aria-label', 'Search the hub');
    this.input.addEventListener('input', () => {
      this.typed = this.input.value;
      deps.state.setQuery(this.input.value);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        deps.state.search();
      }
    });
    this.spinner = document.createElement('span');
    this.spinner.className = 'loading loading-spinner loading-xs text-base-content/40 hidden';
    field.append(this.input, this.spinner);

    this.filtersRow = document.createElement('div');
    this.filtersRow.dataset.ref = 'filters';
    this.filtersRow.className = 'flex items-center gap-1 flex-wrap';
    this.sortRow = document.createElement('div');
    this.sortRow.className = 'flex items-center gap-2 min-w-0';
    this.chipsRow = document.createElement('div');
    this.chipsRow.dataset.ref = 'chips';
    this.chipsRow.className = 'flex flex-wrap items-center gap-1';
    this.head.append(field, this.filtersRow, this.sortRow, this.chipsRow);

    this.body = document.createElement('div');
    this.body.dataset.ref = 'results';
    this.body.className = 'flex-1 min-h-0 overflow-y-auto';

    this.el.append(this.head, this.body);
    this.snapshot = deps.state.snapshot;
    this.unsubscribe = deps.state.subscribe((snapshot) => this.render(snapshot));
    this.render(this.snapshot);
  }

  /** Put the caret in the field (the panel's first open). */
  focus(): void {
    this.input.focus();
  }

  destroy(): void {
    this.closeMenu();
    this.unsubscribe();
    this.el.remove();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(snapshot: HubSearchSnapshot): void {
    this.snapshot = snapshot;
    const typing = document.activeElement === this.input && snapshot.params.q === this.typed;
    if (!typing && this.input.value !== snapshot.params.q) {
      this.input.value = snapshot.params.q;
      this.typed = snapshot.params.q;
    }
    this.spinner.classList.toggle('hidden', snapshot.mode !== 'loading');
    this.renderFilters();
    this.renderSortRow();
    this.renderChips();
    this.renderBody();
    if (this.openMenu) {
      this.renderMenu(this.openMenu);
    }
  }

  private renderFilters(): void {
    const buttons = HubSearchView.FILTERS.map(({ filter, label }) => {
      const selected = this.snapshot.params[filter].length;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.filter = filter;
      button.className = `btn btn-xs text-hub-xs gap-1 font-normal ${selected > 0 ? 'btn-soft btn-primary' : 'btn-ghost border border-base-content/15'}${this.openMenu === filter ? ' ring-1 ring-primary/40' : ''}`;
      button.setAttribute('aria-haspopup', 'true');
      button.setAttribute('aria-expanded', String(this.openMenu === filter));
      button.append(label);
      if (selected > 0) {
        const count = document.createElement('span');
        count.className = 'tabular-nums font-medium';
        count.textContent = String(selected);
        button.appendChild(count);
      }
      button.appendChild(HubIcons.span(HubIcons.CHEVRON_DOWN, '[&>svg]:size-3 opacity-60'));
      button.addEventListener('click', () => this.toggleMenu(filter));
      return button;
    });
    this.filtersRow.replaceChildren(...buttons);
  }

  private renderSortRow(): void {
    const { answer, mode } = this.snapshot;
    const total = document.createElement('span');
    total.dataset.ref = 'total';
    total.className = 'text-hub-xs text-base-content/50 truncate';
    if (answer && mode === 'results') {
      const count = document.createElement('span');
      count.className = 'tabular-nums text-base-content/75';
      count.textContent = `${HubText.count(answer.total)}${answer.capped ? '+' : ''}`;
      total.append(count, ` ${answer.total === 1 && !answer.capped ? 'package' : 'packages'}`);
    }

    const sort = this.deps.state.effectiveSort();
    const order = this.deps.state.effectiveOrder();
    const control = document.createElement('div');
    control.dataset.ref = 'sort';
    control.className = 'ml-auto flex items-center shrink-0';
    const direction = document.createElement('button');
    direction.type = 'button';
    direction.dataset.ref = 'order';
    direction.className = 'btn btn-ghost btn-square btn-xs text-base-content/60';
    direction.disabled = sort === 'relevance';
    direction.title = sort === 'relevance' ? 'Best match has one direction: the best match first' : `${HubText.direction(sort, order)}. Click to reverse.`;
    direction.setAttribute('aria-label', direction.title);
    direction.dataset.order = order;
    direction.appendChild(HubIcons.span(order === 'asc' ? HubIcons.SORT_ASC : HubIcons.SORT_DESC, '[&>svg]:size-4'));
    direction.addEventListener('click', () => this.deps.state.flipOrder());
    const name = document.createElement('button');
    name.type = 'button';
    name.dataset.ref = 'sort-name';
    name.className = `btn btn-ghost btn-xs gap-1 font-normal text-hub-sm text-base-content/80 px-1.5${this.openMenu === 'sort' ? ' ring-1 ring-primary/40' : ''}`;
    name.setAttribute('aria-haspopup', 'true');
    name.setAttribute('aria-expanded', String(this.openMenu === 'sort'));
    name.title = 'Sort by';
    name.append(HubText.SORT_LABELS[sort]);
    name.appendChild(HubIcons.span(HubIcons.CHEVRON_DOWN, '[&>svg]:size-3 opacity-60'));
    name.addEventListener('click', () => this.toggleMenu('sort'));
    control.append(direction, name);
    this.sortRow.replaceChildren(total, control);
  }

  private renderChips(): void {
    const { params } = this.snapshot;
    const chips: HTMLElement[] = [];
    const add = (filter: HubFilter, value: string, label: string) => {
      const chip = document.createElement('span');
      chip.dataset.chip = `${filter}:${value}`;
      chip.className = 'badge badge-sm text-hub-sm badge-soft badge-primary gap-0.5 pr-1';
      chip.append(label);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'opacity-70 hover:opacity-100';
      remove.setAttribute('aria-label', `Remove ${label}`);
      remove.appendChild(HubIcons.span(HubIcons.CLOSE, '[&>svg]:size-3'));
      remove.addEventListener('click', () => this.deps.state.toggle(filter, value));
      chip.appendChild(remove);
      chips.push(chip);
    };
    for (const value of params.contents) {
      add('contents', value, HubSearchView.labelOf(HubSearchView.CONTENTS, value));
    }
    for (const value of params.units) {
      add('units', value, HubSearchView.labelOf(HubSearchView.UNITS, value));
    }
    for (const value of params.license) {
      add('license', value, value);
    }
    if (chips.length > 0) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.dataset.ref = 'clear-filters';
      clear.className = 'text-hub-xs text-base-content/55 hover:text-base-content hover:underline ml-1';
      clear.textContent = 'Clear filters';
      clear.addEventListener('click', () => this.deps.state.clearFilters());
      chips.push(clear);
    }
    this.chipsRow.replaceChildren(...chips);
    this.chipsRow.classList.toggle('hidden', chips.length === 0);
  }

  private renderBody(): void {
    const { mode, answer } = this.snapshot;
    const scroll = this.body.scrollTop;
    let content: HTMLElement[];
    if (mode === 'loading' || mode === 'idle') {
      content = [HubSearchView.skeleton()];
    } else if (mode === 'offline') {
      content = [this.offline()];
    } else if (mode === 'error') {
      content = [this.failure()];
    } else if (!answer || answer.total === 0) {
      content = [this.empty()];
    } else {
      const engine = this.engineOf(answer);
      content = [
        ...answer.results.map((row) => HubResultRow.create(
          row,
          engine,
          (name) => this.deps.onOpen(name),
          this.deps.onPublisher ? (handle) => this.deps.onPublisher!(handle) : undefined,
        )),
        this.footer(answer),
      ];
    }
    this.body.replaceChildren(...content);
    if (mode === 'results') {
      this.body.scrollTop = scroll;
    }
  }

  /** The engine the rows are compared with: the answer's echo, else the status. */
  private engineOf(answer: HubSearchAnswer): HubEngine {
    const status = this.deps.engine();
    return { engine: answer.request.engine ?? status.engine, sdk: answer.request.sdk ?? status.sdk };
  }

  private footer(answer: HubSearchAnswer): HTMLDivElement {
    const footer = document.createElement('div');
    footer.dataset.ref = 'footer';
    const first = (answer.page - 1) * answer.limit + 1;
    const last = first + answer.results.length - 1;
    const total = `${HubText.count(answer.total)}${answer.capped ? '+' : ''}`;
    const range = first === last ? `${HubText.count(first)} of ${total}` : `${HubText.count(first)}–${HubText.count(last)} of ${total}`;
    const more = last < answer.total;
    if (answer.page === 1 && !more) {
      footer.className = 'px-3 py-3 text-hub-xs text-base-content/50 text-center tabular-nums';
      footer.textContent = range;
      return footer;
    }
    footer.className = 'border-t border-base-content/[0.07]';
    const bar = document.createElement('div');
    bar.className = 'flex items-center gap-2 px-3 py-3';
    const text = document.createElement('span');
    text.dataset.ref = 'range';
    text.className = 'text-hub-xs text-base-content/55 tabular-nums';
    text.textContent = range;
    const pager = document.createElement('div');
    pager.className = 'join ml-auto';
    const previous = HubSearchView.pageButton('Previous', HubIcons.CHEVRON_LEFT, 'before', answer.page > 1, () => this.deps.state.setPage(answer.page - 1));
    const next = HubSearchView.pageButton('Next', HubIcons.CHEVRON_RIGHT, 'after', more, () => this.deps.state.setPage(answer.page + 1));
    pager.append(previous, next);
    bar.append(text, pager);
    footer.appendChild(bar);
    if (answer.capped && !more) {
      const note = document.createElement('p');
      note.dataset.ref = 'capped-note';
      note.className = 'px-3 pb-3 -mt-1 text-hub-xs text-base-content/55 leading-snug';
      note.textContent = `The hub lists the first ${HubText.count(answer.total)} matches. Add a word or a filter to see others.`;
      footer.appendChild(note);
    }
    return footer;
  }

  private static pageButton(label: string, icon: string, side: 'before' | 'after', enabled: boolean, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.ref = label === 'Next' ? 'next' : 'previous';
    button.className = 'btn btn-xs text-hub-xs join-item gap-0.5 font-normal';
    button.disabled = !enabled;
    const glyph = HubIcons.span(icon, '[&>svg]:size-3');
    if (side === 'before') {
      button.append(glyph, label);
    } else {
      button.append(label, glyph);
    }
    button.addEventListener('click', onClick);
    return button;
  }

  private static skeleton(): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.dataset.ref = 'loading';
    wrap.setAttribute('aria-busy', 'true');
    const bar = (cls: string) => {
      const el = document.createElement('div');
      el.className = `skeleton ${cls}`;
      return el;
    };
    for (const widths of [['w-5/12', 'w-11/12', 'w-7/12'], ['w-4/12', 'w-10/12', 'w-6/12'], ['w-6/12', 'w-full', 'w-5/12'], ['w-3/12', 'w-9/12', 'w-7/12']]) {
      const row = document.createElement('div');
      row.className = 'flex gap-3 px-3 py-3 border-b border-base-content/[0.07]';
      row.appendChild(bar('size-14 rounded-md shrink-0'));
      const lines = document.createElement('div');
      lines.className = 'flex-1 flex flex-col gap-2 pt-1';
      lines.append(bar(`h-3 ${widths[0]}`), bar(`h-2.5 ${widths[1]}`), bar(`h-2.5 ${widths[2]}`));
      row.appendChild(lines);
      wrap.appendChild(row);
    }
    return wrap;
  }

  private offline(): HTMLDivElement {
    const box = HubSearchView.centered('offline');
    box.appendChild(HubIcons.span(HubIcons.OFFLINE, '[&>svg]:size-8 text-base-content/35'));
    const host = this.deps.hubHost();
    box.appendChild(HubSearchView.line('text-hub-lg font-medium text-base-content/85', host ? `Couldn’t reach ${host}` : 'Couldn’t reach the hub'));
    box.appendChild(HubSearchView.line('text-hub-sm text-base-content/60 leading-snug',
      'Nothing was searched. Check the connection and try again. The packages in your library and in this project keep working.'));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.dataset.ref = 'retry';
    retry.className = 'btn btn-sm text-hub-sm mt-2 gap-1.5';
    retry.append(HubIcons.span(HubIcons.REFRESH, '[&>svg]:size-3.5'), 'Try again');
    retry.addEventListener('click', () => this.deps.state.search());
    box.appendChild(retry);
    return box;
  }

  private failure(): HTMLDivElement {
    const box = HubSearchView.centered('error');
    box.appendChild(HubSearchView.line('text-hub-lg font-medium text-base-content/85', 'The hub refused this search'));
    box.appendChild(HubSearchView.line('text-hub-sm text-base-content/60 leading-snug', this.snapshot.error ?? ''));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-sm text-hub-sm mt-2';
    retry.textContent = 'Clear filters';
    retry.addEventListener('click', () => this.deps.state.clearFilters());
    box.appendChild(retry);
    return box;
  }

  private empty(): HTMLDivElement {
    const { params } = this.snapshot;
    const filters = params.contents.length + params.units.length + params.license.length;
    const box = HubSearchView.centered('empty');
    if (filters > 0) {
      box.appendChild(HubSearchView.line('text-hub-lg font-medium text-base-content/85',
        params.q.trim() ? `No packages match “${params.q.trim()}” with these filters` : 'Nothing matches all of these filters'));
      box.appendChild(HubSearchView.line('text-hub-sm text-base-content/60 leading-snug max-w-72', 'Each filter keeps only the packages that pass it. Remove one to see more.'));
      const actions = document.createElement('div');
      actions.className = 'flex gap-1.5 mt-1';
      const lastFilter = HubSearchView.lastFilter(params);
      if (lastFilter && filters > 1) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.ref = 'remove-last';
        remove.className = 'btn btn-xs text-hub-xs font-normal';
        remove.textContent = `Remove ${lastFilter.label}`;
        remove.addEventListener('click', () => this.deps.state.toggle(lastFilter.filter, lastFilter.value));
        actions.appendChild(remove);
      }
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn btn-xs text-hub-xs btn-ghost font-normal';
      clear.textContent = 'Clear filters';
      clear.addEventListener('click', () => this.deps.state.clearFilters());
      actions.appendChild(clear);
      box.appendChild(actions);
      return box;
    }
    box.appendChild(HubSearchView.line('text-hub-lg font-medium text-base-content/85',
      params.q.trim() ? `No packages match “${params.q.trim()}”` : 'The hub has no packages yet'));
    if (params.q.trim()) {
      const help = document.createElement('p');
      help.className = 'text-hub-sm text-base-content/60 leading-snug max-w-72';
      help.append('Search reads package names, feature and part names, keywords, descriptions and @handles. Try the shape you need rather than its name: ');
      HubSearchView.SUGGESTIONS.forEach((word, index) => {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'link link-primary';
        link.textContent = word;
        link.addEventListener('click', () => {
          this.input.value = word;
          this.deps.state.setQuery(word);
          this.deps.state.search();
        });
        help.append(link, index < HubSearchView.SUGGESTIONS.length - 1 ? ', ' : '.');
      });
      box.appendChild(help);
    }
    return box;
  }

  private static centered(state: string): HTMLDivElement {
    const box = document.createElement('div');
    box.dataset.state = state;
    box.className = 'flex flex-col items-center text-center gap-2 px-8 pt-14';
    return box;
  }

  private static line(cls: string, text: string): HTMLParagraphElement {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = text;
    return p;
  }

  private static lastFilter(params: HubSearchSnapshot['params']): { filter: HubFilter; value: string; label: string } | null {
    const order: [HubFilter, readonly [string, string][] | null][] = [['license', null], ['units', HubSearchView.UNITS], ['contents', HubSearchView.CONTENTS]];
    for (const [filter, labels] of order) {
      const values = params[filter];
      if (values.length > 0) {
        const value = values[values.length - 1];
        return { filter, value, label: labels ? HubSearchView.labelOf(labels, value) : value };
      }
    }
    return null;
  }

  private static labelOf(labels: readonly [string, string][], value: string): string {
    return labels.find(([key]) => key === value)?.[1] ?? value;
  }

  // ---------------------------------------------------------------------------
  // Dropdowns: the filters' values with their counts, and the sorts
  // ---------------------------------------------------------------------------

  private toggleMenu(menu: HubFilter | 'sort'): void {
    if (this.openMenu === menu) {
      this.closeMenu();
      return;
    }
    this.closeMenu();
    this.openMenu = menu;
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    this.renderFilters();
    this.renderSortRow();
    this.renderMenu(menu);
  }

  private closeMenu(): void {
    if (this.openMenu === null) {
      return;
    }
    this.openMenu = null;
    this.popover?.remove();
    this.popover = null;
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.renderFilters();
    this.renderSortRow();
  }

  private renderMenu(menu: HubFilter | 'sort'): void {
    this.popover?.remove();
    const popover = document.createElement('div');
    popover.dataset.menu = menu;
    popover.className = 'absolute z-20 w-56 max-h-72 overflow-y-auto p-1.5 bg-base-100 border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)] flex flex-col';
    const anchor = menu === 'sort'
      ? this.sortRow.querySelector<HTMLElement>('[data-ref="sort-name"]')
      : this.filtersRow.querySelector<HTMLElement>(`[data-filter="${menu}"]`);
    const title = document.createElement('div');
    title.className = 'px-2 pt-0.5 pb-1 text-hub-xs text-base-content/55';
    popover.appendChild(title);
    if (menu === 'sort') {
      title.textContent = 'Sort by';
      for (const sort of this.sortChoices()) {
        popover.appendChild(this.sortOption(sort));
      }
    } else {
      const label = HubSearchView.FILTERS.find((f) => f.filter === menu)!.label;
      title.textContent = label;
      const values = this.menuValues(menu);
      if (values.length === 0) {
        popover.appendChild(HubSearchView.line('px-2 py-1 text-hub-sm text-base-content/50', this.snapshot.answer ? 'None in these results.' : 'Waiting for the hub…'));
      }
      for (const value of values) {
        popover.appendChild(this.check(menu, value));
      }
    }
    // Under its button, inside the head; pulled in from the right edge.
    const top = anchor ? anchor.offsetTop + anchor.offsetHeight + 4 : 0;
    popover.style.top = `${top}px`;
    if (menu === 'sort') {
      popover.style.right = '12px';
    } else {
      popover.style.left = `${Math.max(12, Math.min(anchor?.offsetLeft ?? 12, this.head.clientWidth - 236))}px`;
    }
    this.head.appendChild(popover);
    this.popover = popover;
  }

  /** The five sorts, Best match only with words. */
  private sortChoices(): HubSort[] {
    const words = this.snapshot.answer ? this.snapshot.answer.request.words.length > 0 : false;
    const typed = this.snapshot.params.q.trim() !== '';
    return HubText.SORTS.filter((sort) => sort !== 'relevance' || words || (typed && !this.snapshot.answer));
  }

  private sortOption(sort: HubSort): HTMLButtonElement {
    const current = this.deps.state.effectiveSort() === sort;
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.sort = sort;
    option.className = `flex items-center gap-2 px-2 py-1 rounded text-hub-sm text-left hover:bg-base-content/[0.06]${current ? ' text-primary font-medium' : ''}`;
    const tick = HubIcons.span(HubIcons.CHECK, `[&>svg]:size-3.5${current ? '' : ' invisible'}`);
    option.append(tick, HubText.SORT_LABELS[sort]);
    option.addEventListener('click', () => {
      this.closeMenu();
      this.deps.state.setSort(sort);
    });
    return option;
  }

  /** A filter's values with the hub's counts (each with every other filter applied), selected ones kept. */
  private menuValues(filter: HubFilter): { value: string; label: string; count: number | null }[] {
    const facets = this.snapshot.answer?.facets ?? null;
    const selected = this.snapshot.params[filter] as readonly string[];
    if (filter === 'contents') {
      return HubSearchView.CONTENTS.map(([value, label]) => ({ value, label, count: facets ? facets.contents[value as keyof typeof facets.contents] : null }));
    }
    if (filter === 'units') {
      return HubSearchView.UNITS.map(([value, label]) => ({ value, label, count: facets ? facets.units[value as keyof typeof facets.units] : null }));
    }
    const licenses = (facets?.licenses ?? []).map((l) => ({ value: l.value, label: l.label, count: l.count as number | null }));
    for (const value of selected) {
      if (!licenses.some((l) => l.value === value)) {
        licenses.push({ value, label: value, count: facets ? 0 : null });
      }
    }
    return licenses;
  }

  private check(filter: HubFilter, entry: { value: string; label: string; count: number | null }): HTMLLabelElement {
    const checked = (this.snapshot.params[filter] as readonly string[]).includes(entry.value);
    const row = document.createElement('label');
    row.dataset.value = entry.value;
    row.className = `flex items-center gap-2 px-2 py-1 rounded hover:bg-base-content/[0.06] text-hub-sm cursor-pointer${entry.count === 0 && !checked ? ' opacity-50' : ''}`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'checkbox checkbox-xs checkbox-primary rounded-[3px]';
    input.checked = checked;
    input.addEventListener('change', () => this.deps.state.toggle(filter, entry.value));
    const label = document.createElement('span');
    label.className = 'truncate';
    label.textContent = entry.label;
    const count = document.createElement('span');
    count.dataset.ref = 'count';
    count.className = 'ml-auto tabular-nums text-base-content/45 text-hub-xs';
    count.textContent = entry.count === null ? '' : HubText.count(entry.count);
    row.append(input, label, count);
    return row;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    const target = e.target as Node;
    if (this.popover?.contains(target)) {
      return;
    }
    const button = (target as Element).closest?.('[data-filter], [data-ref="sort-name"]');
    if (button && this.head.contains(button)) {
      return;
    }
    this.closeMenu();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      this.closeMenu();
    }
  };
}
