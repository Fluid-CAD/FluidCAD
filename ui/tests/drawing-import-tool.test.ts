// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { DrawingImportTool, DXF_IMPORT, SVG_IMPORT, MAX_IMPORT_STATEMENTS, type DrawingImportSource } from '../src/interactive/tools/drawing-import-tool';
import type { SolvedEmissionRequest } from '../src/interactive/tools/solved-emission';
import type { FontMeasure, FontMeasureRequest } from '../../lib/io/drawing/imported-text.js';
import type { PlaneData } from '../src/types';
import { sceneUnit } from '../src/units/scene-unit';

// The DXF tool's flows, driven against its dialog and a stubbed scene: a
// file read and shown where it is drawn (or in view when that is off
// screen), placed by hand (move, corner scale, rotate), its unit, scale and
// layers set in the dialog, and Import writing the placed curves as sketch
// statements with their joins in one emission.

const XY: PlaneData = {
  origin: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 },
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One sketch unit per client pixel, the sketch origin at client (500, 500), y up: the view shows −500…500 both ways. */
const toClient = (p: [number, number]) => ({ clientX: p[0] + 500, clientY: 500 - p[1] });

vi.mock('../src/interactive/sketch-plane-utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/interactive/sketch-plane-utils')>();
  return {
    ...original,
    projectToSketch: (_ctx: unknown, _plane: unknown, clientX: number, clientY: number) => [clientX - 500, 500 - clientY],
    pixelToSketchThreshold: (_ctx: unknown, px: number) => px,
  };
});

type Groups = (string | number)[];

function dxf(entities: Groups, header: Groups = [], tables: Groups = []): string {
  return [
    0, 'SECTION', 2, 'HEADER', ...header, 0, 'ENDSEC',
    0, 'SECTION', 2, 'TABLES', ...tables, 0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES', ...entities, 0, 'ENDSEC',
    0, 'EOF',
  ].join('\n');
}

const line = (layer: string, a: [number, number], b: [number, number]): Groups =>
  [0, 'LINE', 8, layer, 10, a[0], 20, a[1], 11, b[0], 21, b[1]];

/** A 40 × 20 rectangle with its lower-left corner at (100, 50), and a circle in it on its own layer. */
const PLATE = dxf([
  ...line('OUTLINE', [100, 50], [140, 50]),
  ...line('OUTLINE', [140, 50], [140, 70]),
  ...line('OUTLINE', [140, 70], [100, 70]),
  ...line('OUTLINE', [100, 70], [100, 50]),
  0, 'CIRCLE', 8, 'HOLES', 10, 120, 20, 60, 40, 4,
]);

/**
 * The fonts of the machine the tests pretend to build sketches on: Test
 * Sans, and Liberation Sans standing in for Arial. Neither has an italic.
 * A capital is 0.7 em tall and every letter half an em wide.
 */
const INSTALLED: Record<string, string> = { 'test sans': 'Test Sans', arial: 'Liberation Sans', 'sans-serif': 'Test Sans' };
const measureInstalled = async (requests: FontMeasureRequest[]): Promise<FontMeasure[] | null> => requests.map((request) => {
  const asked = request.families.find((family) => INSTALLED[family.toLowerCase()] !== undefined);
  if (asked === undefined || request.italic) {
    return { family: null, substituted: false, capital: 0, ascent: 0, descent: 0, lineGap: 0, advances: [] };
  }
  const family = INSTALLED[asked.toLowerCase()];
  return {
    family,
    substituted: family !== request.families[0],
    capital: 0.7,
    ascent: 0.9,
    descent: 0.2,
    lineGap: 0.05,
    advances: request.lines.map((line) => line.length * 0.5),
  };
});

function makeTool(opts: {
  emitResult?: { success: boolean; reason?: string };
  autoConstraints?: boolean;
  source?: DrawingImportSource;
  measureFonts?: (requests: FontMeasureRequest[]) => Promise<FontMeasure[] | null>;
} = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const scene = new Scene();
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000, x: 0, y: 0, toJSON() {} });
  const cameraControls = { enabled: true };
  const ctx: any = {
    renderer: { domElement: canvas },
    scene,
    cameraControls,
    requestRender: vi.fn(),
    subscribeCameraChange: vi.fn(() => () => {}),
    fitToBox: vi.fn(),
  };
  const onRequestExit = vi.fn();
  const files = new Map<File, string>();
  const tool = new DrawingImportTool(ctx, XY, {} as any, vi.fn(), container, {
    source: opts.source ?? DXF_IMPORT,
    onRequestExit,
    readBytes: async (file) => new TextEncoder().encode(files.get(file) ?? ''),
    measureFonts: opts.measureFonts ?? measureInstalled,
  });
  const emit = vi.fn(async (_request: SolvedEmissionRequest) => opts.emitResult ?? { success: true });
  tool.setSolvedContext({ emit, autoConstraints: () => opts.autoConstraints ?? true });
  tool.activate();

  const root = container.querySelector<HTMLElement>('#fluidcad-drawing-import-panel')!;
  const role = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector<T>(`[data-role="${name}"]`)!;
  const message = () => role('message');
  const choose = async (text: string, name = 'plate.dxf') => {
    const file = new File(['x'], name);
    files.set(file, text);
    const input = role<HTMLInputElement>('file');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    await flush();
  };
  const press = (p: [number, number], init: PointerEventInit = {}) => {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...toClient(p), button: 0, bubbles: true, ...init }));
  };
  const moveTo = (p: [number, number], init: PointerEventInit = {}) => {
    window.dispatchEvent(new PointerEvent('pointermove', { ...toClient(p), bubbles: true, ...init }));
  };
  const release = (p: [number, number]) => {
    window.dispatchEvent(new PointerEvent('pointerup', { ...toClient(p), button: 0, bubbles: true }));
  };
  const drag = (from: [number, number], to: [number, number], init: PointerEventInit = {}) => {
    press(from);
    moveTo(to, init);
    release(to);
  };
  const apply = async () => {
    role<HTMLButtonElement>('apply').click();
    await flush();
  };
  const texts = () => (emit.mock.calls[emit.mock.calls.length - 1][0] as SolvedEmissionRequest).geometry.map((g) => g.text);
  const layerBox = (name: string) => root.querySelector<HTMLInputElement>(`input[data-layer="${name}"]`)!;
  return { tool: tool as any, ctx, scene, emit, onRequestExit, cameraControls, role, message, choose, press, moveTo, release, drag, apply, texts, layerBox };
}

afterEach(() => {
  document.body.innerHTML = '';
  sceneUnit.set('mm');
});

