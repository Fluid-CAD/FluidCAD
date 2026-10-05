/** A visible gap in the tree and the source statement immediately below it. */
export interface BreakpointStop {
  before: HTMLElement | null;
  label: string;
  source: { line: number; column: number } | null;
}

interface BarState {
  stops: BreakpointStop[];
  current: number;
  paused: boolean;
  disabled: boolean;
  revision: number;
}

/** Pointer/keyboard interaction only. The panel owns tree and source semantics. */
export class TimelineBreakpointBar {
  readonly element = document.createElement('div');
  private readonly handle = document.createElement('div');
  private readonly label = document.createElement('span');
  private readonly resume = document.createElement('button');
  private readonly status = document.createElement('span');
  private state: BarState = { stops: [], current: 0, paused: false, disabled: false, revision: 0 };
  private candidate = 0;
  private drag: { id: number; y: number; startY: number; moved: boolean; events: AbortController } | null = null;
  private frame = 0;
  private pending = false;
  private applying = false;
  private pendingRevision = -1;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private restoreFocus = false;
  private disposed = false;

  constructor(
    private readonly body: HTMLElement,
    private readonly apply: (stop: BreakpointStop) => Promise<{ success: boolean; reason?: string }>,
  ) {
    this.element.className = 'timeline-breakpoint';
    this.handle.className = 'timeline-breakpoint-handle';
    this.handle.tabIndex = 0;
    this.handle.setAttribute('role', 'slider');
    this.handle.setAttribute('aria-label', 'Timeline breakpoint');
    this.handle.setAttribute('aria-orientation', 'vertical');
    this.handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Home End Escape');
    const grip = document.createElement('span');
    grip.className = 'timeline-breakpoint-grip';
    grip.setAttribute('aria-hidden', 'true');
    this.label.className = 'timeline-breakpoint-label';
    this.handle.append(grip, this.label);
    this.resume.type = 'button';
    this.resume.className = 'timeline-breakpoint-resume';
    this.resume.title = 'Continue to end';
    this.resume.setAttribute('aria-label', 'Continue to end');
    this.resume.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m7 5 5 5 5-5M7 11l5 5 5-5M5 20h14"/></svg>';
    this.status.className = 'timeline-breakpoint-status';
    this.status.setAttribute('role', 'status');
    this.element.append(this.handle, this.resume, this.status);
    this.handle.addEventListener('pointerdown', e => this.startDrag(e));
    this.handle.addEventListener('lostpointercapture', () => this.cancel());
    this.handle.addEventListener('keydown', e => this.keyDown(e));
    this.handle.addEventListener('keyup', e => {
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        void this.commit(e.key === 'End' && this.state.paused);
      }
    });
    this.handle.addEventListener('blur', () => { if (!this.drag) this.cancel(); });
    this.resume.addEventListener('click', () => {
      this.candidate = this.state.stops.length - 1;
      void this.commit(true);
    });
  }

  /** Detach before the panel replaces its rows; never leave global drag listeners behind. */
  prepareRender(): void {
    this.restoreFocus = this.element.contains(document.activeElement);
    this.cancel();
    this.element.remove();
  }

  update(state: BarState): void {
    this.state = state;
    this.candidate = state.current;
    if (!this.applying && state.revision !== this.pendingRevision) this.finishPending();
    if (!state.stops.length) return;
    this.body.insertBefore(this.element, state.stops[state.current].before);
    this.sync();
    if (this.restoreFocus) this.handle.focus({ preventScroll: true });
    this.restoreFocus = false;
  }

  private get disabled(): boolean { return this.state.disabled || this.pending; }

  private sync(): void {
    const last = this.state.stops.length - 1;
    const preview = this.drag !== null || this.candidate !== this.state.current;
    this.element.dataset.paused = String(this.state.paused);
    this.element.dataset.dragging = String(this.drag !== null);
    this.element.dataset.disabled = String(this.disabled);
    this.element.setAttribute('aria-busy', String(this.pending));
    this.handle.setAttribute('aria-disabled', String(this.disabled));
    this.handle.setAttribute('aria-valuemin', '0');
    this.handle.setAttribute('aria-valuemax', String(Math.max(0, last)));
    this.handle.setAttribute('aria-valuenow', String(this.candidate));
    this.handle.setAttribute('aria-valuetext', this.state.stops[this.candidate]?.label ?? 'End of history');
    this.handle.title = this.state.disabled ? 'Finish the sketch to move the breakpoint'
      : 'Drag to move the breakpoint. Use ↑ / ↓ to step, Home / End to jump, Esc to cancel.';
    this.label.textContent = this.pending ? 'Updating…' : preview
      ? this.state.stops[this.candidate]?.label : this.state.paused ? 'Breakpoint' : 'End of history';
    this.resume.hidden = !this.state.paused;
    this.resume.disabled = this.disabled;
  }

  private startDrag(e: PointerEvent): void {
    if (e.button !== 0 || this.disabled || this.drag) return;
    e.preventDefault();
    e.stopPropagation();
    this.status.textContent = '';
    this.handle.focus({ preventScroll: true });
    const events = new AbortController();
    this.drag = { id: e.pointerId, y: e.clientY, startY: e.clientY, moved: false, events };
    this.handle.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', event => {
      if (event.pointerId !== this.drag?.id) return;
      event.preventDefault();
      this.drag.y = event.clientY;
      this.drag.moved ||= Math.abs(event.clientY - this.drag.startY) > 3;
      if (this.drag.moved) this.previewAt(event.clientY);
    }, { signal: events.signal, passive: false });
    window.addEventListener('pointerup', event => {
      if (event.pointerId !== this.drag?.id) return;
      const moved = this.drag.moved;
      this.stopDrag();
      if (moved) void this.commit();
      else this.cancel();
    }, { signal: events.signal });
    window.addEventListener('pointercancel', event => {
      if (event.pointerId === this.drag?.id) this.cancel();
    }, { signal: events.signal });
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancel(); }
    }, { signal: events.signal, capture: true });
    window.addEventListener('blur', () => this.cancel(), { signal: events.signal });
    this.sync();
    this.frame = requestAnimationFrame(() => this.autoScroll());
  }

  private boundaryY(index: number): number {
    const stop = this.state.stops[index];
    // The resting gap occupies its own height. Measure its top, not the row
    // beneath it, so grabbing the handle never jumps to the next feature.
    if (index === this.state.current) return this.element.offsetTop;
    return stop.before?.offsetTop ?? (this.body.lastElementChild as HTMLElement)?.offsetTop
      + (this.body.lastElementChild as HTMLElement)?.offsetHeight;
  }

  private previewAt(clientY: number): void {
    const y = clientY - this.body.getBoundingClientRect().top + this.body.scrollTop;
    let nearest = 0;
    let distance = Infinity;
    for (let i = 0; i < this.state.stops.length; i++) {
      const delta = Math.abs(this.boundaryY(i) - y);
      if (delta < distance) { nearest = i; distance = delta; }
    }
    this.preview(nearest);
  }

  private preview(index: number): void {
    this.candidate = index;
    // Center the preview line ON the gap, rather than on the next row's
    // label. The resting position already has a full-height gap of its own.
    const center = index === this.state.current ? 0 : this.element.offsetHeight / 2;
    const dy = this.boundaryY(index) - this.element.offsetTop - center;
    this.element.style.transform = `translateY(${dy}px)`;
    this.sync();
  }

  private autoScroll(): void {
    if (!this.drag) return;
    if (this.drag.moved) {
      const rect = this.body.getBoundingClientRect();
      const edge = Math.min(36, rect.height / 4);
      const y = this.drag.y;
      const speed = y < rect.top + edge ? -Math.min(12, (rect.top + edge - y) / 3)
        : y > rect.bottom - edge ? Math.min(12, (y - rect.bottom + edge) / 3) : 0;
      if (speed) { this.body.scrollTop += speed; this.previewAt(y); }
    }
    this.frame = requestAnimationFrame(() => this.autoScroll());
  }

  private stopDrag(): void {
    const drag = this.drag;
    this.drag = null;
    drag?.events.abort();
    cancelAnimationFrame(this.frame);
    if (drag && this.handle.hasPointerCapture?.(drag.id)) this.handle.releasePointerCapture(drag.id);
  }

  private cancel(): void {
    this.stopDrag();
    this.candidate = this.state.current;
    this.element.style.transform = '';
    this.sync();
  }

  private keyDown(e: KeyboardEvent): void {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape', 'Enter'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { this.cancel(); return; }
    if (this.disabled) return;
    const last = this.state.stops.length - 1;
    if (e.key === 'Enter') { void this.commit(); return; }
    this.preview(e.key === 'Home' ? 0 : e.key === 'End' ? last
      : Math.max(0, Math.min(last, this.candidate + (e.key === 'ArrowUp' ? -1 : 1))));
  }

  private async commit(force = false): Promise<void> {
    if (this.disabled || (!force && this.candidate === this.state.current)) { this.cancel(); return; }
    const stop = this.state.stops[this.candidate];
    if (!stop) return;
    this.pending = this.applying = true;
    this.pendingRevision = this.state.revision;
    this.status.textContent = '';
    this.sync();
    let result: { success: boolean; reason?: string };
    try { result = await this.apply(stop); }
    catch { result = { success: false, reason: 'Could not move the breakpoint. Try again.' }; }
    if (this.disposed) return;
    this.applying = false;
    if (!result.success || this.state.revision !== this.pendingRevision) {
      this.finishPending();
      this.cancel();
      if (!result.success) this.status.textContent = result.reason ?? 'Could not move the breakpoint. Try again.';
    } else {
      // The ack and the new scene can arrive in either order. Keep the old
      // source coordinates locked until the scene catches up.
      this.timeout = setTimeout(() => {
        this.cancel();
        this.status.textContent = 'Still waiting for the model. Rebuild it before moving the breakpoint again.';
      }, 15000);
    }
  }

  private finishPending(): void {
    this.pending = false;
    clearTimeout(this.timeout);
    this.status.textContent = '';
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.finishPending();
    this.element.remove();
  }
}
