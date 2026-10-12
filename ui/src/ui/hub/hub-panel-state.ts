import type { HubClient, HubContents, HubOrder, HubSearchAnswer, HubSearchParams, HubSort, HubUnits } from '../../api';

/** What the results area shows. */
export type HubSearchMode = 'idle' | 'loading' | 'results' | 'offline' | 'error';

/** A filter the panel toggles, by the hub's parameter name. */
export type HubFilter = 'contents' | 'keyword' | 'units' | 'license';

export type HubSearchSnapshot = {
  params: Readonly<HubSearchParams>;
  mode: HubSearchMode;
  /** The last answer for the current request, kept while a quiet refresh runs. */
  answer: HubSearchAnswer | null;
  /** The bridge's sentence for `offline` and `error`. */
  error: string | null;
};

/** The timer functions the state debounces with (tests pass fake ones). */
export type HubTimers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

/**
 * The Hub panel's search (hub-plan H11): the request in the hub's
 * canonical fields (`q`, `contents`, `keyword`, `units`, `license`, `sort`,
 * `order`, `page`), the answer, and what the results area shows.
 *
 * - Typing is debounced ({@link DEBOUNCE_MS}); a filter, the sort, its
 *   direction or a page searches at once.
 * - A new search aborts the one in flight, and an answer that arrives
 *   after a newer search started is dropped.
 * - Changing anything but the page goes back to page 1; picking a sort
 *   takes its own direction (`order` null), and the direction is flipped
 *   against the one the hub answered with.
 * - Every package is listed (decision 2): there is no compatibility filter.
 * - `hub-unreachable` is the offline state; any other refusal shows its
 *   sentence.
 */
export class HubPanelState {
  static readonly DEBOUNCE_MS = 250;
  static readonly EMPTY: Readonly<HubSearchParams> = Object.freeze({
    q: '',
    contents: [],
    keyword: [],
    units: [],
    license: [],
    sort: null,
    order: null,
    page: 1,
  });

  private params: HubSearchParams = HubPanelState.copy(HubPanelState.EMPTY);
  private mode: HubSearchMode = 'idle';
  private answer: HubSearchAnswer | null = null;
  private error: string | null = null;
  private controller: AbortController | null = null;
  private timer: unknown = null;
  private sequence = 0;
  private readonly listeners = new Set<(snapshot: HubSearchSnapshot) => void>();

  constructor(
    private readonly client: HubClient,
    private readonly timers: HubTimers = { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as number) },
  ) {}

  get snapshot(): HubSearchSnapshot {
    return {
      params: HubPanelState.copy(this.params),
      mode: this.mode,
      answer: this.answer,
      error: this.error,
    };
  }

  /** Whether a search ran at least once (the panel's first open starts one). */
  get started(): boolean {
    return this.mode !== 'idle';
  }

  subscribe(listener: (snapshot: HubSearchSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The words typed: searched once typing pauses. */
  setQuery(q: string): void {
    if (q === this.params.q) {
      return;
    }
    this.params.q = q;
    this.params.page = 1;
    this.schedule();
  }

  /** Turn one value of a filter on or off. */
  toggle(filter: HubFilter, value: string): void {
    const list = this.params[filter] as string[];
    const at = list.indexOf(value);
    if (at >= 0) {
      list.splice(at, 1);
    } else {
      list.push(value);
    }
    this.params.page = 1;
    this.search();
  }

  clearFilters(): void {
    this.params.contents = [];
    this.params.keyword = [];
    this.params.units = [];
    this.params.license = [];
    this.params.page = 1;
    this.search();
  }

  /** A sort from the dropdown, in its own direction; null gives the hub's default. */
  setSort(sort: HubSort | null): void {
    this.params.sort = sort;
    this.params.order = null;
    this.params.page = 1;
    this.search();
  }

  /** The direction icon: the other way from the one the results run. Best match has one direction. */
  flipOrder(): void {
    const sort = this.effectiveSort();
    if (sort === 'relevance') {
      return;
    }
    this.params.sort = sort;
    this.params.order = this.effectiveOrder() === 'desc' ? 'asc' : 'desc';
    this.params.page = 1;
    this.search();
  }

  setPage(page: number): void {
    if (page < 1 || page === this.params.page) {
      return;
    }
    this.params.page = page;
    this.search();
  }

  /** Search now (Enter, Try again, a filter), dropping a pending debounce. */
  search(): void {
    this.cancelTimer();
    void this.run(false);
  }

  /** The same request again without the loading state: the marks after an install. */
  refresh(): void {
    if (!this.started) {
      return;
    }
    this.cancelTimer();
    void this.run(true);
  }

  /**
   * The sort the results run by: the hub's echo when the answer is for this
   * request, else the asked sort, else the hub's default (Best match with
   * words, Most installed without).
   */
  effectiveSort(): HubSort {
    if (this.answer && this.answerIsCurrent()) {
      return this.answer.request.sort;
    }
    const words = HubPanelState.hasWords(this.params.q);
    if (this.params.sort && !(this.params.sort === 'relevance' && !words)) {
      return this.params.sort;
    }
    return words ? 'relevance' : 'installs';
  }

  /** The direction the results run: Best match's only one, else the asked one or the sort's own (`desc`). */
  effectiveOrder(): HubOrder {
    const sort = this.effectiveSort();
    if (sort === 'relevance') {
      return 'desc';
    }
    if (this.params.order) {
      return this.params.order;
    }
    return this.answer && this.answerIsCurrent() ? this.answer.request.order ?? 'desc' : 'desc';
  }

  /** Whether `q` holds a word beyond `@handle`s: what makes Best match available. */
  static hasWords(q: string): boolean {
    return q.split(/\s+/).some((token) => token !== '' && !/^@[a-z][a-z0-9-]*(\/.*)?$/i.test(token)) || /@[a-z][a-z0-9-]*\/\S+/i.test(q);
  }

  dispose(): void {
    this.cancelTimer();
    this.controller?.abort();
    this.controller = null;
    this.listeners.clear();
  }

  private schedule(): void {
    this.cancelTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.run(false);
    }, HubPanelState.DEBOUNCE_MS);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  private async run(quiet: boolean): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const ticket = ++this.sequence;
    const params = HubPanelState.copy(this.params);
    if (!quiet || this.mode !== 'results') {
      this.mode = 'loading';
      this.error = null;
      this.emit();
    }
    const result = await this.client.search(params, controller.signal);
    if (ticket !== this.sequence) {
      return;
    }
    this.controller = null;
    if (result.ok === false) {
      if (result.code === 'aborted') {
        return;
      }
      this.answer = null;
      this.mode = result.code === 'hub-unreachable' ? 'offline' : 'error';
      this.error = result.error;
      this.emit();
      return;
    }
    this.answer = result.answer;
    this.mode = 'results';
    this.error = null;
    this.emit();
  }

  /** The answer was made for the request now held (an answer to an older query isn't). */
  private answerIsCurrent(): boolean {
    return this.answer !== null && this.answer.page === this.params.page && this.mode === 'results';
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of [...this.listeners]) {
      listener(snapshot);
    }
  }

  private static copy(params: Readonly<HubSearchParams>): HubSearchParams {
    return {
      ...params,
      contents: [...params.contents] as HubContents[],
      keyword: [...params.keyword],
      units: [...params.units] as HubUnits[],
      license: [...params.license],
    };
  }
}
