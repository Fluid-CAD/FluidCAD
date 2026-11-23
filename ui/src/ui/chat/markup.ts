// Marks drawn on a picture before it goes with a chat message
// (docs/agent-chat-plan.md §28): what a mark is, the drawing with its undo
// history, and how marks are painted. The dialog that draws them is
// `markup-annotator.ts`; nothing here touches the DOM.

/** A point of a mark, in the picture's own pixels. */
export type MarkPoint = { x: number; y: number };

type MarkBase = {
  /** A CSS hex colour, one of {@link MARKUP_COLORS}. */
  color: string;
  /** The stroke's width, in the picture's pixels. */
  width: number;
};

export type PenMark = MarkBase & { kind: 'pen'; points: MarkPoint[] };
/** An arrow from `from` to its head at `to`; an ellipse or a rectangle inside the box the two points span. */
export type ShapeMark = MarkBase & { kind: 'arrow' | 'ellipse' | 'rect'; from: MarkPoint; to: MarkPoint };
/** One line of text, its left edge at `at` and its middle on it; `size` is the font's, in the picture's pixels. */
export type TextMark = MarkBase & { kind: 'text'; at: MarkPoint; text: string; size: number };

export type Mark = PenMark | ShapeMark | TextMark;
export type MarkupTool = Mark['kind'];

/** The tools in toolbar order, each with the key that picks it. */
export const MARKUP_TOOLS: readonly { tool: MarkupTool; label: string; key: string }[] = Object.freeze([
  { tool: 'pen', label: 'Pen', key: 'p' },
  { tool: 'arrow', label: 'Arrow', key: 'a' },
  { tool: 'ellipse', label: 'Ellipse', key: 'e' },
  { tool: 'rect', label: 'Rectangle', key: 'r' },
  { tool: 'text', label: 'Text', key: 't' },
]);

export type MarkupColor = {
  name: string;
  hex: string;
  /** A light colour: its text is edged dark instead of light. */
  light?: boolean;
};

/**
 * The colours a mark can have; the first is the default. The red, yellow,
 * green and blue are the scene references' (`reference-colors.ts`), checked
 * on captures of both scene themes; white and black are for pictures of
 * the user's own that are mostly one of those.
 */
export const MARKUP_COLORS: readonly MarkupColor[] = Object.freeze([
  { name: 'Red', hex: '#e5484d' },
  { name: 'Yellow', hex: '#f2cf14', light: true },
  { name: 'Green', hex: '#2fa84f' },
  { name: 'Blue', hex: '#2f6ff0' },
  { name: 'White', hex: '#ffffff', light: true },
  { name: 'Black', hex: '#16181d' },
]);

/** The longest a text mark is. */
export const MAX_LABEL_CHARS = 60;

