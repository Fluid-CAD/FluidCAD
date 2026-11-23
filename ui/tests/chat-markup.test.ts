// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/ui/chat/chat-panel';
import { ImageAttachments, MAX_ATTACHMENTS, type ImagePreparer } from '../src/ui/chat/image-attachments';
import {
  isShapeDrag,
  markSizes,
  MARKUP_COLORS,
  MarkupDrawing,
  markupName,
  paintMarks,
  viewportCaptureSize,
  VIEWPORT_CAPTURE_NAME,
  VIEWPORT_MARKUP_NAME,
  type Mark,
} from '../src/ui/chat/markup';
import { MarkupAnnotator, type MarkupImaging, type MarkupResult } from '../src/ui/chat/markup-annotator';
import { LeftSlot } from '../src/ui/left-slot';
import { FakeChatClient } from './fixtures/fake-chat-client';
import { FakeScene } from './fixtures/fake-chat-scene';
import { settle } from './fixtures/fake-packages-client';

// Marking up a picture before it goes with a chat message: a capture of the
// viewport from the composer's Capture button, or an image already attached
// from the pen on its thumbnail. Decoding a picture and drawing on a canvas
// need the browser, which jsdom is not: the tests hand the dialog an imaging
// of their own, whose drawing context records what is painted.

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
let urls = 0;

beforeAll(() => {
  // jsdom has no object URLs.
  URL.createObjectURL = () => `blob:markup/${++urls}`;
  URL.revokeObjectURL = () => {};
});

afterAll(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

const panels: ChatPanel[] = [];
const dialogs: MarkupAnnotator[] = [];

afterEach(() => {
  for (const dialog of dialogs.splice(0)) {
    dialog.close();
  }
  for (const panel of panels.splice(0)) {
    panel.destroy();
  }
  document.body.innerHTML = '';
});

const RED = MARKUP_COLORS[0].hex;
const file = (name: string, type = 'image/png', body = name) => new File([body], name, { type });
const base64 = (text: string) => btoa(text);

/** A drawing context that writes down what is called on it and what is set. */
function recordingContext() {
  const calls: unknown[][] = [];
  const context = new Proxy({} as Record<string, unknown>, {
    get: (target, name: string) => (name in target ? target[name] : (...args: unknown[]) => void calls.push([name, ...args])),
    set: (target, name: string, value) => {
      target[name] = value;
      calls.push([`${name}=`, value]);
      return true;
    },
  });
  return { calls, context: context as unknown as CanvasRenderingContext2D, names: () => calls.map((c) => c[0]) };
}

/**
 * An imaging for the dialog: every picture is 800 × 400 (a picture called
 * `broken…` cannot be read), painting is recorded, and the PNG it encodes is
 * the text `marked:` and the name of what was opened.
 */
function fakeImaging() {
  const recorded = recordingContext();
  const encoded: string[] = [];
  const imaging: MarkupImaging = {
    load: async (image) => {
      if ((image as File).name?.startsWith('broken')) {
        throw new Error('not a picture');
      }
      return { width: 800, height: 400, source: null };
    },
    context: () => recorded.context,
    encode: async () => {
      encoded.push('png');
      return new Blob(['marked'], { type: 'image/png' });
    },
  };
  return { imaging, recorded, encoded };
}

/** A pointer event on `target` at a point of the picture (jsdom lays nothing out: client pixels are the picture's). */
function pointer(target: Element, type: string, x: number, y: number, extra: { button?: number; isPrimary?: boolean; pointerId?: number } = {}): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: extra.button ?? 0 });
  Object.defineProperties(event, { pointerId: { value: extra.pointerId ?? 1 }, isPrimary: { value: extra.isPrimary ?? true } });
  target.dispatchEvent(event);
  return event;
}

const key = (name: string, extra: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(event);
  return event;
};

