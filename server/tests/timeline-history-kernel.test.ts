import { compileFunction } from 'node:vm';
import { describe, expect, it } from 'vitest';
import * as core from '../../lib/core/index.js';
import { BreakpointHit } from '../../lib/common/breakpoint-hit.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import { setupOC } from '../../lib/tests/setup.js';
import type { Scene } from '../../lib/rendering/scene.js';
import { TimelineHistory } from '../src/fluidcad-server/timeline-history.ts';
import { TimelineBreakpoint } from '../src/timeline-breakpoint.ts';

const FILE = '/ws/history.part.js';
const names = Object.keys(core);

function evaluate(code: string, previous?: Scene) {
  const manager = getSceneManager();
  let scene = manager.startScene();
  manager.setCurrentFile(FILE);
  let paused = false;
  try {
    // Real script coordinates, without new Function's implicit line offset.
    // The fixture's imports are supplied as arguments. Keep their line and
    // column space intact so source locations match the edited document.
    const script = code.replace(/^import [^\n]+;$/gm, line => ' '.repeat(line.length));
    compileFunction(script, names, { filename: FILE })(...names.map(name => (core as any)[name]));
    scene.materializeLeftoverDefinitions();
  } catch (error) {
    if (!(error instanceof BreakpointHit)) throw error;
    paused = true;
  }
  if (previous) scene = manager.compare(previous, scene);
  manager.renderScene(scene);
  return { scene, paused, rows: scene.getRenderedObjects() };
}

describe('timeline history with kernel source locations', () => {
  setupOC();

  it('retains a computed name inside a lazy part while a later top-level feature stays live', async () => {
    const history = new TimelineHistory();
    const code = `const label = ['Computed', 'lid'].join(' ');
part('Box', () => {
  sketch('xy', () => { circle([0, 0], 10); }).close();
  extrude(10).name(label);
});
sphere(2).name('Outside');`;
    const full = evaluate(code);
    await history.update(FILE, full.rows, full.paused, () => code);
    const pausedCode = code.replace('  extrude', '  breakpoint();\n  extrude');
    const paused = evaluate(pausedCode, full.scene);
    expect(paused.paused).toBe(true);
    const entries = await history.update(FILE, paused.rows, paused.paused, () => pausedCode);
    const pending = entries!.filter(e => e.kind === 'unevaluated');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ row: { name: 'Computed lid', type: 'extrude',
      parentId: paused.rows.find(r => r.type === 'part')!.id,
      sourceLocation: { filePath: FILE, line: 5, column: 3 } } });
    expect(paused.rows.some(r => r.type === 'extrude')).toBe(false);
    expect(paused.rows.find(r => r.name === 'Outside')?.visible).toBe(true);
    const continued = evaluate(code, paused.scene);
    expect(continued.rows.find(r => r.name === 'Computed lid')?.hasError).toBe(false);
    expect(await history.update(FILE, continued.rows, continued.paused, () => code)).toBeUndefined();
  });

  it('drags backward and forward through retained rows, then continues the real build', async () => {
    const history = new TimelineHistory();
    let code = "sphere(1).name('One');\nsphere(2).name('Two');\nsphere(3).name('Three');";
    let run = evaluate(code);
    await history.update(FILE, run.rows, run.paused, () => code);
    for (const name of ['Two', 'Three', 'One']) {
      const entries = history.get(FILE);
      const target = run.rows.find(row => row.name === name)
        ?? entries?.flatMap(entry => entry.kind === 'unevaluated' ? [entry.row] : []).find(row => row.name === name);
      expect(target?.sourceLocation).toBeDefined();
      const edited = await TimelineBreakpoint.apply(code, TimelineBreakpoint.capture(code, target!.sourceLocation!));
      expect(edited.error).toBeUndefined();
      code = edited.newCode;
      run = evaluate(code, run.scene);
      expect(run.paused).toBe(true);
      expect(run.rows.map(row => row.name)).toEqual(name === 'Two' ? ['One'] : name === 'Three' ? ['One', 'Two'] : []);
      await history.update(FILE, run.rows, run.paused, () => code);
    }
    code = (await TimelineBreakpoint.apply(code, TimelineBreakpoint.capture(code, null))).newCode;
    run = evaluate(code, run.scene);
    expect(run.paused).toBe(false);
    expect(run.rows.map(row => row.name)).toEqual(['One', 'Two', 'Three']);
  });
});
