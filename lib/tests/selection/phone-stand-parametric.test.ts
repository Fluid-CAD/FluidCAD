import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { select, fillet, repeat, cut, plane, extrude, xAxis, yAxis, line, sketch, part } from "../../core/index.js";
import { fix, distance, vertical, horizontal, coincident } from "../../core/constraints/index.js";
import { edge } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { edgeRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

// Regression captured from a model authored through the sketch UI. Keep the
// rounded initial guesses: widening the solved sketches changes whether OCCT
// merges the lip's side faces with the cradle/back. Those merged faces can
// expose inherited edges in the lip's bucket, but the back remains their owner.
function phoneStand(width: number, height: number, finishing?: (features: Record<string, SceneObject>) => void, minimal = false) {
  const features: Record<string, SceneObject> = {};
  part('Phone stand', () => {
  const s = sketch('xy', () => {
    const l1 = line([-40, -32], [40, -32]);
    const l2 = line([40, -32], [40, 48]);
    const l3 = line([40, 48], [-40, 48]);
    const l4 = line([-40, 48], [-40, -32]);
    coincident(l1.end(), l2.start());
    coincident(l2.end(), l3.start());
    coincident(l3.end(), l4.start());
    coincident(l4.end(), l1.start());
    horizontal(l1);
    horizontal(l3);
    vertical(l2);
    vertical(l4);
    distance(l1.start(), l1.end(), width);
    distance(l2.start(), l2.end(), 80);
    distance(l1.start(), yAxis(), width / 2);
    distance(l1.start(), xAxis(), 32);

  }).name('Base outline').close();

  const e2 = extrude(6, s).name('Base thickness');
  const s2 = sketch('yz', () => {
    const l5 = line([-12, 6], [-6, 6]);
    const l6 = line([-6, 6], [26.73, 96.11]);
    const l7 = line([26.73, 96.11], [20.73, 96.11]);
    const l8 = line([20.73, 96.11], [-12, 6]);
    horizontal(l5);
    distance(l5.start(), l5.end(), 6);
    fix(l5.start());
    coincident(l6.start(), l5.end());
    coincident(l7.start(), l6.end());
    horizontal(l7);
    distance(l7.start(), l7.end(), 6);
    coincident(l8.start(), l7.end());
    coincident(l8.end(), l5.start());
    distance(l6.start(), l6.end(), height, 'y');
    distance(l6.start(), l6.end(), height * Math.tan(20 * Math.PI / 180), 'x');

  }).close().name('Inclined back profile');
  const back = extrude(width - 10, s2).symmetric().name('Back support');
  const p = plane('xy', 24).name('Cradle plane');
  const s3 = sketch(p, () => {
    const l9 = line([-35, -23], [35, -23]);
    const l10 = line([35, -23], [35, 0]);
    const l11 = line([35, 0], [-35, 0]);
    const l12 = line([-35, 0], [-35, -23]);
    coincident(l9.end(), l10.start());
    coincident(l10.end(), l11.start());
    coincident(l11.end(), l12.start());
    coincident(l12.end(), l9.start());
    horizontal(l9);
    horizontal(l11);
    vertical(l10);
    vertical(l12);
    distance(l9.start(), l9.end(), width - 10);
    distance(l10.start(), l10.end(), 23);
    distance(l9.start(), yAxis(), (width - 10) / 2);
    distance(l9.start(), xAxis(), 23);

  }).close().name('Cradle outline');
  const e = extrude(6, s3).name('Raised cradle');

  const s4 = sketch(e.endFaces(), () => {
    const l13 = line([-35, -23], [35, -23]);
    const l14 = line([35, -23], [35, -18]);
    const l15 = line([35, -18], [-35, -18]);
    const l16 = line([-35, -18], [-35, -23]);
    coincident(l13.end(), l14.start());
    coincident(l14.end(), l15.start());
    coincident(l15.end(), l16.start());
    coincident(l16.end(), l13.start());
    horizontal(l13);
    horizontal(l15);
    vertical(l14);
    vertical(l16);
    distance(l13.start(), l13.end(), width - 10);
    distance(l14.start(), l14.end(), 5);
    distance(l13.start(), yAxis(), (width - 10) / 2);
    distance(l13.start(), xAxis(), 23);

  }).close().name('Retaining lip outline');
  const e3 = extrude(8, s4).name('Retaining lip');
  if (minimal) {
    Object.assign(features, { e2, back, e, e3 });
    Object.values(features).forEach((feature, i) => setLocation(feature, 100 + i));
    finishing?.(features);
    return;
  }
  const p2 = plane('xz', 50).name('Window plane');
  const s5 = sketch(p2, () => {
    const l17 = line([-21, 48], [21, 48]);
    const l18 = line([21, 48], [21, 82]);
    const l19 = line([21, 82], [-21, 82]);
    const l20 = line([-21, 82], [-21, 48]);
    coincident(l17.end(), l18.start());
    coincident(l18.end(), l19.start());
    coincident(l19.end(), l20.start());
    coincident(l20.end(), l17.start());
    horizontal(l17);
    horizontal(l19);
    vertical(l18);
    vertical(l20);
    distance(l17.start(), l17.end(), 42);
    distance(l18.start(), l18.end(), height - 56);
    fix(l17.start());

  }).close().name('Back window');
  const c = cut(s5).name('Back opening');
  const p3 = plane('yz', (width + 32) / 4 - 2).name('Support plane');
  const s6 = sketch(p3, () => {
    const l21 = line([-7, 6], [40, 6]);
    const l22 = line([40, 6], [10, 50]);
    const l23 = line([10, 50], [-7, 6]);
    horizontal(l21);
    distance(l21.start(), l21.end(), 47);
    fix(l21.start());
    coincident(l22.start(), l21.end());
    coincident(l23.start(), l22.end());
    coincident(l23.end(), l21.start());
    distance(l23.start(), l23.end(), height * 0.5, 'y');
    distance(l23.start(), l23.end(), height * 0.5 * Math.tan(20 * Math.PI / 180), 'x');

  }).close().name('Rear support profile');
  const f = extrude(4, s6).name('Right rear support');
  repeat('mirror', 'yz', f).name('Left rear support');
  fillet(5, e2.sideEdges()).name('Rounded base corners');
  fillet(5, c.internalEdges()).name('Rounded back window');

    Object.assign(features, { e2, back, e, e3, c, f });
    Object.values(features).forEach((feature, i) => setLocation(feature, 100 + i));
    finishing?.(features);
  });
  return features;
}

describe("UI-selected phone stand fillet survives parameter edits", () => {
  setupOC();
  it.each([false,true])("keeps the two short top edges after widening the stand (minimal=%s)", (minimal) => {
    const original = phoneStand(80, 90, undefined, minimal);
    const scene = render();
    const picks = edgeRefsWhere(findSolid(scene), m => Math.abs(m.z - 96) < 1e-4 && Math.abs(Math.abs(m.x) - 35) < 1e-4);
    expect(picks).toHaveLength(2);
    const named = new Map(Object.entries(original).map(([name, feature]) => [feature.getSourceLocation()!.line, name]));
    const result = synthesizeApplyFeature(scene, picks, 'fillet', 5, [], { namer: ps => ps.map(p => named.get(p.line) ?? null) });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Pin the producer itself: the rebuilds below only tell the two apart
    // while the widened stand's side faces fail to merge.
    expect(result.preview).toMatch(/back\.(start|end)Edges/);
    expect(result.preview).not.toContain('e3.');
    for (const [width, height] of [[80,90], [90,90], [80,100]]) {
      getSceneManager().startScene();
      let finishing: SceneObject | undefined;
      phoneStand(width, height, fs => {
        finishing = new Function('fillet', 'edge', 'select', ...Object.keys(fs), `return ${result.preview}`)(fillet, edge, select, ...Object.values(fs));
      }, minimal);
      const rebuilt = render();
      const label = `Width=${width}, height=${height}: ${result.preview}`;
      expect.soft(finishing?.getError(), label).toBeNull();
      // A successful fillet must actually replace the two selected sharp
      // back corners, not merely succeed on some unrelated inherited edges.
      const sharpCorners = edgeRefsWhere(findSolid(rebuilt), m =>
        Math.abs(m.z - (height + 6)) < 1e-4 && Math.abs(Math.abs(m.x) - (width - 10) / 2) < 1e-4);
      expect.soft(sharpCorners, label).toHaveLength(0);
    }
  });
});
