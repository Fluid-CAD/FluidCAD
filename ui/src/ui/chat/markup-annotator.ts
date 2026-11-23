// The markup dialog (docs/agent-chat-plan.md §28): a picture (a capture of
// the viewport, or an image already attached) with a pen, an arrow, an
// ellipse, a rectangle and a text label to draw on it, before it goes with a
// chat message. The canvas the user draws on is the picture at its own pixel
// size with the marks painted on it, so what is attached is what was seen.

import './markup-annotator.css';
import { ChatIcons } from './chat-icons';
import {
  isShapeDrag,
  markFont,
  MARKUP_COLORS,
  MARKUP_TOOLS,
  MarkupDrawing,
  markSizes,
  MAX_LABEL_CHARS,
  paintMark,
  paintMarks,
  type Mark,
  type MarkPoint,
  type MarkupTool,
} from './markup';

/** A picture decoded for the canvas. */
export type MarkupPicture = {
  width: number;
  height: number;
  /** What the canvas draws under the marks; null draws nothing (tests). */
  source: CanvasImageSource | null;
  /** Lets go of what decoding held (an object URL). */
  release?(): void;
};

/** What the dialog needs of the browser: tests hand it their own (jsdom has neither a decoder nor a canvas). */
export type MarkupImaging = {
  /** Decode `image`; rejects when it is not a picture the browser reads. */
  load(image: Blob): Promise<MarkupPicture>;
  /** The canvas's drawing context; null: nothing is painted. */
  context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null;
  /** What is on the canvas, as a PNG. */
  encode(canvas: HTMLCanvasElement): Promise<Blob>;
};

/** The browser's {@link MarkupImaging}: its image decoder and a 2D canvas. */
export const browserMarkupImaging: MarkupImaging = {
  async load(image) {
    const url = URL.createObjectURL(image);
    try {
      const element = new Image();
      element.src = url;
      await element.decode();
      if (element.naturalWidth === 0 || element.naturalHeight === 0) {
        throw new Error('The image has no size.');
      }
      return { width: element.naturalWidth, height: element.naturalHeight, source: element, release: () => URL.revokeObjectURL(url) };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  },
  context: (canvas) => canvas.getContext('2d'),
  encode: (canvas) => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The picture could not be encoded.'))), 'image/png');
  }),
};

export type MarkupAnnotatorOptions = {
  /** The picture to draw on. */
  image: Blob;
  /** The dialog's heading ("Mark up the viewport"). */
  title: string;
  /** The button that takes the result; "Attach" by default. */
  confirmLabel?: string;
  /**
   * The picture is already attached: the confirm button waits for a mark
   * (without one there is nothing to replace it with).
   */
  requireMarks?: boolean;
  /** Where the dialog mounts; the page's body by default. */
  host?: HTMLElement;
  /** Defaults to {@link browserMarkupImaging}. */
  imaging?: MarkupImaging;
};

/** What the dialog hands back: the picture to attach, and whether marks were drawn on it. */
export type MarkupResult = { blob: Blob; marked: boolean };

const TOOL_ICONS: Record<MarkupTool, string> = {
  pen: ChatIcons.MARK_PEN,
  arrow: ChatIcons.MARK_ARROW,
  ellipse: ChatIcons.MARK_ELLIPSE,
  rect: ChatIcons.MARK_RECT,
  text: ChatIcons.MARK_TEXT,
};

/** The stroke being drawn: a mark not yet in the drawing. */
type Stroke = { pointerId: number; mark: Exclude<Mark, { kind: 'text' }> };

let titleIds = 0;

/**
 * The dialog. It mounts when made and settles {@link result} once: with the
 * picture when the user confirms (the marks painted on it, or the image as
 * it was given when nothing was drawn), with null when they cancel (the
 * Cancel button, Escape, {@link close}). {@link result} rejects when the
 * image cannot be read; the dialog is gone by then.
 *
 * Keys, while it is open (taken before the page's own shortcuts): Escape
 * cancels, or drops the text label being typed; Ctrl/Cmd+Z undoes,
 * Ctrl/Cmd+Shift+Z and Ctrl+Y redo; P, A, E, R and T pick a tool; Tab stays
 * inside the dialog. Drawing is by pointer (mouse, pen, touch): one pointer
 * at a time, the primary button only.
 */