/** The dialog on a picture, with what a test needs to drive it. */
async function openDialog(options: { requireMarks?: boolean; confirmLabel?: string; name?: string } = {}) {
  const fake = fakeImaging();
  const image = file(options.name ?? 'capture.png');
  const dialog = new MarkupAnnotator({ image, title: 'Mark up the viewport', imaging: fake.imaging, ...options });
  dialogs.push(dialog);
  let result: MarkupResult | null | undefined;
  let failed: unknown;
  dialog.result.then((r) => (result = r), (err) => (failed = err));
  await settle();
  const $ = <T extends Element = HTMLElement>(selector: string) => dialog.el.querySelector<T>(selector);
  const canvas = () => $<HTMLCanvasElement>('[data-ref="canvas"]')!;
  const drag = (from: [number, number], to: [number, number], via: [number, number][] = []) => {
    pointer(canvas(), 'pointerdown', ...from);
    for (const point of [...via, to]) {
      pointer(canvas(), 'pointermove', ...point);
    }
    pointer(canvas(), 'pointerup', ...to);
  };
  const tool = (name: string) => $<HTMLButtonElement>(`[data-ref="tool"][data-tool="${name}"]`)!;
  const color = (name: string) => $<HTMLButtonElement>(`[data-ref="color"][data-color="${name}"]`)!;
  const button = (ref: string) => $<HTMLButtonElement>(`[data-ref="${ref}"]`)!;
  const kinds = () => dialog.marks.map((m) => m.kind);
  return { dialog, image, ...fake, $, canvas, drag, tool, color, button, kinds, result: () => result, failed: () => failed };
}

describe('the marks on a picture', () => {
  it('are undone and done again one change at a time; clearing is a change too, and a new mark drops what was undone', () => {
    const drawing = new MarkupDrawing();
    const arrow: Mark = { kind: 'arrow', color: RED, width: 4, from: { x: 0, y: 0 }, to: { x: 50, y: 50 } };
    const box: Mark = { kind: 'rect', color: RED, width: 4, from: { x: 10, y: 10 }, to: { x: 90, y: 40 } };
    expect([drawing.canUndo, drawing.canRedo, drawing.undo(), drawing.redo()]).toEqual([false, false, false, false]);
    drawing.add(arrow);
    drawing.add(box);
    expect(drawing.marks).toEqual([arrow, box]);
    expect(drawing.undo()).toBe(true);
    expect(drawing.marks).toEqual([arrow]);
    expect(drawing.redo()).toBe(true);
    expect(drawing.marks).toEqual([arrow, box]);

    drawing.clear();
    expect(drawing.marks).toEqual([]);
    // Nothing more to clear: not a change.
    drawing.clear();
    drawing.undo();
    expect(drawing.marks).toEqual([arrow, box]);

    drawing.undo();
    drawing.add(box);
    expect(drawing.marks).toEqual([arrow, box]);
    expect(drawing.canRedo).toBe(false);
  });

  it('are as thick, and their text as tall, as the picture is large', () => {
    expect(markSizes(1600, 1000)).toEqual({ stroke: 5, font: 38 });
    expect(markSizes(1024, 768)).toEqual({ stroke: 3, font: 24 });
    expect(markSizes(2000, 2000)).toEqual({ stroke: 6, font: 48 });
    // A small crop: never thinner than 2 px nor smaller than 13 px.
    expect(markSizes(300, 200)).toEqual({ stroke: 2, font: 13 });
  });

  it('take a drag: a click with a shape tool is no shape', () => {
    expect(isShapeDrag('rect', { x: 10, y: 10 }, { x: 12, y: 11 }, 4)).toBe(false);
    expect(isShapeDrag('rect', { x: 10, y: 10 }, { x: 60, y: 11 }, 4)).toBe(true);
    expect(isShapeDrag('arrow', { x: 10, y: 10 }, { x: 17, y: 17 }, 4)).toBe(false);
    expect(isShapeDrag('arrow', { x: 10, y: 10 }, { x: 20, y: 20 }, 4)).toBe(true);
  });

  it('are painted in their colour and width: a smoothed stroke, a shaft with a filled head, an outline, edged text', () => {
    const { context, calls, names } = recordingContext();
    paintMarks(context, [
      { kind: 'pen', color: RED, width: 5, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }] },
      { kind: 'pen', color: RED, width: 6, points: [{ x: 7, y: 9 }] },
      { kind: 'arrow', color: '#2f6ff0', width: 4, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } },
      { kind: 'ellipse', color: RED, width: 4, from: { x: 10, y: 20 }, to: { x: 50, y: 40 } },
      { kind: 'rect', color: RED, width: 4, from: { x: 50, y: 40 }, to: { x: 10, y: 20 } },
      { kind: 'text', color: '#f2cf14', width: 4, at: { x: 30, y: 30 }, text: 'this hole', size: 24 },
    ]);
    expect(calls).toContainEqual(['strokeStyle=', RED]);
    expect(calls).toContainEqual(['lineWidth=', 5]);
    expect(calls).toContainEqual(['lineCap=', 'round']);
    // The stroke: through the middle of its points, to its end.
    expect(calls).toContainEqual(['quadraticCurveTo', 10, 0, 15, 5]);
    expect(calls).toContainEqual(['lineTo', 20, 10]);
    // One point is a dot of the stroke's width.
    expect(calls).toContainEqual(['arc', 7, 9, 3, 0, Math.PI * 2]);
    // The arrow: its shaft stops where the head starts, the head closes on the tip.
    expect(calls).toContainEqual(['fillStyle=', '#2f6ff0']);
    expect(calls).toContainEqual(['lineTo', 82, 0]);
    expect(calls).toContainEqual(['lineTo', 82, 9]);
    expect(calls).toContainEqual(['lineTo', 82, -9]);
    expect(names()).toContain('closePath');
    // The ellipse inside the dragged box; the rectangle whichever way it was dragged.
    expect(calls).toContainEqual(['ellipse', 30, 30, 20, 10, 0, 0, Math.PI * 2]);
    expect(calls).toContainEqual(['strokeRect', 10, 20, 40, 20]);
    // Text: a light colour is edged dark, and filled over its edge.
    expect(calls).toContainEqual(['font=', '600 24px ui-sans-serif, system-ui, sans-serif']);
    expect(calls).toContainEqual(['strokeStyle=', 'rgba(0, 0, 0, 0.7)']);
    const stroked = calls.findIndex((c) => c[0] === 'strokeText');
    expect(calls[stroked]).toEqual(['strokeText', 'this hole', 30, 30]);
    expect(calls[stroked + 1]).toEqual(['fillText', 'this hole', 30, 30]);
    // Each mark leaves the context as it found it.
    expect(names().filter((n) => n === 'save')).toHaveLength(6);
    expect(names().filter((n) => n === 'restore')).toHaveLength(6);
  });

  it('give the picture a name that says what it is', () => {
    // What the agent's preamble names (agent/src/instructions.ts).
    expect([VIEWPORT_CAPTURE_NAME, VIEWPORT_MARKUP_NAME]).toEqual(['viewport-capture.png', 'viewport-markup.png']);
    expect(markupName('front view.jpg')).toBe('front view-markup.png');
    expect(markupName('image')).toBe('image-markup.png');
    expect(markupName(VIEWPORT_CAPTURE_NAME)).toBe(VIEWPORT_MARKUP_NAME);
    // Marked up twice: still one suffix.
    expect(markupName('front view-markup.png')).toBe('front view-markup.png');
    expect(markupName('plate v1.2')).toBe('plate v1.2-markup.png');
    expect(markupName('.png')).toBe('image-markup.png');
  });
});

