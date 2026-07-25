// End-to-end by-region trim: build a sketch with an interactive trim, take a
// region's boundary segment ids off the emitted meta faces, synthesize the
// edge-filter args (lib), run the tree-sitter set-trim-targets transform on
// the matching source text (server), then EXECUTE the edited code against the
// real runtime and assert the region's boundary was trimmed. The whole
// pipeline minus HTTP/IPC plumbing.

import { describe, it, expect } from 'vitest';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import trim from '../../lib/core/trim.js';
import * as core from '../../lib/core/index.js';
import * as filters from '../../lib/filters/index.js';
import * as math from '../../lib/math/index.js';
import { rect, circle, move } from '../../lib/core/2d/index.js';
import { Scene } from '../../lib/rendering/scene.js';
import { SceneObject } from '../../lib/common/scene-object.js';
import { Face } from '../../lib/common/face.js';
import { Sketch } from '../../lib/features/2d/sketch.js';
import { Trim2D } from '../../lib/features/trim2d.js';
import { synthesizeTrimRegionTargets } from '../../lib/selection/trim-region.js';
import { setTrimTargets } from '../src/code-editor.ts';

const IMPORT_LINE_RE = /^\s*import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm;

/** Execute a .fluid.js source string against the real runtime (fresh scene). */
function runFluid(source: string): Scene {
  getSceneManager()!.startScene();
  const globals: Record<string, unknown> = { ...core, ...filters, ...math };
  const names = Object.keys(globals);
  const values = names.map(n => globals[n]);
  const fn = new Function(...names, `"use strict";\n${source.replace(IMPORT_LINE_RE, '')}`);
  fn(...values);
  return render();
}

describe('by-region trim end to end', () => {
  setupOC();

  it('trims a clicked region through synthesized filter targets', async () => {
    const code = [
      `import { sketch, rect, circle, move, trim } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  rect(80, 60)`,
      `  move([40, 30])`,
      `  circle(20)`,
      `  trim().pick()`,
      `})`,
      ``,
    ].join('\n');

    // Build the same model in-process and stamp the trim with the line it
    // occupies in `code`, as the live-render stack capture would.
    sketch('xy', () => {
      rect(80, 60);
      move([40, 30]);
      circle(20);
      trim().pick();
    });
    const scene = render();

    const trimObj = scene.getAllSceneObjects().find(o => o instanceof Trim2D) as Trim2D;
    expect(trimObj).toBeDefined();
    (trimObj as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 7, column: 2 });

    // "Click" the circle's interior cell: its boundary is the circle alone.
    const circleRegion = trimObj.getAddedShapes().find((s): s is Face =>
      s instanceof Face && s.isMetaShape() && s.metaType === 'trim-region'
      && (s.metaData?.edgeIds as string[]).length === 1);
    expect(circleRegion).toBeDefined();

    const synthesis = synthesizeTrimRegionTargets(
      scene, { line: 7 }, circleRegion!.metaData!.edgeIds as string[],
    );
    expect(synthesis.ok).toBe(true);
    if (!synthesis.ok) {
      return;
    }
    expect(synthesis.args).toBe('edge().circle()');

    const edited = await setTrimTargets(code, 7, synthesis.args);
    expect(edited.newCode).toContain('trim(edge().circle()).pick()');
    expect(edited.newCode).toContain(`import { edge } from 'fluidcad/filters';`);

    // The edited code executes and the circle's boundary is gone.
    const rebuilt = runFluid(edited.newCode);
    const rebuiltSketch = rebuilt.getAllSceneObjects().find(o => o instanceof Sketch) as Sketch;
    expect(rebuiltSketch).toBeDefined();
    expect(rebuiltSketch.getEdgesWithOwner().size).toBe(4);
  });
});