describe('DrawingImportTool: reading a file', () => {
  it('opens with nothing to import: the options hidden, Import off', () => {
    const { role, scene, tool } = makeTool();
    expect(role('options').classList.contains('hidden')).toBe(true);
    expect(role<HTMLButtonElement>('apply').disabled).toBe(true);
    expect(role('file').getAttribute('accept')).toBe('.dxf');
    expect(scene.children).toContain(tool.preview.group);
    expect(tool.preview.segmentCount).toBe(0);
  });

  it('shows a file where it is drawn, with its layers, size and what Import would write', async () => {
    const { role, choose, tool, layerBox } = makeTool();
    await choose(PLATE);
    expect(role('file-label').textContent).toBe('plate.dxf');
    expect(role('options').classList.contains('hidden')).toBe(false);
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm at 120.00, 60.00');
    expect(role('summary').textContent).toBe('5 sketch entities, 4 joins');
    expect(role('layers').classList.contains('hidden')).toBe(false);
    expect(layerBox('OUTLINE').checked).toBe(true);
    expect(layerBox('HOLES').checked).toBe(true);
    expect(role<HTMLButtonElement>('apply').disabled).toBe(false);
    // Four lines and a circle, drawn.
    expect(tool.preview.segmentCount).toBeGreaterThan(4);
    expect(tool.handles.group.children.length).toBeGreaterThan(0);
  });

  it('puts a drawing made far from its file\'s origin in the middle of the view', async () => {
    const { role, choose, ctx } = makeTool();
    await choose(dxf([...line('0', [5000, 5000], [5040, 5000]), ...line('0', [5040, 5000], [5040, 5020])]));
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm at 0.00, 0.00');
    expect(ctx.fitToBox).not.toHaveBeenCalled();
  });

  it('keeps a drawing made near its file\'s origin as drawn even when the view is elsewhere, and zooms out to it', async () => {
    const { role, choose, ctx } = makeTool();
    // 400 away from the origin and 2000 across: the view (±500) shows only its near end.
    await choose(dxf([...line('0', [400, 600], [2400, 600]), ...line('0', [2400, 600], [2400, 700])]));
    expect(role('readout').textContent).toBe('2000.00 × 100.00 mm at 1400.00, 650.00');
    expect(ctx.fitToBox).toHaveBeenCalledTimes(1);
  });

  it('zooms out to a drawing larger than the view, and leaves the camera alone for one in full view', async () => {
    const small = makeTool();
    await small.choose(PLATE);
    expect(small.ctx.fitToBox).not.toHaveBeenCalled();
    document.body.innerHTML = '';

    const large = makeTool();
    await large.choose(dxf([...line('0', [0, 0], [3000, 0]), ...line('0', [3000, 0], [3000, 900])]));
    expect(large.role('readout').textContent).toBe('3000.00 × 900.00 mm at 1500.00, 450.00');
    expect(large.ctx.fitToBox).toHaveBeenCalledTimes(1);
    const box = large.ctx.fitToBox.mock.calls[0][0];
    expect([box.min.x, box.min.y, box.max.x, box.max.y]).toEqual([0, 0, 3000, 900]);
  });

  it('says why a file cannot be read, and keeps the one already shown', async () => {
    const { role, choose, message } = makeTool();
    await choose(PLATE);
    await choose('<svg xmlns="http://www.w3.org/2000/svg"/>', 'logo.dxf');
    expect(message().textContent).toMatch(/not a DXF file/);
    expect(role('file-label').textContent).toBe('plate.dxf');
    expect(role('summary').textContent).toBe('5 sketch entities, 4 joins');
  });

  it('says so when a file holds nothing to draw', async () => {
    const { choose, message, role } = makeTool();
    await choose(dxf([0, 'HATCH', 8, '0', 2, 'SOLID']));
    expect(message().textContent).toBe('The file has no lines, curves or points to import (it holds 1 HATCH).');
    expect(role<HTMLButtonElement>('apply').disabled).toBe(true);
  });

  it('refuses a file over the size limit before reading it', async () => {
    const { tool, message } = makeTool();
    const big = new File(['x'], 'big.dxf');
    Object.defineProperty(big, 'size', { value: DXF_IMPORT.maxBytes + 1 });
    await tool.chooseFile(big);
    expect(message().textContent).toMatch(/the limit is 32 MB/);
  });

  it('notes what was left out, and leaves layers the file has off unticked', async () => {
    const { role, choose, layerBox } = makeTool();
    await choose(dxf(
      [...line('CUT', [0, 0], [10, 0]), ...line('NOTES', [0, 5], [10, 5]), 0, 'HATCH', 8, 'NOTES', 2, 'SOLID'],
      [],
      [0, 'TABLE', 2, 'LAYER', 0, 'LAYER', 2, 'CUT', 70, 0, 62, 7, 0, 'LAYER', 2, 'NOTES', 70, 1, 62, 7, 0, 'ENDTAB'],
    ));
    expect(layerBox('CUT').checked).toBe(true);
    expect(layerBox('NOTES').checked).toBe(false);
    expect(role('summary').textContent).toBe('1 sketch entity');
    // Folded under a count until opened.
    expect(role('warnings').classList.contains('hidden')).toBe(false);
    expect(role('warnings-title').textContent).toBe('Warnings (1)');
    expect(role<HTMLInputElement>('warnings-toggle').checked).toBe(false);
    expect(role('notes').textContent).toBe('Not curves, left out: 1 HATCH.');
  });

  it('shows no warnings section for a file that has none, and plain boxes for its layers', async () => {
    const { role, choose, layerBox } = makeTool();
    await choose(PLATE);
    expect(role('warnings').classList.contains('hidden')).toBe(true);
    expect(layerBox('OUTLINE').className).toBe('checkbox checkbox-xs');
  });
});