describe('a capture of the viewport', () => {
  it('has the viewport\'s proportions, 1600 px on its longest edge, its overlays sized as on screen', () => {
    expect(viewportCaptureSize(1000, 625)).toEqual({ width: 1600, height: 1000, pixelRatio: 1.6 });
    expect(viewportCaptureSize(600, 900)).toEqual({ width: 1067, height: 1600, pixelRatio: 1067 / 600 });
    // A viewport larger than the capture: never under one.
    expect(viewportCaptureSize(3200, 1600)).toEqual({ width: 1600, height: 800, pixelRatio: 1 });
    // A sliver of a window, and a viewport with no size yet.
    expect(viewportCaptureSize(3000, 300)).toMatchObject({ width: 1600, height: 640 });
    expect(viewportCaptureSize(0, 0)).toEqual({ width: 1600, height: 1000, pixelRatio: 1 });
  });
});

describe('the markup dialog', () => {
  it('is a modal dialog named by its heading, with real buttons for the tools, the colours, undo, redo, clear, Cancel and Attach', async () => {
    const h = await openDialog();
    const dialog = h.$('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Mark up the viewport');
    expect(h.dialog.el.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(dialog);
    expect([...h.dialog.el.querySelectorAll('[data-ref="tool"]')].map((b) => [b.tagName, b.getAttribute('aria-label'), (b as HTMLElement).title, b.getAttribute('aria-pressed')])).toEqual([
      ['BUTTON', 'Pen', 'Pen (P)', 'true'],
      ['BUTTON', 'Arrow', 'Arrow (A)', 'false'],
      ['BUTTON', 'Ellipse', 'Ellipse (E)', 'false'],
      ['BUTTON', 'Rectangle', 'Rectangle (R)', 'false'],
      ['BUTTON', 'Text', 'Text (T)', 'false'],
    ]);
    // Red first, and the one in use.
    expect([...h.dialog.el.querySelectorAll('[data-ref="color"]')].map((b) => `${b.getAttribute('aria-label')}:${b.getAttribute('aria-pressed')}`)).toEqual([
      'Red:true', 'Yellow:false', 'Green:false', 'Blue:false', 'White:false', 'Black:false',
    ]);
    expect([h.button('undo'), h.button('redo'), h.button('clear')].map((b) => [b.getAttribute('aria-label'), b.disabled])).toEqual([
      ['Undo', true], ['Redo', true], ['Clear all marks', true],
    ]);
    expect([h.button('cancel').textContent, h.button('confirm').textContent, h.button('confirm').disabled]).toEqual(['Cancel', 'Attach', false]);
    // The canvas is the picture, pixel for pixel, and is painted once it is open.
    expect([h.canvas().width, h.canvas().height]).toEqual([800, 400]);
    expect(h.recorded.names()).toContain('clearRect');
    expect(h.$('[data-ref="status"]')!.textContent).toBe('Drag on the picture to draw. Esc cancels.');
  });

  it('draws with each tool in the colour picked, at the width the picture calls for', async () => {
    const h = await openDialog();
    // The pen: every point of the drag, and a dot for a click.
    h.drag([10, 10], [40, 30], [[20, 12], [30, 20]]);
    pointer(h.canvas(), 'pointerdown', 100, 100);
    pointer(h.canvas(), 'pointerup', 100, 100);
    expect(h.dialog.marks).toEqual([
      { kind: 'pen', color: RED, width: 3, points: [{ x: 10, y: 10 }, { x: 20, y: 12 }, { x: 30, y: 20 }, { x: 40, y: 30 }] },
      { kind: 'pen', color: RED, width: 3, points: [{ x: 100, y: 100 }] },
    ]);

    h.tool('arrow').click();
    expect([h.tool('pen').getAttribute('aria-pressed'), h.tool('arrow').getAttribute('aria-pressed'), h.canvas().dataset.tool]).toEqual(['false', 'true', 'arrow']);
    h.color('blue').click();
    expect([h.color('red').getAttribute('aria-pressed'), h.color('blue').getAttribute('aria-pressed')]).toEqual(['false', 'true']);
    h.drag([200, 50], [300, 150]);
    h.tool('ellipse').click();
    h.drag([400, 100], [500, 160]);
    h.tool('rect').click();
    h.drag([600, 300], [520, 240]);
    expect(h.dialog.marks.slice(2)).toEqual([
      { kind: 'arrow', color: '#2f6ff0', width: 3, from: { x: 200, y: 50 }, to: { x: 300, y: 150 } },
      { kind: 'ellipse', color: '#2f6ff0', width: 3, from: { x: 400, y: 100 }, to: { x: 500, y: 160 } },
      { kind: 'rect', color: '#2f6ff0', width: 3, from: { x: 600, y: 300 }, to: { x: 520, y: 240 } },
    ]);
    // A click with a shape tool draws nothing; nor does a second finger, or another button.
    h.drag([700, 50], [701, 51]);
    pointer(h.canvas(), 'pointerdown', 10, 10, { isPrimary: false, pointerId: 2 });
    pointer(h.canvas(), 'pointerup', 90, 90, { isPrimary: false, pointerId: 2 });
    pointer(h.canvas(), 'pointerdown', 10, 10, { button: 2 });
    pointer(h.canvas(), 'pointerup', 90, 90, { button: 2 });
    expect(h.kinds()).toEqual(['pen', 'pen', 'arrow', 'ellipse', 'rect']);
    // What is drawn stays inside the picture.
    h.drag([790, 390], [900, -40]);
    expect(h.dialog.marks.at(-1)).toMatchObject({ kind: 'rect', to: { x: 800, y: 0 } });
    // The last paint has every mark on the picture.
    const lastPaint = h.recorded.calls.slice(h.recorded.calls.map((c) => c[0]).lastIndexOf('clearRect'));
    expect(lastPaint.filter((c) => c[0] === 'save')).toHaveLength(6);
  });

  it('a stroke the system takes away (a palm, a call) is not kept', async () => {
    const h = await openDialog();
    pointer(h.canvas(), 'pointerdown', 10, 10);
    pointer(h.canvas(), 'pointermove', 60, 60);
    pointer(h.canvas(), 'pointercancel', 60, 60);
    pointer(h.canvas(), 'pointerup', 60, 60);
    expect(h.dialog.marks).toEqual([]);
  });

  it('a text label is typed where the picture was clicked: Enter keeps it, Escape drops it, an empty one is nothing', async () => {
    const h = await openDialog();
    h.tool('text').click();
    pointer(h.canvas(), 'pointerdown', 200, 100);
    const field = () => h.$<HTMLInputElement>('[data-ref="label"]');
    expect(field()).not.toBeNull();
    expect([field()!.style.left, field()!.style.top, field()!.maxLength, field()!.getAttribute('aria-label')]).toEqual(['25%', '25%', 60, 'Label text']);
    expect(document.activeElement).toBe(field());
    // Typing is the field's own: a tool's letter is a letter, and nothing reaches the page.
    const pageKeys = vi.fn();
    window.addEventListener('keydown', pageKeys);
    expect(key('a', {}, field()!).defaultPrevented).toBe(false);
    expect(h.tool('text').getAttribute('aria-pressed')).toBe('true');
    field()!.value = '  this   hole ';
    key('Enter', {}, field()!);
    expect(field()).toBeNull();
    expect(h.dialog.marks).toEqual([{ kind: 'text', color: RED, width: 3, at: { x: 200, y: 100 }, text: 'this hole', size: 19 }]);

    // Escape drops the label being typed, not the dialog.
    pointer(h.canvas(), 'pointerdown', 300, 200);
    field()!.value = 'never mind';
    key('Escape', {}, field()!);
    expect(field()).toBeNull();
    expect(h.dialog.el.isConnected).toBe(true);
    expect(h.kinds()).toEqual(['text']);

    // An empty one is nothing; clicking elsewhere keeps the one typed and opens the next.
    pointer(h.canvas(), 'pointerdown', 300, 200);
    key('Enter', {}, field()!);
    expect(h.kinds()).toEqual(['text']);
    pointer(h.canvas(), 'pointerdown', 300, 200);
    field()!.value = 'wall';
    pointer(h.canvas(), 'pointerdown', 500, 300);
    expect(h.dialog.marks.map((m) => (m.kind === 'text' ? m.text : m.kind))).toEqual(['this hole', 'wall']);
    expect(field()).not.toBeNull();
    // Attach keeps what is being typed.
    field()!.value = 'rib';
    h.button('confirm').click();
    await settle();
    expect(pageKeys).not.toHaveBeenCalled();
    window.removeEventListener('keydown', pageKeys);
    expect(h.result()).toMatchObject({ marked: true });
    expect(h.encoded).toHaveLength(1);
  });

  it('undoes and redoes from the buttons and from the keyboard, and clears; the keys never reach the page', async () => {
    const h = await openDialog();
    const pageKeys = vi.fn();
    window.addEventListener('keydown', pageKeys);
    h.drag([10, 10], [60, 60]);
    h.drag([100, 10], [160, 60]);
    h.drag([200, 10], [260, 60]);
    expect([h.button('undo').disabled, h.button('redo').disabled, h.button('clear').disabled]).toEqual([false, true, false]);

    h.button('undo').click();
    expect(h.dialog.marks).toHaveLength(2);
    expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(h.dialog.marks).toHaveLength(1);
    key('z', { metaKey: true });
    expect(h.dialog.marks).toHaveLength(0);
    expect([h.button('undo').disabled, h.button('redo').disabled, h.button('clear').disabled]).toEqual([true, false, true]);
    key('Z', { ctrlKey: true, shiftKey: true });
    key('y', { ctrlKey: true });
    h.button('redo').click();
    expect(h.dialog.marks).toHaveLength(3);
    expect(h.button('redo').disabled).toBe(true);

    h.button('clear').click();
    expect(h.dialog.marks).toHaveLength(0);
    // Clearing is undone like a mark.
    key('z', { ctrlKey: true });
    expect(h.dialog.marks).toHaveLength(3);

    // The letters pick a tool.
    for (const [letter, name] of [['a', 'arrow'], ['e', 'ellipse'], ['R', 'rect'], ['t', 'text'], ['p', 'pen']]) {
      key(letter);
      expect(h.tool(name).getAttribute('aria-pressed')).toBe('true');
    }
    expect(pageKeys).not.toHaveBeenCalled();
    window.removeEventListener('keydown', pageKeys);
  });

  it('Tab stays among the dialog\'s controls', async () => {
    const h = await openDialog();
    const stops = [...h.dialog.el.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    // From the dialog itself, the first control; from the last, the first again; backwards, the last.
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops[0]);
    stops.at(-1)!.focus();
    expect(key('Tab', {}, stops.at(-1)!).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops[0]);
    expect(key('Tab', { shiftKey: true }, stops[0]).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops.at(-1));
    // In between, the browser moves it.
    stops[1].focus();
    expect(key('Tab', {}, stops[1]).defaultPrevented).toBe(false);
  });

  it('Attach hands back the picture with the marks painted on it, and the picture as it was when nothing was drawn', async () => {
    const marked = await openDialog();
    marked.drag([10, 10], [60, 60]);
    marked.button('confirm').click();
    await settle();
    expect(marked.result()!.marked).toBe(true);
    expect(await marked.result()!.blob.text()).toBe('marked');
    expect(marked.dialog.el.isConnected).toBe(false);

    const plain = await openDialog();
    plain.button('confirm').click();
    await settle();
    expect(plain.result()).toEqual({ blob: plain.image, marked: false });
    expect(plain.encoded).toEqual([]);
  });

  it('Cancel and Escape close it with nothing, and focus goes back to where it was', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const h = await openDialog();
    h.drag([10, 10], [60, 60]);
    expect(key('Escape').defaultPrevented).toBe(true);
    await settle();
    expect(h.result()).toBeNull();
    expect(h.dialog.el.isConnected).toBe(false);
    expect(document.activeElement).toBe(opener);
    // Closed: its keys are the page's again.
    const pageKeys = vi.fn();
    window.addEventListener('keydown', pageKeys);
    key('z', { ctrlKey: true });
    expect(pageKeys).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', pageKeys);

    const again = await openDialog();
    again.button('cancel').click();
    await settle();
    expect(again.result()).toBeNull();
  });

  it('on an image already attached, waits for a mark before it replaces it', async () => {
    const h = await openDialog({ requireMarks: true, confirmLabel: 'Replace' });
    expect([h.button('confirm').textContent, h.button('confirm').disabled]).toEqual(['Replace', true]);
    h.drag([10, 10], [60, 60]);
    expect(h.button('confirm').disabled).toBe(false);
    h.button('undo').click();
    expect(h.button('confirm').disabled).toBe(true);
  });

  it('a picture that cannot be read closes it and says so to whoever opened it', async () => {
    const h = await openDialog({ name: 'broken.png' });
    expect(h.failed()).toBeInstanceOf(Error);
    expect(h.result()).toBeUndefined();
    expect(h.dialog.el.isConnected).toBe(false);
  });

  it('a picture that cannot be saved keeps the dialog and the marks, and says so', async () => {
    const h = await openDialog();
    h.imaging.encode = async () => {
      throw new Error('no memory');
    };
    h.drag([10, 10], [60, 60]);
    h.button('confirm').click();
    await settle();
    expect(h.dialog.el.isConnected).toBe(true);
    expect(h.$('[data-ref="status"]')!.textContent).toBe('The picture could not be saved. Try again.');
    expect([h.dialog.marks.length, h.button('confirm').disabled]).toEqual([1, false]);
  });
});

