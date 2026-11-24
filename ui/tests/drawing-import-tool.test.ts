// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { DrawingImportTool, DXF_IMPORT, MAX_IMPORT_STATEMENTS } from '../src/interactive/tools/drawing-import-tool';
import type { SolvedEmissionRequest } from '../src/interactive/tools/solved-emission';
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

function makeTool(opts: { emitResult?: { success: boolean; reason?: string }; autoConstraints?: boolean } = {}) {
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
    source: DXF_IMPORT,
    onRequestExit,
    readBytes: async (file) => new TextEncoder().encode(files.get(file) ?? ''),
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
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm, centre at 120.00, 60.00');
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
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm, centre at 0.00, 0.00');
    expect(ctx.fitToBox).not.toHaveBeenCalled();
  });

  it('keeps a drawing made near its file\'s origin as drawn even when the view is elsewhere, and zooms out to it', async () => {
    const { role, choose, ctx } = makeTool();
    // 400 away from the origin and 2000 across: the view (±500) shows only its near end.
    await choose(dxf([...line('0', [400, 600], [2400, 600]), ...line('0', [2400, 600], [2400, 700])]));
    expect(role('readout').textContent).toBe('2000.00 × 100.00 mm, centre at 1400.00, 650.00');
    expect(ctx.fitToBox).toHaveBeenCalledTimes(1);
  });

  it('zooms out to a drawing larger than the view, and leaves the camera alone for one in full view', async () => {
    const small = makeTool();
    await small.choose(PLATE);
    expect(small.ctx.fitToBox).not.toHaveBeenCalled();
    document.body.innerHTML = '';

    const large = makeTool();
    await large.choose(dxf([...line('0', [0, 0], [3000, 0]), ...line('0', [3000, 0], [3000, 900])]));
    expect(large.role('readout').textContent).toBe('3000.00 × 900.00 mm, centre at 1500.00, 450.00');
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
    await choose(dxf([0, 'TEXT', 8, '0', 10, 0, 20, 0, 40, 2, 1, 'hello']));
    expect(message().textContent).toBe('The file has no lines or curves to import (it holds 1 TEXT).');
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
      [...line('CUT', [0, 0], [10, 0]), ...line('NOTES', [0, 5], [10, 5]), 0, 'MTEXT', 8, 'NOTES', 10, 0, 20, 0, 1, 'x'],
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
    expect(role('notes').textContent).toBe('Not curves, left out: 1 MTEXT.');
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
    expect(role('readout').textContent).toBe('8.00 × 8.00 mm, centre at 120.00, 60.00');
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

describe('DrawingImportTool: units and scale', () => {
  it('converts the unit the file declares into the document\'s', async () => {
    const { choose, role, apply, texts } = makeTool();
    await choose(dxf([...line('0', [1, 0], [2, 0]), ...line('0', [2, 0], [2, 1])], [9, '$INSUNITS', 70, 1]));
    expect(role<HTMLSelectElement>('unit').selectedOptions[0].textContent).toBe('Same as file (in)');
    // Out of nothing: 1 in is 25.4 mm, and the drawing stays where the file has it.
    expect(role('readout').textContent).toBe('25.40 × 25.40 mm, centre at 38.10, 12.70');
    await apply();
    expect(texts()).toEqual(['line([25.4, 0], [50.8, 0])', 'line([50.8, 0], [50.8, 25.4])']);
  });

  it('reads a file that declares no unit in the document\'s, until the user names one', async () => {
    sceneUnit.set('in');
    const { choose, role, apply, texts } = makeTool();
    await choose(dxf([...line('0', [0, 0], [25.4, 0])]));
    const select = role<HTMLSelectElement>('unit');
    expect(select.selectedOptions[0].textContent).toBe('Document unit (in)');
    expect(role('readout').textContent).toBe('25.400 × 0.000 in, centre at 12.700, 0.000');
    select.value = 'mm';
    select.dispatchEvent(new Event('change'));
    expect(role('readout').textContent).toBe('1.000 × 0.000 in, centre at 0.500, 0.000');
    await apply();
    expect(texts()).toEqual(['line([0, 0], [1, 0])']);
  });

  it('scales by a typed factor on top of the unit, about the file\'s origin for a drawing left as drawn', async () => {
    const { choose, role, apply, texts } = makeTool();
    await choose(PLATE);
    const scale = role<HTMLInputElement>('scale');
    scale.value = '0.5';
    scale.dispatchEvent(new Event('change'));
    expect(role('readout').textContent).toBe('20.00 × 10.00 mm, centre at 60.00, 30.00');
    await apply();
    expect(texts()[0]).toBe('line([50, 25], [70, 25])');
    expect(texts()[4]).toBe('circle([60, 30], 4)');
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
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm, centre at 20.00, 10.00');
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
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm, centre at 120.00, 60.00');
  });

  it('scales from a corner in proportion, and shows the factor in the dialog', async () => {
    const { choose, drag, role, apply, texts } = makeTool();
    await choose(PLATE);
    // The top-right corner (140, 70) out to twice as far from the bottom-left one (100, 50).
    drag([140, 70], [180, 90]);
    expect(role<HTMLInputElement>('scale').value).toBe('2');
    expect(role('readout').textContent).toBe('80.00 × 40.00 mm, centre at 140.00, 70.00');
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
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm, centre at 120.00, 60.00 · 90°');
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
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm, centre at 0.00, 0.00');
    role<HTMLButtonElement>('as-drawn').click();
    expect(role('readout').textContent).toBe('40.00 × 20.00 mm, centre at 120.00, 60.00');
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