/** The font a text mark is drawn in (and typed in), at `size` pixels. */
export function markFont(size: number): string {
  return `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
}

/**
 * The stroke width and the text size for a picture of `width` × `height`
 * pixels: in proportion to its longest edge, so marks look the same on a
 * small crop and on a full capture, and stay readable when a model scales
 * the picture down.
 */
export function markSizes(width: number, height: number): { stroke: number; font: number } {
  const edge = Math.max(width, height, 1);
  return {
    stroke: Math.min(8, Math.max(2, Math.round(edge / 320))),
    font: Math.min(48, Math.max(13, Math.round(edge / 42))),
  };
}

/** The name a viewport capture is attached under when nothing was drawn on it. */
export const VIEWPORT_CAPTURE_NAME = 'viewport-capture.png';
/** The name a viewport capture is attached under with marks on it. */
export const VIEWPORT_MARKUP_NAME = 'viewport-markup.png';

/**
 * The name of an attached image once marks were drawn on it: its own, ending
 * in `-markup.png` (`front view.jpg` → `front view-markup.png`). The agent
 * reads the name (`<attached_images>`), so it says what the picture is now.
 */
export function markupName(name: string): string {
  const stem = name.replace(/\.[A-Za-z][A-Za-z0-9]{1,4}$/, '').replace(/-(?:markup|capture)$/, '').trim();
  return `${stem || 'image'}-markup.png`;
}

/**
 * The pixel size of a capture of a viewport that is `cssWidth` × `cssHeight`
 * on screen: the viewport's proportions (kept between 2:5 and 5:2), its
 * longest edge `maxEdge`. `pixelRatio` is what sizes the scene's screen-space
 * overlays (dimension labels) as they are on screen.
 */
export function viewportCaptureSize(cssWidth: number, cssHeight: number, maxEdge = 1600): { width: number; height: number; pixelRatio: number } {
  const known = cssWidth > 0 && cssHeight > 0;
  const aspect = Math.min(2.5, Math.max(0.4, known ? cssWidth / cssHeight : 1.6));
  const width = Math.round(aspect >= 1 ? maxEdge : maxEdge * aspect);
  const height = Math.round(aspect >= 1 ? maxEdge / aspect : maxEdge);
  return { width, height, pixelRatio: known ? Math.max(1, width / cssWidth) : 1 };
}

/**
 * The marks on one picture, with their history: every change (a mark added,
 * all of them cleared) can be undone and done again; a change after an undo
 * drops what was undone.
 */
export class MarkupDrawing {
  private past: (readonly Mark[])[] = [];
  private present: readonly Mark[] = [];
  private future: (readonly Mark[])[] = [];

  get marks(): readonly Mark[] {
    return this.present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  add(mark: Mark): void {
    this.commit([...this.present, mark]);
  }

  /** Take every mark away (undoable). */
  clear(): void {
    if (this.present.length > 0) {
      this.commit([]);
    }
  }

  undo(): boolean {
    const previous = this.past.pop();
    if (!previous) {
      return false;
    }
    this.future.push(this.present);
    this.present = previous;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) {
      return false;
    }
    this.past.push(this.present);
    this.present = next;
    return true;
  }

  private commit(marks: readonly Mark[]): void {
    this.past.push(this.present);
    this.present = marks;
    this.future = [];
  }
}

/** Whether a drag from `from` to `to` is long enough to be a shape of stroke `width` (a click is not). */
export function isShapeDrag(kind: ShapeMark['kind'], from: MarkPoint, to: MarkPoint, width: number): boolean {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return kind === 'arrow' ? Math.hypot(dx, dy) >= width * 3 : Math.max(dx, dy) >= width * 3;
}

/** Paint `marks` on `ctx`, oldest first, in the picture's pixels. */
export function paintMarks(ctx: CanvasRenderingContext2D, marks: readonly Mark[]): void {
  for (const mark of marks) {
    paintMark(ctx, mark);
  }
}

export function paintMark(ctx: CanvasRenderingContext2D, mark: Mark): void {
  ctx.save();
  ctx.strokeStyle = mark.color;
  ctx.fillStyle = mark.color;
  ctx.lineWidth = mark.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (mark.kind) {
    case 'pen':
      paintPen(ctx, mark);
      break;
    case 'arrow':
      paintArrow(ctx, mark);
      break;
    case 'ellipse': {
      const { from, to } = mark;
      ctx.beginPath();
      ctx.ellipse((from.x + to.x) / 2, (from.y + to.y) / 2, Math.abs(to.x - from.x) / 2, Math.abs(to.y - from.y) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'rect': {
      const { from, to } = mark;
      ctx.strokeRect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.abs(to.x - from.x), Math.abs(to.y - from.y));
      break;
    }
    case 'text':
      paintText(ctx, mark);
      break;
  }
  ctx.restore();
}

/** A freehand stroke, smoothed through the midpoints of its points; one point is a dot. */
function paintPen(ctx: CanvasRenderingContext2D, mark: PenMark): void {
  const points = mark.points;
  if (points.length === 0) {
    return;
  }
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, mark.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const next = points[i + 1];
    ctx.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + next.x) / 2, (points[i].y + next.y) / 2);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

/** A shaft and a filled head at `to`, the head sized by the stroke and never longer than half the arrow. */
function paintArrow(ctx: CanvasRenderingContext2D, mark: ShapeMark): void {
  const { from, to } = mark;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0) {
    return;
  }
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  const head = Math.min(length / 2, mark.width * 4.5);
  const half = head * 0.5;
  const base = { x: to.x - ux * head, y: to.y - uy * head };
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(base.x, base.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(base.x - uy * half, base.y + ux * half);
  ctx.lineTo(base.x + uy * half, base.y - ux * half);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/** Text with an edge of the opposite lightness under it, so it reads over the model and over either background. */
function paintText(ctx: CanvasRenderingContext2D, mark: TextMark): void {
  const light = MARKUP_COLORS.find((c) => c.hex === mark.color)?.light === true;
  ctx.font = markFont(mark.size);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineWidth = Math.max(2, mark.size / 9);
  ctx.strokeStyle = light ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.9)';
  ctx.strokeText(mark.text, mark.at.x, mark.at.y);
  ctx.fillText(mark.text, mark.at.x, mark.at.y);
}