/** Sends every image as it is, as a PNG. */
const asItIs: ImagePreparer = async (blob) => ({ blob, mediaType: 'image/png' });

/** A scene with a viewport to capture. */
class CapturableScene extends FakeScene {
  captureViewport = vi.fn(async () => new Blob(['viewport'], { type: 'image/png' }));
}

function mount(scene: FakeScene | null = new CapturableScene()) {
  const client = new FakeChatClient();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const fake = fakeImaging();
  const panel = new ChatPanel({
    container,
    client,
    slot: new LeftSlot({ width: 500 }),
    settings: () => ({ defaultAgent: null, permissionMode: 'ask' }),
    openExternal: () => {},
    prepareImage: asItIs,
    markupImaging: fake.imaging,
    ...(scene ? { scene } : {}),
  });
  panels.push(panel);
  const $ = <T extends Element = HTMLElement>(selector: string) => panel.el.querySelector<T>(selector);
  const input = () => $<HTMLTextAreaElement>('[data-ref="input"]')!;
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input'));
  };
  const enter = () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const thumbs = () => [...panel.el.querySelectorAll<HTMLElement>('[data-ref="image-thumb"]')].map((t) => `${t.title}(${t.dataset.state})`);
  const notice = () => {
    const el = $('[data-ref="image-notice"]')!;
    return el.classList.contains('hidden') ? '' : el.textContent;
  };
  const paste = (files: File[]) => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => '' } });
    input().dispatchEvent(event);
  };
  /** The markup dialog on the page, if one is open. */
  const markup = () => document.querySelector<HTMLElement>('[data-role="chat-markup"]');
  const draw = () => {
    const canvas = markup()!.querySelector('[data-ref="canvas"]')!;
    pointer(canvas, 'pointerdown', 100, 100);
    pointer(canvas, 'pointermove', 300, 200);
    pointer(canvas, 'pointerup', 300, 200);
  };
  const confirm = () => markup()!.querySelector<HTMLButtonElement>('[data-ref="confirm"]')!;
  return { client, panel, scene, ...fake, $, input, type, enter, thumbs, notice, paste, markup, draw, confirm };
}

