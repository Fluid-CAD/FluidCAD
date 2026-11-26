import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import { FileExport } from '../../lib/io/file-export.js';
import { FileImport, setAssetProvider } from '../../lib/io/file-import.js';
import load from '../../lib/core/load.js';
import { TestSheets } from '../../lib/tests/helpers/sheets.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import cut from '../../lib/core/cut.js';
import { testRect } from '../../lib/tests/helpers/profiles.js';
import type { Extrude } from '../../lib/features/extrude.js';
import type { Scene } from '../../lib/rendering/scene.js';
import { ShapeExportSelection } from '../src/fluidcad-server/shape-export-selection.ts';

// A drawing export of "every solid" must draw the part as it ends up, not
// the bodies its features consumed on the way: those overlap the result, so
// their edges would be drawn over it, and overlapping solids are what makes
// hidden-line removal slow (27 nested copies of one part took minutes).

/** The entity type names of a DXF's ENTITIES section, in file order. */
function entityTypes(dxf: string): string[] {
  const lines = dxf.split(/\r?\n/);
  const start = lines.findIndex((line, i) => line === 'ENTITIES' && lines[i - 1].trim() === '2');
  const types: string[] = [];
  for (let i = start + 1; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() !== '0') {
      continue;
    }
    if (lines[i + 1] === 'ENDSEC') {
      break;
    }
    types.push(lines[i + 1]);
  }
  return types;
}

/** Every solid any feature of the scene ever added, consumed ones included. */
function everyAddedSolid(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap((obj) => obj.getAddedShapes().filter((shape) => shape.isSolid()).map((shape) => shape.id));
}

describe('a drawing export of every solid', () => {
  setupOC();

  /** A 40 × 30 × 10 plate with one corner notched away: three features, one final solid. */
  function notchedPlate(): Scene {
    sketch('xy', () => {
      testRect(40, 30);
    });
    const plate = extrude(10) as Extrude;
    sketch(plate.endFaces(), () => {
      testRect(10, 10, { at: [30, 20] });
    });
    cut(10);
    return render();
  }

  it('selects the final solid only, though the features built more on the way', () => {
    const scene = notchedPlate();
    const added = everyAddedSolid(scene);
    expect(added.length).toBeGreaterThan(1);

    const resolved = ShapeExportSelection.resolve(scene, ShapeExportSelection.ALL);
    expect('shapeIds' in resolved).toBe(true);
    const { shapeIds } = resolved as { shapeIds: string[] };
    expect(shapeIds).toHaveLength(1);
    expect(added).toContain(shapeIds[0]);
  });

  it('draws the part as it ends up: the notch, and nothing of the plate before it', () => {
    const scene = notchedPlate();
    const manager = getSceneManager();
    const { shapeIds } = ShapeExportSelection.resolve(scene, ShapeExportSelection.ALL) as { shapeIds: string[] };

    const final = manager.exportShapes(scene, shapeIds, { format: 'dxf', plane: 'top' });
    expect(final.fileName).toBe('export-top.dxf');
    // The L outline: six lines, one closed loop.
    expect(entityTypes(final.data as string)).toEqual(Array(6).fill('LINE'));

    // The same drawing as SVG: that one loop as one closed path of six sides.
    const svg = manager.exportShapes(scene, shapeIds, { format: 'svg', plane: 'top' });
    expect(svg.fileName).toBe('export-top.svg');
    const paths = [...(svg.data as string).matchAll(/<path d="([^"]+)"\/>/g)].map((m) => m[1]);
    expect(paths).toHaveLength(1);
    expect(paths[0].replace(/[-0-9. ]/g, '')).toBe('MLLLLLZ');

    // What the selection keeps out: with the consumed plate drawn too, its
    // full rectangle closes the notch again — a different drawing.
    const withConsumed = manager.exportShapes(scene, everyAddedSolid(scene), { format: 'dxf', plane: 'top' });
    expect(withConsumed.data).not.toBe(final.data);
  });
});

describe('a shapes export of a scene holding a surface', () => {
  setupOC();

  let workspace: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-surface-export-'));
    setAssetProvider((rel) => {
      const file = path.join(workspace, rel);
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    });
  });

  afterAll(() => {
    setAssetProvider(null);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('imports a surface-only file, takes the surface into "all", and writes it to STEP beside the solid', () => {
    const hull = TestSheets.openBox(10, 10, 10);
    const step = FileExport.exportShapes([{ body: hull, colors: [] }], { format: 'step' }).data as string;
    hull.dispose();

    const manager = getSceneManager();
    const report = manager.importFile(workspace, 'hull.step', new TextEncoder().encode(step));
    expect(report.solidCount).toBe(0);
    expect(report.contents).toEqual({ solids: 0, surfaces: 1, curves: 0 });

    sketch('xy', () => {
      testRect(5, 5, { at: [50, 0] });
    });
    extrude(5);
    load('hull');
    const scene = render();

    const resolved = ShapeExportSelection.resolve(scene, ShapeExportSelection.ALL);
    expect('shapeIds' in resolved).toBe(true);
    const { shapeIds } = resolved as { shapeIds: string[] };
    expect(shapeIds).toHaveLength(2);

    const written = manager.exportShapes(scene, shapeIds, { format: 'step' });
    expect(written.warnings).toBeUndefined();
    const back = FileImport.importFile(workspace, 'back.step', new TextEncoder().encode(written.data as string));
    expect(back.contents).toEqual({ solids: 1, surfaces: 1, curves: 0 });

    // The mesh takes the solid and names the surface it left out.
    const mesh = manager.exportShapes(scene, shapeIds, { format: 'stl' });
    expect(mesh.warnings).toEqual(['1 surface left out: a surface encloses no volume.']);
  });
});