export class MarkupAnnotator {
  /** The backdrop (`data-role="chat-markup"`); the dialog is its child. */
  readonly el: HTMLDivElement;
  readonly result: Promise<MarkupResult | null>;
  private readonly dialog: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly frame: HTMLDivElement;
  private readonly status: HTMLSpanElement;
  private readonly toolButtons = new Map<MarkupTool, HTMLButtonElement>();
  private readonly colorButtons = new Map<string, HTMLButtonElement>();
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly imaging: MarkupImaging;
  private readonly drawing = new MarkupDrawing();
  private readonly returnFocus: Element | null;
  private settle!: (result: MarkupResult | null) => void;
  private fail!: (reason: unknown) => void;
  private picture: MarkupPicture | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private sizes = markSizes(1, 1);
  private tool: MarkupTool = 'pen';
  private color = MARKUP_COLORS[0].hex;
  private stroke: Stroke | null = null;
  /** The text label being typed, and where it goes. */
  private label: { input: HTMLInputElement; at: MarkPoint } | null = null;
  private paintFrame = 0;
  private saving = false;
  private closed = false;

  constructor(private readonly options: MarkupAnnotatorOptions) {
    this.imaging = options.imaging ?? browserMarkupImaging;
    this.returnFocus = document.activeElement;
    this.result = new Promise((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });

    this.el = document.createElement('div');
    this.el.className = 'chat-markup';
    this.el.dataset.role = 'chat-markup';
    this.dialog = document.createElement('div');
    this.dialog.className = 'chat-markup-dialog';
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.tabIndex = -1;
    this.dialog.dataset.state = 'loading';

    const title = document.createElement('h2');
    title.className = 'chat-markup-title';
    title.id = `chat-markup-title-${++titleIds}`;
    title.textContent = options.title;
    this.dialog.setAttribute('aria-labelledby', title.id);

    const toolbar = document.createElement('div');
    toolbar.className = 'chat-markup-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Markup tools');
    const tools = this.group('Tool');
    for (const { tool, label, key } of MARKUP_TOOLS) {
      const button = this.iconButton('tool', TOOL_ICONS[tool], `${label} (${key.toUpperCase()})`, label, () => this.setTool(tool));
      button.dataset.tool = tool;
      this.toolButtons.set(tool, button);
      tools.append(button);
    }
    const colors = this.group('Colour');
    for (const color of MARKUP_COLORS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-markup-color';
      button.dataset.ref = 'color';
      button.dataset.color = color.name.toLowerCase();
      button.title = color.name;
      button.setAttribute('aria-label', color.name);
      button.style.setProperty('--chat-markup-swatch', color.hex);
      button.addEventListener('click', () => this.setColor(color.hex));
      this.colorButtons.set(color.hex, button);
      colors.append(button);
    }
    const history = this.group('History');
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
    this.undoButton = this.iconButton('undo', ChatIcons.REVERT, `Undo (${mod}Z)`, 'Undo', () => this.undo());
    this.redoButton = this.iconButton('redo', ChatIcons.REDO, `Redo (${mod}Shift+Z)`, 'Redo', () => this.redo());
    this.clearButton = this.iconButton('clear', ChatIcons.DELETE, 'Clear all marks', 'Clear all marks', () => this.clear());
    history.append(this.undoButton, this.redoButton, this.clearButton);
    toolbar.append(tools, colors, history);

    const stage = document.createElement('div');
    stage.className = 'chat-markup-stage';
    this.frame = document.createElement('div');
    this.frame.className = 'chat-markup-frame';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chat-markup-canvas';
    this.canvas.dataset.ref = 'canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'The picture. Draw on it with a mouse, a pen or a finger.');
    // The press draws: it selects nothing and takes the focus from nothing (the label field keeps it).
    this.canvas.addEventListener('mousedown', (event) => event.preventDefault());
    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('pointercancel', (event) => this.onPointerCancel(event));
    this.frame.append(this.canvas);
    stage.append(this.frame);