async function opened(h: ReturnType<typeof mount>): Promise<void> {
  h.panel.show();
  await settle();
  await settle();
}

describe('capturing the viewport from the composer', () => {
  it('the Capture button, beside Attach, opens a picture of the viewport to draw on; attached, it goes with the message as viewport-markup.png', async () => {
    const h = mount();
    await opened(h);
    const capture = h.$<HTMLButtonElement>('[data-ref="capture"]')!;
    expect([capture.tagName, capture.getAttribute('aria-label'), capture.title, capture.disabled]).toEqual(['BUTTON', 'Capture the viewport', 'Capture the viewport and draw on it', false]);
    expect(capture.previousElementSibling).toBe(h.$('[data-ref="attach"]'));

    capture.click();
    await settle();
    expect((h.scene as CapturableScene).captureViewport).toHaveBeenCalledTimes(1);
    expect(h.markup()!.querySelector('h2')!.textContent).toBe('Mark up the viewport');
    expect(h.confirm().textContent).toBe('Attach');
    // One dialog at a time.
    capture.click();
    await settle();
    expect(document.querySelectorAll('[data-role="chat-markup"]')).toHaveLength(1);

    h.draw();
    h.confirm().click();
    await settle();
    expect(h.markup()).toBeNull();
    expect(h.thumbs()).toEqual(['viewport-markup.png(ready)']);
    expect(document.activeElement).toBe(h.input());
    // An image like any other: it goes without words, by its name.
    h.type('Make this wall thicker');
    h.enter();
    await settle();
    expect(h.client.sent[0].message).toMatchObject({
      text: 'Make this wall thicker',
      attachments: [{ mediaType: 'image/png', base64: base64('marked'), name: 'viewport-markup.png' }],
    });
    expect(h.thumbs()).toEqual([]);
  });

  it('attached with nothing drawn, it is the capture as it was taken, as viewport-capture.png; cancelled, nothing is attached', async () => {
    const h = mount();
    await opened(h);
    h.$<HTMLElement>('[data-ref="capture"]')!.click();
    await settle();
    h.confirm().click();
    await settle();
    expect(h.thumbs()).toEqual(['viewport-capture.png(ready)']);
    expect(h.encoded).toEqual([]);
    expect((await h.panel.images.forSend()).attachments).toEqual([{ mediaType: 'image/png', base64: base64('viewport'), name: 'viewport-capture.png' }]);

    h.$<HTMLElement>('[data-ref="capture"]')!.click();
    await settle();
    h.draw();
    h.markup()!.querySelector<HTMLElement>('[data-ref="cancel"]')!.click();
    await settle();
    expect(h.markup()).toBeNull();
    expect(h.thumbs()).toEqual(['viewport-capture.png(ready)']);
  });

  it('says so when the viewport cannot be captured, or the message already has all its images', async () => {
    const h = mount();
    await opened(h);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (h.scene as CapturableScene).captureViewport.mockRejectedValueOnce(new Error('no WebGL context'));
    h.$<HTMLElement>('[data-ref="capture"]')!.click();
    await settle();
    expect(h.markup()).toBeNull();
    expect(h.notice()).toBe('The viewport could not be captured.');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    h.panel.images.add(Array.from({ length: MAX_ATTACHMENTS }, (_, i) => file(`more-${i}.png`)));
    await settle();
    expect(h.notice()).toBe('');
    h.$<HTMLElement>('[data-ref="capture"]')!.click();
    await settle();
    // Not captured for nothing: there is no room for it.
    expect((h.scene as CapturableScene).captureViewport).toHaveBeenCalledTimes(1);
    expect(h.markup()).toBeNull();
    expect(h.notice()).toBe(`A message takes at most ${MAX_ATTACHMENTS} images.`);
  });

  it('is not offered without a viewport to capture, and the dialog closes with the panel', async () => {
    const none = mount(null);
    await opened(none);
    expect(none.$('[data-ref="capture"]')).toBeNull();
    const plain = mount(new FakeScene());
    await opened(plain);
    expect(plain.$('[data-ref="capture"]')).toBeNull();

    const h = mount();
    await opened(h);
    h.$<HTMLElement>('[data-ref="capture"]')!.click();
    await settle();
    expect(h.markup()).not.toBeNull();
    panels.splice(panels.indexOf(h.panel), 1);
    h.panel.destroy();
    await settle();
    expect(h.markup()).toBeNull();
  });
});