describe('DrawingImportTool: Import', () => {
  it('writes the drawing as drawn: a statement per curve and a coincident per corner, then leaves', async () => {
    const { choose, apply, emit, texts, onRequestExit } = makeTool();
    await choose(PLATE);
    await apply();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(texts()).toEqual([
      'line([100, 50], [140, 50])',
      'line([140, 50], [140, 70])',
      'line([140, 70], [100, 70])',
      'line([100, 70], [100, 50])',
      'circle([120, 60], 8)',
    ]);
    const request = emit.mock.calls[0][0];
    expect(request.constraints).toHaveLength(4);
    expect(request.constraints.every((c) => c.kind === 'coincident')).toBe(true);
    expect(onRequestExit).toHaveBeenCalledTimes(1);
  });

  it('writes no joins with the toggle off, and starts it from the sketch\'s auto-constraints', async () => {
    const off = makeTool({ autoConstraints: false });
    expect(off.role<HTMLInputElement>('joins').checked).toBe(false);
    await off.choose(PLATE);
    expect(off.role('summary').textContent).toBe('5 sketch entities');
    await off.apply();
    expect(off.emit.mock.calls[0][0].constraints).toEqual([]);
  });

  it('drops the joins from the summary and the edit when the toggle is turned off', async () => {
    const { choose, role, apply, emit } = makeTool();
    await choose(PLATE);
    const toggle = role<HTMLInputElement>('joins');
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(role('summary').textContent).toBe('5 sketch entities');
    await apply();
    expect(emit.mock.calls[0][0].geometry).toHaveLength(5);
    expect(emit.mock.calls[0][0].constraints).toEqual([]);
  });

  it('fixes the drawing in place when asked: off to start with, counted in the summary, written after the joins', async () => {
    const { choose, role, apply, emit } = makeTool();
    await choose(PLATE);
    const toggle = role<HTMLInputElement>('fix');
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    // Four corners fixed once each, the circle's centre and its diameter.
    expect(role('summary').textContent).toBe('5 sketch entities, 4 joins, fixed by 6 constraints');
    await apply();
    const kinds = emit.mock.calls[0][0].constraints.map((c) => c.kind);
    expect(kinds).toEqual(['coincident', 'coincident', 'coincident', 'coincident', 'fix', 'fix', 'fix', 'fix', 'fix', 'diameter']);
  });

  it('fixes every end when the joins are off', async () => {
    const { choose, role, apply, emit } = makeTool({ autoConstraints: false });
    await choose(PLATE);
    const toggle = role<HTMLInputElement>('fix');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(role('summary').textContent).toBe('5 sketch entities, fixed by 10 constraints');
    await apply();
    expect(emit.mock.calls[0][0].constraints.filter((c) => c.kind === 'fix')).toHaveLength(9);
  });

  it('stays open with the reason when the sketch refuses the edit', async () => {
    const { choose, apply, message, onRequestExit, role } = makeTool({ emitResult: { success: false, reason: 'no sketch statement at line 7' } });
    await choose(PLATE);
    await apply();
    expect(message().textContent).toBe('no sketch statement at line 7');
    expect(onRequestExit).not.toHaveBeenCalled();
    expect(role<HTMLButtonElement>('apply').disabled).toBe(false);
  });

  it('brings in only the ticked layers, the drawing staying where it is', async () => {
    const { choose, apply, texts, layerBox, role } = makeTool();
    await choose(PLATE);
    const outline = layerBox('OUTLINE');
    outline.checked = false;
    outline.dispatchEvent(new Event('change'));
    expect(role('summary').textContent).toBe('1 sketch entity');
    expect(role('readout').textContent).toBe('8.00 × 8.00 mm at 120.00, 60.00');
    await apply();
    expect(texts()).toEqual(['circle([120, 60], 8)']);
  });

  it('blocks Import with no layer ticked', async () => {
    const { choose, layerBox, role } = makeTool();
    await choose(PLATE);
    for (const name of ['OUTLINE', 'HOLES']) {
      const box = layerBox(name);
      box.checked = false;
      box.dispatchEvent(new Event('change'));
    }
    expect(role('summary').textContent).toBe('Tick at least one layer.');
    expect(role<HTMLButtonElement>('apply').disabled).toBe(true);
  });

  it('refuses a drawing of more statements than one import takes', async () => {
    const groups: Groups = [];
    for (let i = 0; i <= MAX_IMPORT_STATEMENTS; i++) {
      groups.push(...line('0', [i, 0], [i, 1]));
    }
    const { choose, role, apply, emit } = makeTool();
    await choose(dxf(groups));
    expect(role('summary').textContent).toBe('This would write 2,001 sketch entities; one import takes up to 2,000.');
    expect(role<HTMLButtonElement>('apply').disabled).toBe(true);
    await apply();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('DrawingImportTool: points', () => {
  const point = (layer: string, at: [number, number]): Groups => [0, 'POINT', 8, layer, 10, at[0], 20, at[1]];

  /** The plate's outline with a drill centre near each end and a datum mark on its first corner. */
  const DRILLED = dxf([
    ...line('OUTLINE', [100, 50], [140, 50]),
    ...line('OUTLINE', [140, 50], [140, 70]),
    ...line('OUTLINE', [140, 70], [100, 70]),
    ...line('OUTLINE', [100, 70], [100, 50]),
    ...point('DRILL', [108, 60]),
    ...point('DRILL', [132, 60]),
    ...point('DATUM', [100, 50]),
  ]);

  it('shows a file\'s points as dots among its curves, with their layers', async () => {
    const { role, choose, tool, layerBox } = makeTool();
    await choose(DRILLED);
    expect(tool.preview.pointCount).toBe(3);
    expect(tool.preview.segmentCount).toBe(4);
    expect(layerBox('DRILL').checked).toBe(true);
    expect(layerBox('DRILL').parentElement!.textContent).toContain('2');
    // The corner mark rides on the outline's first corner: one more join than the outline's four.
    expect(role('summary').textContent).toBe('7 sketch entities, 5 joins');
    expect(role('warnings').classList.contains('hidden')).toBe(true);
  });

  it('writes each point as a point statement, after the curves, and ties the one on a corner to it', async () => {
    const { choose, apply, emit, texts } = makeTool();
    await choose(DRILLED);
    await apply();
    expect(texts()).toEqual([
      'line([100, 50], [140, 50])',
      'line([140, 50], [140, 70])',
      'line([140, 70], [100, 70])',
      'line([100, 70], [100, 50])',
      'point([108, 60])',
      'point([132, 60])',
      'point([100, 50])',
    ]);
    const request = emit.mock.calls[0][0];
    expect(request.geometry.slice(4).map((g) => g.kind)).toEqual(['point', 'point', 'point']);
    // A point statement is the point itself: the join names it without a role.
    expect(request.constraints).toContainEqual({ kind: 'coincident', targets: [{ newIndex: 0, role: 'start' }, { newIndex: 6 }] });
    expect(request.constraints).toHaveLength(5);
  });

  it('fixes a point that stands alone, and leaves one on a corner to its join', async () => {
    const { choose, role, apply, emit } = makeTool();
    await choose(DRILLED);
    const toggle = role<HTMLInputElement>('fix');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    // Four corners and the two drill centres.
    expect(role('summary').textContent).toBe('7 sketch entities, 5 joins, fixed by 6 constraints');
    await apply();
    const fixes = emit.mock.calls[0][0].constraints.filter((c) => c.kind === 'fix');
    expect(fixes.slice(-2)).toEqual([{ kind: 'fix', targets: [{ newIndex: 4 }] }, { kind: 'fix', targets: [{ newIndex: 5 }] }]);
  });

  it('brings in a layer of points on its own, placed with the rest', async () => {
    const { choose, apply, texts, layerBox, role, tool } = makeTool();
    await choose(DRILLED);
    for (const name of ['OUTLINE', 'DATUM']) {
      const box = layerBox(name);
      box.checked = false;
      box.dispatchEvent(new Event('change'));
    }
    expect(tool.preview.segmentCount).toBe(0);
    expect(tool.preview.pointCount).toBe(2);
    expect(role('summary').textContent).toBe('2 sketch entities');
    expect(role('readout').textContent).toBe('24.00 × 0.00 mm at 120.00, 60.00');
    await apply();
    expect(texts()).toEqual(['point([108, 60])', 'point([132, 60])']);
  });

  it('scales and converts points with the drawing', async () => {
    const { choose, apply, texts } = makeTool();
    await choose(dxf([...line('0', [0, 0], [2, 0]), ...point('0', [1, 1])], [9, '$INSUNITS', 70, 1]));
    await apply();
    expect(texts()).toEqual(['line([0, 0], [50.8, 0])', 'point([25.4, 25.4])']);
  });

  it('imports a file of one point: a frame to grab it by, the point where the file has it', async () => {
    const { choose, apply, texts, role, tool } = makeTool();
    await choose(dxf(point('0', [12, 8])));
    expect(role<HTMLButtonElement>('apply').disabled).toBe(false);
    expect(tool.preview.pointCount).toBe(1);
    const frame = tool.frame();
    expect(frame.spec.width).toBe(1);
    expect(frame.spec.height).toBe(1);
    await apply();
    expect(texts()).toEqual(['point([12, 8])']);
  });
});

describe('DrawingImportTool: construction lines', () => {
  const xline = (layer: string, at: [number, number], direction: [number, number]): Groups =>
    [0, 'XLINE', 8, layer, 10, at[0], 20, at[1], 11, direction[0], 21, direction[1]];
  const ray = (layer: string, at: [number, number], direction: [number, number]): Groups =>
    [0, 'RAY', 8, layer, 10, at[0], 20, at[1], 11, direction[0], 21, direction[1]];

  /** The plate's outline, its two centre lines as construction lines, and a ray from its first corner along the lower edge. */
  const LAID_OUT = dxf([
    ...line('OUTLINE', [100, 50], [140, 50]),
    ...line('OUTLINE', [140, 50], [140, 70]),
    ...line('OUTLINE', [140, 70], [100, 70]),
    ...line('OUTLINE', [100, 70], [100, 50]),
    ...xline('LAYOUT', [120, 60], [1, 0]),
    ...xline('LAYOUT', [120, 60], [0, 1]),
    ...ray('LAYOUT', [100, 50], [1, 0]),
  ]);

  const turnOn = (role: ReturnType<typeof makeTool>['role']) => {
    const toggle = role<HTMLInputElement>('guides');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
  };

  it('has no toggle for a file without construction lines', async () => {
    const { role, choose } = makeTool();
    await choose(PLATE);
    expect(role('guides-row').classList.contains('hidden')).toBe(true);
  });

  it('shows the toggle for a file that has them, off: nothing of them drawn, counted or written', async () => {
    const { role, choose, tool, apply, texts } = makeTool();
    await choose(LAID_OUT);
    expect(role('guides-row').classList.contains('hidden')).toBe(false);
    expect(role<HTMLInputElement>('guides').checked).toBe(false);
    expect(tool.preview.guideCount).toBe(0);
    expect(role('summary').textContent).toBe('4 sketch entities, 4 joins');
    // Read, not left out: nothing to warn about.
    expect(role('warnings').classList.contains('hidden')).toBe(true);
    await apply();
    expect(texts()).toHaveLength(4);
  });

  it('draws them once asked for, counts them in the summary, and leaves the drawing\'s frame as it was', async () => {
    const { role, choose, tool } = makeTool();
    await choose(LAID_OUT);
    const frame = tool.frame().spec;
    turnOn(role);
    expect(tool.preview.guideCount).toBe(3);
    expect(tool.preview.segmentCount).toBe(4);
    expect(role('summary').textContent).toBe('7 sketch entities (3 guide lines), 4 joins');
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm at 120.00, 60.00');
    expect(tool.frame().spec).toEqual(frame);
  });

  it('writes each as a guide line cut a little past the drawing, after the curves, joined to nothing', async () => {
    const { role, choose, apply, emit, texts } = makeTool();
    await choose(LAID_OUT);
    turnOn(role);
    await apply();
    // The frame is the plate and a tenth of its longer side: 96…144 by 46…74.
    expect(texts().slice(4)).toEqual([
      'line([96, 60], [144, 60])',
      'line([120, 46], [120, 74])',
      'line([100, 50], [144, 50])',
    ]);
    const request = emit.mock.calls[0][0];
    expect(request.geometry.map((g) => g.guide === true)).toEqual([false, false, false, false, true, true, true]);
    // The four corners and no more: the ray starts on a corner and is not tied to it.
    expect(request.constraints).toHaveLength(4);
  });

  it('fixes both ends of each guide line when the drawing is fixed in place', async () => {
    const { role, choose, apply, emit } = makeTool();
    await choose(LAID_OUT);
    turnOn(role);
    const fix = role<HTMLInputElement>('fix');
    fix.checked = true;
    fix.dispatchEvent(new Event('change'));
    // Four corners, and two ends for each of three guide lines.
    expect(role('summary').textContent).toBe('7 sketch entities (3 guide lines), 4 joins, fixed by 10 constraints');
    await apply();
    const fixes = emit.mock.calls[0][0].constraints.filter((c) => c.kind === 'fix');
    expect(fixes.slice(-6)).toEqual([4, 5, 6].flatMap((newIndex) => [
      { kind: 'fix', targets: [{ newIndex, role: 'start' }] },
      { kind: 'fix', targets: [{ newIndex, role: 'end' }] },
    ]));
  });

  it('says what to do when only construction lines are ticked, and sizes them by themselves once asked for', async () => {
    const { role, choose, apply, texts, layerBox, tool } = makeTool();
    await choose(LAID_OUT);
    const outline = layerBox('OUTLINE');
    outline.checked = false;
    outline.dispatchEvent(new Event('change'));
    expect(role('summary').textContent).toBe('Only construction lines on the ticked layers. Turn on Construction lines to import them.');
    expect(role<HTMLButtonElement>('apply').disabled).toBe(true);
    turnOn(role);
    expect(tool.preview.guideCount).toBe(3);
    expect(role<HTMLButtonElement>('apply').disabled).toBe(false);
    await apply();
    // Their own points span 100…120 by 50…60: a frame 2 wider all round.
    expect(texts()).toEqual([
      'line([98, 60], [122, 60])',
      'line([120, 48], [120, 62])',
      'line([100, 50], [122, 50])',
    ]);
  });

  it('opens a file of nothing but construction lines, and imports two axes through one point a hundred units long', async () => {
    const { role, choose, apply, texts, message } = makeTool();
    await choose(dxf([...xline('0', [10, 20], [1, 0]), ...xline('0', [10, 20], [0, 1])]));
    expect(message().textContent).toBe('');
    expect(role('options').classList.contains('hidden')).toBe(false);
    expect(role('guides-row').classList.contains('hidden')).toBe(false);
    expect(role<HTMLButtonElement>('apply').disabled).toBe(true);
    turnOn(role);
    expect(role('summary').textContent).toBe('2 sketch entities (2 guide lines)');
    expect(role('readout').textContent).toBe('100.00 × 100.00 mm at 10.00, 20.00');
    await apply();
    expect(texts()).toEqual(['line([-40, 20], [60, 20])', 'line([10, -30], [10, 70])']);
  });

  it('scales and converts construction lines with the drawing', async () => {
    const { role, choose, apply, texts } = makeTool();
    await choose(dxf([...line('0', [0, 0], [10, 0]), ...xline('0', [5, 0], [0, 1])], [9, '$INSUNITS', 70, 1]));
    turnOn(role);
    await apply();
    expect(texts()).toEqual(['line([0, 0], [254, 0])', 'line([127, -25.4], [127, 25.4])']);
  });

  it('turns the toggle back off for the next file', async () => {
    const { role, choose, tool } = makeTool();
    await choose(LAID_OUT);
    turnOn(role);
    await choose(LAID_OUT);
    expect(role<HTMLInputElement>('guides').checked).toBe(false);
    expect(tool.preview.guideCount).toBe(0);
  });

  it('counts guide lines towards the most one import writes', async () => {
    const many: Groups = [...line('0', [0, 0], [10, 0])];
    for (let i = 0; i < MAX_IMPORT_STATEMENTS; i++) {
      many.push(...xline('0', [i / 1000, 0], [0, 1]));
    }
    const { role, choose } = makeTool();
    await choose(dxf(many));
    expect(role<HTMLButtonElement>('apply').disabled).toBe(false);
    turnOn(role);
    expect(role('summary').textContent).toMatch(/^This would write 2,001 sketch entities; one import takes up to 2,000\./);
    expect(role<HTMLButtonElement>('apply').disabled).toBe(true);
  });
});

describe('DrawingImportTool: text', () => {
  /** A style table: NOTES is Test Sans, which is installed; OLD an AutoCAD pen font; ISO a font that is not installed. */
  const STYLES: Groups = [
    0, 'TABLE', 2, 'STYLE',
    0, 'STYLE', 2, 'NOTES', 70, 0, 41, 1, 50, 0, 3, 'testsans.ttf', 1001, 'ACAD', 1000, 'Test Sans', 1071, 34,
    0, 'STYLE', 2, 'OLD', 70, 0, 41, 1, 50, 0, 3, 'txt',
    0, 'STYLE', 2, 'ISO', 70, 0, 41, 1, 50, 0, 3, 'isocpeur.ttf', 1001, 'ACAD', 1000, 'ISOCPEUR', 1071, 34,
    0, 'STYLE', 2, 'ARIAL', 70, 0, 41, 1, 50, 0, 3, 'arial.ttf',
    0, 'ENDTAB',
  ];
  const text = (style: string, at: [number, number], content: string, more: Groups = []): Groups =>
    [0, 'TEXT', 8, 'NOTES', 7, style, 10, at[0], 20, at[1], 40, 3.5, 1, content, ...more];
  const OUTLINE: Groups = [
    ...line('OUTLINE', [100, 50], [140, 50]),
    ...line('OUTLINE', [140, 50], [140, 70]),
    ...line('OUTLINE', [140, 70], [100, 70]),
    ...line('OUTLINE', [100, 70], [100, 50]),
  ];
  /** The plate with a title, a label up its right side, and two notes no sketch text can stand for. */
  const NOTED = dxf([
    ...OUTLINE,
    ...text('NOTES', [105, 55], 'PLATE A'),
    ...text('NOTES', [138, 52], 'SIDE', [50, 90]),
    ...text('OLD', [105, 62], 'REV 2'),
    ...text('NOTES', [105, 66], 'NARROW', [41, 0.8]),
  ], [], STYLES);

  const turnOn = (role: ReturnType<typeof makeTool>['role']) => {
    const toggle = role<HTMLInputElement>('texts');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
  };

  it('has no toggle for a file without text', async () => {
    const { role, choose } = makeTool();
    await choose(PLATE);
    expect(role('texts-row').classList.contains('hidden')).toBe(true);
  });

  it('shows the toggle for a DXF with text that can come in, off: nothing of it drawn, counted or written', async () => {
    const { role, choose, tool, apply, emit } = makeTool();
    await choose(NOTED);
    expect(role('texts-row').classList.contains('hidden')).toBe(false);
    expect(role<HTMLInputElement>('texts').checked).toBe(false);
    expect(tool.preview.textCount).toBe(0);
    expect(role('summary').textContent).toBe('4 sketch entities, 4 joins');
    await apply();
    expect(emit.mock.calls[0][0].texts).toBeUndefined();
  });

  it('says, off or on, which texts cannot come in and why', async () => {
    const { role, choose } = makeTool();
    await choose(NOTED);
    const notes = () => [...role('notes').querySelectorAll('li')].map((item) => item.textContent);
    const expected = [
      '1 text is left out: it is drawn in a pen font (SHX), which has no outlines to make sketch text from.',
      '1 text is left out: its letters are stretched, slanted or mirrored, which sketch text cannot be.',
    ];
    expect(notes()).toEqual(expected);
    turnOn(role);
    expect(notes()).toEqual(expected);
  });

  it('boxes the texts where they will land once asked for, and counts them and the baseline of the turned one', async () => {
    const { role, choose, tool } = makeTool();
    await choose(NOTED);
    turnOn(role);
    expect(tool.preview.textCount).toBe(2);
    expect(role('summary').textContent).toBe('7 sketch entities (1 guide line, 2 texts), 4 joins');
    // The drawing is still placed and measured by its outline.
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm at 120.00, 60.00');
  });

  it('writes a level text by its anchor and a turned one along a guide line on its baseline, sized by the font\'s own capital', async () => {
    const { role, choose, apply, emit, texts } = makeTool();
    await choose(NOTED);
    turnOn(role);
    await apply();
    const request = emit.mock.calls[0][0];
    // 3.5 high in a font whose capitals are 0.7 of the em: an em of 5. SIDE is four letters of half an em: 10 long.
    expect(texts().slice(4)).toEqual(['line([138, 52], [138, 62])']);
    expect(request.geometry[4].guide).toBe(true);
    expect(request.texts).toEqual([
      { string: '"PLATE A"', chain: ".font('Test Sans').size(5).at([105, 55])" },
      { string: '"SIDE"', chain: ".font('Test Sans').size(5)", path: 4 },
    ]);
    // The four corners: no text is tied to anything.
    expect(request.constraints).toHaveLength(4);
  });

  it('fixes a level text by its anchor and a turned one by the ends of its baseline', async () => {
    const { role, choose, apply, emit } = makeTool();
    await choose(NOTED);
    turnOn(role);
    const fix = role<HTMLInputElement>('fix');
    fix.checked = true;
    fix.dispatchEvent(new Event('change'));
    // Four corners, the baseline's two ends, the anchor.
    expect(role('summary').textContent).toBe('7 sketch entities (1 guide line, 2 texts), 4 joins, fixed by 7 constraints');
    await apply();
    const request = emit.mock.calls[0][0];
    expect(request.texts!.map((written) => written.fix === true)).toEqual([true, false]);
    const fixes = request.constraints.filter((c) => c.kind === 'fix');
    expect(fixes.slice(-2)).toEqual([
      { kind: 'fix', targets: [{ newIndex: 4, role: 'start' }] },
      { kind: 'fix', targets: [{ newIndex: 4, role: 'end' }] },
    ]);
    expect(fixes).toHaveLength(6);
  });

  it('writes what differs from a text\'s defaults: justification, bold, and a multi-line text\'s line spacing', async () => {
    const { role, choose, apply, emit } = makeTool();
    await choose(dxf([
      ...OUTLINE,
      ...text('NOTES', [0, 0], 'MID', [72, 1, 73, 2, 11, 120, 21, 60]),
      0, 'MTEXT', 8, 'NOTES', 7, 'NOTES', 10, 105, 20, 68, 40, 1.4, 71, 3, 1, '{\\fTest Sans|b1|i0;ONE\\PTWO}',
    ], [], STYLES));
    turnOn(role);
    await apply();
    // Middle Centre: the anchor is half a capital (1.75) under the point. The multi-line text hangs from its
    // point by a capital (1.4): its lines are 1.4 × 5/3 apart, where the font's own are 2 × 1.15.
    expect(emit.mock.calls[0][0].texts).toEqual([
      { string: '"MID"', chain: ".font('Test Sans').size(5).align('center').at([120, 58.25])" },
      { string: '"ONE\\nTWO"', chain: ".font('Test Sans').size(2).bold().align('right').lineSpacing(1.014493).at([105, 66.6])" },
    ]);
  });

  it('moves, turns and scales text with the drawing: a turned drawing writes every text along a baseline', async () => {
    const { role, choose, apply, emit, texts, press, moveTo, release } = makeTool();
    await choose(dxf([...line('0', [0, 0], [2, 0]), ...text('NOTES', [0, 1], 'AB')], [9, '$INSUNITS', 70, 1], STYLES));
    turnOn(role);
    await apply();
    // Inches into millimetres: the point, the height and so the em all 25.4 times as large.
    expect(emit.mock.calls[0][0].texts).toEqual([{ string: '"AB"', chain: ".font('Test Sans').size(127).at([0, 25.4])" }]);

    // A quarter turn by the knob, with Shift to land on it exactly: the knob sits 28 above the
    // frame's top edge, and the frame of this one line is a strip 50.8 long about (25.4, 0).
    press([25.4, 2.032 + 28]);
    moveTo([-200, 0], { shiftKey: true });
    release([-200, 0]);
    expect(role('readout').textContent).toMatch(/· 90°$/);
    await apply();
    const turned = emit.mock.calls[1][0];
    // The text's point, 25.4 left of and above the middle, is now 25.4 left of and below it;
    // its baseline runs up from there, as long as its two letters are wide.
    expect(texts()).toEqual(['line([25.4, -25.4], [25.4, 25.4])', 'line([0, -25.4], [0, 101.6])']);
    expect(turned.geometry[1].guide).toBe(true);
    expect(turned.texts).toEqual([{ string: '"AB"', chain: ".font('Test Sans').size(127)", path: 1 }]);
  });

  it('leaves out a text whose font is not installed, naming the font, and says which font stands in for another', async () => {
    const { role, choose, apply, emit } = makeTool();
    await choose(dxf([...OUTLINE, ...text('ISO', [105, 55], 'ISO NOTE'), ...text('ARIAL', [105, 62], 'ARIAL NOTE')], [], STYLES));
    const notes = () => [...role('notes').querySelectorAll('li')].map((item) => item.textContent);
    expect(notes()).toEqual(['1 text is left out: its font is not installed (ISOCPEUR).']);
    turnOn(role);
    expect(notes()).toEqual([
      '1 text is left out: its font is not installed (ISOCPEUR).',
      '1 text is written in Liberation Sans: Arial, which the file asks for, is not installed.',
    ]);
    await apply();
    expect(emit.mock.calls[0][0].texts).toEqual([{ string: '"ARIAL NOTE"', chain: ".font('Liberation Sans').size(5).at([105, 62])" }]);
  });

  it('has no toggle when none of the file\'s text can come in, and still says why', async () => {
    const { role, choose } = makeTool();
    await choose(dxf([...OUTLINE, ...text('OLD', [105, 55], 'REV 2')], [], STYLES));
    expect(role('texts-row').classList.contains('hidden')).toBe(true);
    expect(role('notes').textContent).toBe('1 text is left out: it is drawn in a pen font (SHX), which has no outlines to make sketch text from.');
  });

  it('says so when the fonts cannot be measured: no text comes in, the drawing still does', async () => {
    const { role, choose, apply, emit } = makeTool({ measureFonts: async () => null });
    await choose(NOTED);
    expect(role('texts-row').classList.contains('hidden')).toBe(true);
    expect(role('notes').querySelector('li')!.textContent).toBe('2 texts are left out: their fonts could not be measured, because the server did not answer.');
    await apply();
    expect(emit.mock.calls[0][0].geometry).toHaveLength(4);
  });

  it('opens a file of nothing but text, placed by its text, and says how to bring it in', async () => {
    const { role, choose, apply, emit, tool, message } = makeTool();
    await choose(dxf(text('NOTES', [10, 20], 'ABCD'), [], STYLES));
    expect(message().textContent).toBe('');
    expect(role('summary').textContent).toBe('Only text on the ticked layers. Turn on Text to import it.');
    expect(role<HTMLButtonElement>('apply').disabled).toBe(true);
    turnOn(role);
    expect(tool.preview.textCount).toBe(1);
    expect(role('summary').textContent).toBe('1 sketch entity (1 text)');
    // Four letters of half an em of 5, a capital of 3.5: the text's own box.
    expect(role('readout').textContent).toBe('10.00 × 3.50 mm at 15.00, 21.75');
    await apply();
    expect(emit.mock.calls[0][0].geometry).toEqual([]);
    expect(emit.mock.calls[0][0].texts).toEqual([{ string: '"ABCD"', chain: ".font('Test Sans').size(5).at([10, 20])" }]);
  });

  it('refuses a file that holds only text no sketch text can stand for, with the reason', async () => {
    const { choose, message, role } = makeTool();
    await choose(dxf([0, 'TEXT', 8, '0', 10, 0, 20, 0, 40, 2, 1, 'hello']));
    expect(message().textContent).toBe('The file has no lines, curves or points to import. '
      + '1 text is left out: it is drawn in a pen font (SHX), which has no outlines to make sketch text from.');
    expect(role<HTMLButtonElement>('apply').disabled).toBe(true);
  });

  it('brings in the text of the ticked layers only, and warns about those only', async () => {
    const { role, choose, layerBox, tool } = makeTool();
    await choose(NOTED);
    turnOn(role);
    const notes = layerBox('NOTES');
    notes.checked = false;
    notes.dispatchEvent(new Event('change'));
    expect(tool.preview.textCount).toBe(0);
    expect(role('summary').textContent).toBe('4 sketch entities, 4 joins');
    expect(role('warnings').classList.contains('hidden')).toBe(true);
  });

  it('starts with text on for an SVG, where it is part of the artwork, and writes it Y up', async () => {
    const { role, choose, apply, emit, tool } = makeTool({ source: SVG_IMPORT });
    await choose(`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="60mm" viewBox="0 0 100 60">
      <rect x="20" y="10" width="40" height="20" fill="none" stroke="#000"/>
      <text x="40" y="24" font-family="'Test Sans', sans-serif" font-size="6" text-anchor="middle" font-weight="bold">LOGO</text>
      <text x="22" y="28" font-family="Gill Sans" font-size="3">fine print</text>
      <text x="10 12 14" y="50" font-family="Test Sans">pdf</text></svg>`, 'logo.svg');
    expect(role('texts-row').classList.contains('hidden')).toBe(false);
    expect(role<HTMLInputElement>('texts').checked).toBe(true);
    expect(tool.preview.textCount).toBe(1);
    expect(role('summary').textContent).toBe('5 sketch entities (1 text), 4 joins');
    expect([...role('notes').querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '1 text is left out: its font is not installed (Gill Sans).',
      '1 text is left out: the file places its letters one by one, as a drawing converted from a PDF does.',
    ]);
    await apply();
    // The baseline is 24 down a page of 60: 36 up it.
    expect(emit.mock.calls[0][0].texts).toEqual([{ string: '"LOGO"', chain: ".font('Test Sans').size(6).bold().align('center').at([40, 36])" }]);
  });

  it('counts texts and their baselines towards the most one import writes', async () => {
    const many: Groups = [...OUTLINE];
    for (let i = 0; i < MAX_IMPORT_STATEMENTS / 2; i++) {
      many.push(...text('NOTES', [i, 0], 'T', [50, 90]));
    }
    const { role, choose } = makeTool();
    await choose(dxf(many, [], STYLES));
    expect(role<HTMLButtonElement>('apply').disabled).toBe(false);
    turnOn(role);
    expect(role('summary').textContent).toMatch(/^This would write 2,004 sketch entities; one import takes up to 2,000\./);
  });
});

describe('DrawingImportTool: units and scale', () => {
  it('converts the unit the file declares into the document\'s', async () => {
    const { choose, role, apply, texts } = makeTool();
    await choose(dxf([...line('0', [1, 0], [2, 0]), ...line('0', [2, 0], [2, 1])], [9, '$INSUNITS', 70, 1]));
    expect(role<HTMLSelectElement>('unit').selectedOptions[0].textContent).toBe('Same as file (in)');
    // Out of nothing: 1 in is 25.4 mm, and the drawing stays where the file has it.
    expect(role('readout').textContent).toBe('25.40 × 25.40 mm at 38.10, 12.70');
    await apply();
    expect(texts()).toEqual(['line([25.4, 0], [50.8, 0])', 'line([50.8, 0], [50.8, 25.4])']);
  });

  it('reads a file that declares no unit in the document\'s, until the user names one', async () => {
    sceneUnit.set('in');
    const { choose, role, apply, texts } = makeTool();
    await choose(dxf([...line('0', [0, 0], [25.4, 0])]));
    const select = role<HTMLSelectElement>('unit');
    expect(select.selectedOptions[0].textContent).toBe('Document unit (in)');
    expect(role('readout').textContent).toBe('25.400 × 0.000 in at 12.700, 0.000');
    select.value = 'mm';
    select.dispatchEvent(new Event('change'));
    expect(role('readout').textContent).toBe('1.000 × 0.000 in at 0.500, 0.000');
    await apply();
    expect(texts()).toEqual(['line([0, 0], [1, 0])']);
  });

  it('scales by a typed factor on top of the unit, about the file\'s origin for a drawing left as drawn', async () => {
    const { choose, role, apply, texts } = makeTool();
    await choose(PLATE);
    const scale = role<HTMLInputElement>('scale');
    scale.value = '0.5';
    scale.dispatchEvent(new Event('change'));
    expect(role('readout').textContent).toBe('20.00 × 10.00 mm at 60.00, 30.00');
    await apply();
    expect(texts()[0]).toBe('line([50, 25], [70, 25])');
    expect(texts()[4]).toBe('circle([60, 30], 4)');
  });
});

describe('DrawingImportTool: an SVG', () => {
  const SVG = 'xmlns="http://www.w3.org/2000/svg"';
  const INKSCAPE = 'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"';
  /** A 40 × 20 mm plate with a hole on an 80 × 60 mm page, its notes on a layer switched off. */
  const PLATE_SVG = `<svg ${SVG} ${INKSCAPE} width="80mm" height="60mm" viewBox="0 0 80 60">
    <g inkscape:groupmode="layer" inkscape:label="Outline" fill="none" stroke="#000"><rect x="20" y="10" width="40" height="20"/><circle cx="40" cy="20" r="4"/></g>
    <g inkscape:groupmode="layer" inkscape:label="Notes" style="display:none"><path d="M0 0 L80 60" stroke="#000"/><text x="5" y="5">draft</text></g></svg>`;

  it('opens as its own dialog, taking SVG files', () => {
    const { role, tool } = makeTool({ source: SVG_IMPORT });
    expect(tool.id).toBe('svg');
    expect(tool.label).toBe('Import SVG');
    expect(role('file').getAttribute('accept')).toBe('.svg,image/svg+xml');
    expect(role('choose').textContent).toBe('Choose SVG…');
  });

  it('shows the drawing above the page\'s lower-left corner, in the unit the page gives, with its layers', async () => {
    const { role, choose, layerBox } = makeTool({ source: SVG_IMPORT });
    await choose(PLATE_SVG, 'plate.svg');
    expect(role('file-label').textContent).toBe('plate.svg');
    expect(role<HTMLSelectElement>('unit').selectedOptions[0].textContent).toBe('Same as file (mm)');
    // The page is 60 high: the plate's 10…30 from its top is 30…50 from its bottom.
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm at 40.00, 40.00');
    expect(role('summary').textContent).toBe('5 sketch entities, 4 joins');
    expect(layerBox('Outline').checked).toBe(true);
    // A layer the file hides starts unticked, and says why.
    expect(layerBox('Notes').checked).toBe(false);
    expect(layerBox('Notes').parentElement!.querySelector('span')!.title).toBe('Notes: hidden in the file');
    // The hidden layer's text is read as text: with its layer unticked there is nothing to say about it.
    expect(role('notes').textContent).toBe('');
  });

  it('writes the flattened drawing as sketch statements, Y up', async () => {
    const { choose, apply, texts, emit } = makeTool({ source: SVG_IMPORT });
    await choose(`<svg ${SVG} width="100mm" height="100mm" viewBox="0 0 100 100">
      <g transform="translate(50 50) rotate(90)" fill="none" stroke="#000"><rect x="-20" y="-10" width="40" height="20"/><circle cx="10" r="4"/></g></svg>`, 'turned.svg');
    await apply();
    // A quarter turn on the page: the 40 × 20 rectangle stands upright about (50, 50), its hole below the middle.
    expect(texts()).toEqual([
      'line([60, 70], [60, 30])',
      'line([60, 30], [40, 30])',
      'line([40, 30], [40, 70])',
      'line([40, 70], [60, 70])',
      'circle([50, 40], 8)',
    ]);
    expect(emit.mock.calls[0][0].constraints).toHaveLength(4);
  });

  it('brings in an Inkscape file\'s guides under a toggle of their own name, as guide lines', async () => {
    const { role, choose, apply, texts, emit, tool } = makeTool({ source: SVG_IMPORT });
    await choose(`<svg ${SVG} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
      inkscape:version="1.2.2 (b0a8486541, 2022-12-01)" width="100mm" height="60mm" viewBox="0 0 100 60">
      <sodipodi:namedview id="base"><sodipodi:guide position="20,50" orientation="0,-1" id="g1" /><sodipodi:guide position="20,50" orientation="1,0" id="g2" /></sodipodi:namedview>
      <rect x="20" y="10" width="40" height="20" fill="none" stroke="#000"/></svg>`, 'plate.svg');
    expect(role('guides-row').classList.contains('hidden')).toBe(false);
    expect(role('guides-label').textContent).toBe('Guides');
    expect(role('summary').textContent).toBe('4 sketch entities, 4 joins');
    const toggle = role<HTMLInputElement>('guides');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(tool.preview.guideCount).toBe(2);
    expect(role('summary').textContent).toBe('6 sketch entities (2 guide lines), 4 joins');
    await apply();
    // The plate is 20…60 by 30…50 above the page's lower edge; its top and left edges are on the guides.
    expect(texts().slice(4)).toEqual(['line([16, 50], [64, 50])', 'line([20, 26], [20, 54])']);
    expect(emit.mock.calls[0][0].geometry.slice(4).every((g) => g.guide === true)).toBe(true);
  });

  it('offers the units only a file is in, and reads a page without a size in the document\'s', async () => {
    const { role, choose, apply, texts } = makeTool({ source: SVG_IMPORT });
    await choose(`<svg ${SVG} viewBox="0 0 96 96"><path d="M0 96 L96 96" stroke="#000"/></svg>`, 'icon.svg');
    const select = role<HTMLSelectElement>('unit');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Document unit (mm)', 'Millimeter', 'Centimeter', 'Meter', 'Inch', 'Foot',
      'Pixel, 96 to the inch', 'Point, 72 to the inch', 'Pixel, 90 to the inch',
    ]);
    expect(role('readout').textContent).toBe('96.00 × 0.00 mm at 48.00, 0.00');
    select.value = 'px';
    select.dispatchEvent(new Event('change'));
    expect(role('readout').textContent).toBe('25.40 × 0.00 mm at 12.70, 0.00');
    select.value = 'pt';
    select.dispatchEvent(new Event('change'));
    await apply();
    // 96 points of a 72nd of an inch, written to the document's decimals.
    expect(texts()).toEqual(['line([0, 0], [33.866667, 0])']);
  });

  it('reads pixels at 96 to the inch when the page is sized in them', async () => {
    const { role, choose } = makeTool({ source: SVG_IMPORT });
    await choose(`<svg ${SVG} width="96" height="96"><rect width="96" height="48"/></svg>`, 'box.svg');
    expect(role<HTMLSelectElement>('unit').selectedOptions[0].textContent).toBe('Same as file (px)');
    expect(role('readout').textContent).toBe('25.40 × 12.70 mm at 12.70, 19.05');
  });

  it('notes the béziers it read as arcs, and what the file hides or clips', async () => {
    const k = 10 * 0.5522847498;
    const { role, choose } = makeTool({ source: SVG_IMPORT });
    await choose(`<svg ${SVG} width="50mm" height="50mm" viewBox="0 0 50 50">
      <path d="M30 20 C30 ${20 + k} ${20 + k} 30 20 30 C${20 - k} 30 10 ${20 + k} 10 20 C10 ${20 - k} ${20 - k} 10 20 10 C${20 + k} 10 30 ${20 - k} 30 20 Z"/>
      <path d="M0 0h50v50H0z" fill="none"/></svg>`, 'dot.svg');
    expect(role('summary').textContent).toBe('1 sketch entity');
    expect(role('warnings-title').textContent).toBe('Warnings (2)');
    expect([...role('notes').children].map((item) => item.textContent)).toEqual([
      '1 shape has neither a fill nor a stroke, or is made invisible: it was left out.',
      '4 bezier curves follow a circle and were read as arcs.',
    ]);
  });

  it('says why a file is not an SVG', async () => {
    const { choose, message } = makeTool({ source: SVG_IMPORT });
    await choose(PLATE, 'plate.dxf');
    expect(message().textContent).toMatch(/not an SVG file/);
    await choose('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>', 'broken.svg');
    expect(message().textContent).toMatch(/not well-formed XML/);
  });
});

describe('DrawingImportTool: placing by hand', () => {
  it('drags the drawing: the camera held meanwhile, the statements written where it was dropped', async () => {
    const { choose, press, moveTo, release, cameraControls, role, apply, texts } = makeTool();
    await choose(PLATE);
    press([120, 60]);
    expect(cameraControls.enabled).toBe(false);
    moveTo([20, 10]);
    release([20, 10]);
    expect(cameraControls.enabled).toBe(true);
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm at 20.00, 10.00');
    await apply();
    expect(texts()[0]).toBe('line([0, 0], [40, 0])');
    expect(texts()[4]).toBe('circle([20, 10], 8)');
  });

  it('does not take a press off the drawing, or a click that never moved', async () => {
    const { choose, press, moveTo, release, cameraControls, role } = makeTool();
    await choose(PLATE);
    press([-300, -300]);
    expect(cameraControls.enabled).toBe(true);
    press([120, 60]);
    moveTo([121, 60]);
    release([121, 60]);
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm at 120.00, 60.00');
  });

  it('scales from a corner in proportion, and shows the factor in the dialog', async () => {
    const { choose, drag, role, apply, texts } = makeTool();
    await choose(PLATE);
    // The top-right corner (140, 70) out to twice as far from the bottom-left one (100, 50).
    drag([140, 70], [180, 90]);
    expect(role<HTMLInputElement>('scale').value).toBe('2');
    expect(role('readout').textContent).toBe('80.00 × 40.00 mm at 140.00, 70.00');
    await apply();
    expect(texts()[0]).toBe('line([100, 50], [180, 50])');
    expect(texts()[4]).toBe('circle([140, 70], 16)');
  });

  it('rotates with the knob, Shift snapping to 15°, and writes the turned geometry', async () => {
    const { choose, press, moveTo, release, role, apply, texts, emit } = makeTool();
    await choose(PLATE);
    // The knob sits 28 above the middle of the top edge.
    press([120, 98]);
    moveTo([60, 62], { shiftKey: true });
    release([60, 62]);
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm at 120.00, 60.00 · 90°');
    await apply();
    // A quarter turn about the centre (120, 60): the bottom edge now runs up the right side.
    expect(texts()[0]).toBe('line([130, 40], [130, 80])');
    expect(texts()[4]).toBe('circle([120, 60], 8)');
    expect(emit.mock.calls[0][0].constraints).toHaveLength(4);
  });

  it('puts the drawing back as drawn, or in the middle of the view', async () => {
    const { choose, drag, role } = makeTool();
    await choose(PLATE);
    drag([120, 60], [300, -200]);
    role<HTMLButtonElement>('center').click();
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm at 0.00, 0.00');
    role<HTMLButtonElement>('as-drawn').click();
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm at 120.00, 60.00');
  });

  it('folds a drag on Escape, and clears the scene when it leaves', async () => {
    const { tool, choose, press, moveTo, cameraControls, scene } = makeTool();
    await choose(PLATE);
    expect(tool.handleEscape()).toBe(false);
    press([120, 60]);
    moveTo([200, 60]);
    expect(tool.handleEscape()).toBe(true);
    expect(cameraControls.enabled).toBe(true);
    tool.deactivate();
    expect(scene.children).not.toContain(tool.preview.group);
    expect(scene.children).not.toContain(tool.handles.group);
    expect(document.querySelector('#fluidcad-drawing-import-panel')).toBeNull();
  });
});