    const footer = document.createElement('div');
    footer.className = 'chat-markup-footer';
    this.status = document.createElement('span');
    this.status.className = 'chat-markup-status';
    this.status.dataset.ref = 'status';
    this.status.setAttribute('role', 'status');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost btn-sm';
    cancel.dataset.ref = 'cancel';
    cancel.textContent = 'Cancel';
    cancel.title = 'Cancel (Esc)';
    cancel.addEventListener('click', () => this.close());
    this.confirmButton = document.createElement('button');
    this.confirmButton.type = 'button';
    this.confirmButton.className = 'btn btn-primary btn-sm min-w-20';
    this.confirmButton.dataset.ref = 'confirm';
    this.confirmButton.textContent = options.confirmLabel ?? 'Attach';
    this.confirmButton.addEventListener('click', () => void this.confirm());
    footer.append(this.status, cancel, this.confirmButton);

    this.dialog.append(title, toolbar, stage, footer);
    this.el.append(this.dialog);
    (options.host ?? document.body).append(this.el);
    document.addEventListener('keydown', this.onKeyDown, true);
    this.say('Opening the picture…');
    this.sync();
    this.dialog.focus();

    void this.imaging.load(options.image).then(
      (picture) => this.opened(picture),
      (err) => {
        if (!this.closed) {
          this.unmount();
          this.fail(err);
        }
      },
    );
  }

  /** The marks drawn so far, oldest first. */
  get marks(): readonly Mark[] {
    return this.drawing.marks;
  }

  /** Cancel: the dialog goes and {@link result} is null. */
  close(): void {
    if (!this.closed) {
      this.unmount();
      this.settle(null);
    }
  }

  /** The picture is decoded: the canvas takes its size and drawing starts. */
  private opened(picture: MarkupPicture): void {
    if (this.closed) {
      picture.release?.();
      return;
    }
    this.picture = picture;
    this.canvas.width = picture.width;
    this.canvas.height = picture.height;
    this.sizes = markSizes(picture.width, picture.height);
    this.context = this.imaging.context(this.canvas);
    this.dialog.dataset.state = 'ready';
    this.say('Drag on the picture to draw. Esc cancels.');
    this.sync();
    this.paint();
  }

  private unmount(): void {
    this.closed = true;
    document.removeEventListener('keydown', this.onKeyDown, true);
    if (this.paintFrame) {
      cancelAnimationFrame(this.paintFrame);
      this.paintFrame = 0;
    }
    this.picture?.release?.();
    this.el.remove();
    if (this.returnFocus instanceof HTMLElement && this.returnFocus.isConnected) {
      this.returnFocus.focus();
    }
  }

  /** Hand the picture back: with the marks painted on it, or as it was given when there are none. */
  private async confirm(): Promise<void> {
    if (this.closed || this.saving || !this.picture) {
      return;
    }
    this.commitLabel();
    if (this.drawing.marks.length === 0) {
      if (!this.options.requireMarks) {
        this.unmount();
        this.settle({ blob: this.options.image, marked: false });
      }
      return;
    }
    this.saving = true;
    this.sync();
    try {
      this.stroke = null;
      this.paint();
      const blob = await this.imaging.encode(this.canvas);
      if (!this.closed) {
        this.unmount();
        this.settle({ blob, marked: true });
      }
    } catch {
      this.saving = false;
      this.say('The picture could not be saved. Try again.');
      this.sync();
    }
  }

  // --- Tools ---------------------------------------------------------------

  private setTool(tool: MarkupTool): void {
    this.commitLabel();
    this.tool = tool;
    this.sync();
  }

  private setColor(hex: string): void {
    this.color = hex;
    if (this.label) {
      this.label.input.style.color = hex;
      this.label.input.focus();
    }
    this.sync();
  }

  private undo(): void {
    this.dropLabel();
    if (this.drawing.undo()) {
      this.changed();
    }
  }

  private redo(): void {
    this.dropLabel();
    if (this.drawing.redo()) {
      this.changed();
    }
  }

  private clear(): void {
    this.dropLabel();
    this.drawing.clear();
    this.changed();
  }

  private changed(): void {
    this.sync();
    this.paint();
  }

  // --- Drawing -------------------------------------------------------------

  /** Where a pointer is, in the picture's pixels (inside the picture). */
  private pointOf(event: { clientX: number; clientY: number }): MarkPoint {
    const rect = this.canvas.getBoundingClientRect();
    const sx = rect.width > 0 ? this.canvas.width / rect.width : 1;
    const sy = rect.height > 0 ? this.canvas.height / rect.height : 1;
    const round = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(value * 10) / 10));
    return {
      x: round((event.clientX - rect.left) * sx, this.canvas.width),
      y: round((event.clientY - rect.top) * sy, this.canvas.height),
    };
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.picture || this.saving || this.stroke || !event.isPrimary || event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.commitLabel();
    const at = this.pointOf(event);
    if (this.tool === 'text') {
      this.placeLabel(at);
      return;
    }
    const base = { color: this.color, width: this.sizes.stroke };
    this.stroke = {
      pointerId: event.pointerId,
      mark: this.tool === 'pen' ? { ...base, kind: 'pen', points: [at] } : { ...base, kind: this.tool, from: at, to: at },
    };
    try {
      this.canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer that is already gone: the stroke ends with its pointerup or pointercancel.
    }
    this.paint();
  }

  private onPointerMove(event: PointerEvent): void {
    const stroke = this.stroke;
    if (!stroke || event.pointerId !== stroke.pointerId) {
      return;
    }
    event.preventDefault();
    if (stroke.mark.kind === 'pen') {
      // A pen reports more often than events are dispatched: every sample is part of the line.
      const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      for (const sample of samples.length > 0 ? samples : [event]) {
        const point = this.pointOf(sample);
        const last = stroke.mark.points[stroke.mark.points.length - 1];
        if (Math.hypot(point.x - last.x, point.y - last.y) >= 1) {
          stroke.mark.points.push(point);
        }
      }
    } else {
      stroke.mark.to = this.pointOf(event);
    }
    this.schedulePaint();
  }

  private onPointerUp(event: PointerEvent): void {
    const stroke = this.stroke;
    if (!stroke || event.pointerId !== stroke.pointerId) {
      return;
    }
    event.preventDefault();
    this.stroke = null;
    const mark = stroke.mark;
    // A click with a shape tool draws nothing; with the pen, a dot.
    if (mark.kind === 'pen' || isShapeDrag(mark.kind, mark.from, mark.to, mark.width)) {
      this.drawing.add(mark);
    }
    this.changed();
  }

  private onPointerCancel(event: PointerEvent): void {
    if (this.stroke && event.pointerId === this.stroke.pointerId) {
      this.stroke = null;
      this.paint();
    }
  }

  /** Paint on the next frame (a stroke in progress moves faster than the screen draws). */
  private schedulePaint(): void {
    if (!this.paintFrame) {
      this.paintFrame = requestAnimationFrame(() => {
        this.paintFrame = 0;
        this.paint();
      });
    }
  }

  /** The picture, the marks, and the stroke being drawn. */
  private paint(): void {
    if (this.paintFrame) {
      cancelAnimationFrame(this.paintFrame);
      this.paintFrame = 0;
    }
    const ctx = this.context;
    if (!ctx || !this.picture || this.closed) {
      return;
    }
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.picture.source) {
      ctx.drawImage(this.picture.source, 0, 0, this.canvas.width, this.canvas.height);
    }
    paintMarks(ctx, this.drawing.marks);
    if (this.stroke) {
      paintMark(ctx, this.stroke.mark);
    }
  }

  // --- The text label ------------------------------------------------------

  /** Open a field at `at` to type a label into; Enter (or drawing on) keeps it, Escape drops it. */
  private placeLabel(at: MarkPoint): void {
    const rect = this.canvas.getBoundingClientRect();
    const scale = rect.width > 0 && this.canvas.width > 0 ? rect.width / this.canvas.width : 1;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-markup-label';
    input.dataset.ref = 'label';
    input.maxLength = MAX_LABEL_CHARS;
    input.placeholder = 'Label';
    input.setAttribute('aria-label', 'Label text');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.style.left = `${(at.x / Math.max(1, this.canvas.width)) * 100}%`;
    input.style.top = `${(at.y / Math.max(1, this.canvas.height)) * 100}%`;
    input.style.font = markFont(Math.max(11, Math.round(this.sizes.font * scale)));
    input.style.color = this.color;
    // Leaving the field keeps what was typed (a click on Attach, on a tool, on the picture).
    input.addEventListener('blur', () => {
      if (this.label?.input === input) {
        this.commitLabel();
      }
    });
    this.label = { input, at };
    this.frame.append(input);
    input.focus();
  }

  /** The label being typed becomes a mark (nothing when it is empty). */
  private commitLabel(): void {
    const label = this.label;
    if (!label) {
      return;
    }
    this.label = null;
    label.input.remove();
    const text = label.input.value.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS);
    if (text !== '') {
      this.drawing.add({ kind: 'text', color: this.color, width: this.sizes.stroke, at: label.at, text, size: this.sizes.font });
      this.changed();
    }
  }

  private dropLabel(): void {
    const label = this.label;
    if (label) {
      this.label = null;
      label.input.remove();
    }
  }

  // --- Keys ----------------------------------------------------------------

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // The page's shortcuts (tools, panels, undo in the editor) are not for now.
    event.stopPropagation();
    const typing = this.label !== null && event.target === this.label.input;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.label) {
        this.dropLabel();
        this.dialog.focus();
      } else {
        this.close();
      }
      return;
    }
    if (event.key === 'Tab') {
      this.keepFocusInside(event);
      return;
    }
    if (typing) {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        this.commitLabel();
        this.dialog.focus();
      }
      // Everything else is the field's own: typing, its caret, its undo.
      return;
    }
    const key = event.key.toLowerCase();
    if (event.ctrlKey || event.metaKey) {
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
      } else if (key === 'y') {
        event.preventDefault();
        this.redo();
      }
      return;
    }
    if (event.altKey) {
      return;
    }
    const picked = MARKUP_TOOLS.find((t) => t.key === key);
    if (picked) {
      event.preventDefault();
      this.setTool(picked.tool);
    }
  };

  /** Tab goes round the dialog's controls and never out to the page under it. */
  private keepFocusInside(event: KeyboardEvent): void {
    const stops = [...this.dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input')];
    if (stops.length === 0) {
      event.preventDefault();
      return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && this.dialog.contains(active) && active !== this.dialog;
    if (event.shiftKey ? !inside || active === first : !inside || active === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  // --- Chrome --------------------------------------------------------------

  private group(label: string): HTMLDivElement {
    const group = document.createElement('div');
    group.className = 'chat-markup-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    return group;
  }

  private iconButton(ref: string, icon: string, title: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-markup-button';
    button.dataset.ref = ref;
    button.title = title;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    button.addEventListener('click', onClick);
    return button;
  }

  private say(message: string): void {
    this.status.textContent = message;
  }

  /** The buttons follow the state: the tool and colour in use, what can be undone, whether there is anything to attach. */
  private sync(): void {
    const ready = this.picture !== null && !this.saving;
    for (const [tool, button] of this.toolButtons) {
      button.setAttribute('aria-pressed', String(tool === this.tool));
      button.disabled = !ready;
    }
    for (const [hex, button] of this.colorButtons) {
      button.setAttribute('aria-pressed', String(hex === this.color));
      button.disabled = !ready;
    }
    this.undoButton.disabled = !ready || !this.drawing.canUndo;
    this.redoButton.disabled = !ready || !this.drawing.canRedo;
    this.clearButton.disabled = !ready || this.drawing.marks.length === 0;
    this.confirmButton.disabled = !ready || (this.options.requireMarks === true && this.drawing.marks.length === 0);
    this.canvas.dataset.tool = this.tool;
  }
}