describe('marking up an image already attached', () => {
  it('the pen on its thumbnail opens it to draw on, and the marked-up picture takes its place and its name', async () => {
    const h = mount();
    await opened(h);
    h.paste([file('image.png')]);
    h.paste([file('front view.jpg', 'image/jpeg')]);
    await settle();
    expect(h.thumbs()).toEqual(['image.png(ready)', 'front view.jpg(ready)']);
    const pens = () => [...h.panel.el.querySelectorAll<HTMLButtonElement>('[data-ref="annotate-image"]')];
    expect(pens().map((b) => [b.tagName, b.getAttribute('aria-label'), b.title])).toEqual([
      ['BUTTON', 'Mark up image.png', 'Mark up'],
      ['BUTTON', 'Mark up front view.jpg', 'Mark up'],
    ]);

    pens()[1].click();
    await settle();
    expect(h.markup()!.querySelector('h2')!.textContent).toBe('Mark up front view.jpg');
    // Nothing drawn: nothing to replace it with.
    expect([h.confirm().textContent, h.confirm().disabled]).toEqual(['Replace', true]);
    h.draw();
    h.confirm().click();
    await settle();
    expect(h.markup()).toBeNull();
    // In its place in the row, ready again, under its name with -markup.
    expect(h.thumbs()).toEqual(['image.png(ready)', 'front view-markup.png(ready)']);
    expect((await h.panel.images.forSend()).attachments).toEqual([
      { mediaType: 'image/png', base64: base64('image.png'), name: 'image.png' },
      { mediaType: 'image/png', base64: base64('marked'), name: 'front view-markup.png' },
    ]);

    // Cancelled: the image stays as it was.
    pens()[0].click();
    await settle();
    h.draw();
    h.markup()!.querySelector<HTMLElement>('[data-ref="cancel"]')!.click();
    await settle();
    expect(h.thumbs()).toEqual(['image.png(ready)', 'front view-markup.png(ready)']);
  });

  it('says so when the image cannot be opened, and keeps it', async () => {
    const h = mount();
    await opened(h);
    h.paste([file('broken.png')]);
    await settle();
    h.$<HTMLElement>('[data-ref="annotate-image"]')!.click();
    await settle();
    expect(h.markup()).toBeNull();
    expect(h.thumbs()).toEqual(['broken.png(ready)']);
    expect(h.notice()).toBe('broken.png could not be opened to mark up.');
  });

  it('there is no pen while an image is still being made ready, nor where nothing can mark it up', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const annotate = vi.fn(async () => new Blob(['marked'], { type: 'image/png' }));
    const images = new ImageAttachments({ prepare: async (blob) => (await held, { blob, mediaType: 'image/png' }), annotate });
    document.body.append(images.el);
    images.add([file('slow.png')]);
    expect(images.el.querySelector('[data-ref="annotate-image"]')).toBeNull();
    release();
    await settle();
    images.el.querySelector<HTMLElement>('[data-ref="annotate-image"]')!.click();
    await settle();
    expect(annotate).toHaveBeenCalledTimes(1);
    expect(annotate.mock.calls[0][1]).toBe('slow.png');
    expect(images.el.querySelector<HTMLElement>('[data-ref="image-thumb"]')!.title).toBe('slow-markup.png');
    images.destroy();

    const bare = new ImageAttachments({ prepare: asItIs });
    bare.add([file('a.png')]);
    await settle();
    expect(bare.el.querySelector('[data-ref="annotate-image"]')).toBeNull();
    bare.destroy();
  });
});
