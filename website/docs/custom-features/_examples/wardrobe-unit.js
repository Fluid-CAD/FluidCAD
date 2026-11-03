// @screenshot skip
// A wardrobe made by code: a carcass, a pair of doors on hinges and a stack
// of drawers on runners, each a part of its own, from one set of values.
// wardrobe.assembly.js turns it into a definition an assembly inserts.
import { Generator } from 'fluidcad/sdk';
import { ShapeFactory } from 'fluidcad/sdk/kernel';

/** The thickness of every board, and the gap between neighbouring fronts. */
const BOARD = 18;
const GAP = 3;

// The values are declared as a feature's are, typed-in only. They are the
// insert's interface, by id: insert(wardrobeAssembly, { width: 1200, drawers: 3 }).
export class WardrobeUnit extends Generator.with({
  width: { type: 'length', default: 1000, min: 500, max: 1400, hint: 'The carcass, outside' },
  height: { type: 'length', default: 2000, min: 900, max: 2600 },
  depth: { type: 'length', default: 600, min: 350, max: 800 },
  drawers: { type: 'integer', display: 'stepper', default: 2, min: 0, max: 4, hint: 'Under the doors' },
  drawerFront: { type: 'length', default: 200, min: 120, max: 400, label: 'Drawer front' },
  doorSwing: { type: 'angle', default: 110, min: 90, max: 170, label: 'Door swing', hint: 'How far a door opens' },
}) {
  static id = 'wardrobe-unit';

  // Phase 1, for every insert and every change in the dialog: plain
  // JavaScript, no geometry. It declares the parts, where they start and
  // the joints between them, in the carcass's coordinates: x across, y from
  // the front edge back, z up.
  // highlight-next-line
  layout(g) {
    const { width, height, depth, drawers, drawerFront, doorSwing } = this.values;
    const doorsFrom = drawers * drawerFront;
    const doorHeight = height - doorsFrom - GAP;
    if (doorHeight < height / 3) {
      // The insert's row fails with this sentence; nothing of the layout is kept.
      throw new Error(`wardrobe: ${drawers} drawers of ${drawerFront} leave no room for the doors`);
    }

    // A connector is a frame: an origin, a Z axis and an X axis. The left
    // door's hinge points down and the right one's up, so both doors open
    // outward by a positive angle.
    const leftHinge = { origin: [0, 0, doorsFrom], z: [0, 0, -1], x: [1, 0, 0] };
    const rightHinge = { origin: [width, 0, doorsFrom], z: [0, 0, 1], x: [1, 0, 0] };
    const runners = {};
    for (let i = 1; i <= drawers; i++) {
      // Each runner points out of the front: a drawer slides along its Z.
      runners[`drawer${i}`] = { origin: [0, 0, (i - 1) * drawerFront], z: [0, -1, 0], x: [1, 0, 0] };
    }

    // highlight-start
    // The carcass: one part, fixed in the wardrobe's frame, so it needs no joint.
    const carcass = g.part('carcass', {
      name: 'Carcass',
      inputs: { width, height, depth },
      connectors: { leftHinge, rightHinge, ...runners },
      appearance: 'plastic',
    }).grounded();
    // highlight-end

    // The doors are mirror images: other inputs, so two templates. Each
    // starts closed (its pose) and turns on a revolute joint about its hinge.
    // .flip() lays the door's frame onto the carcass's as it is, instead of
    // face to face, so 0° is closed.
    const doorInputs = { width: width / 2 - GAP / 2, height: doorHeight };
    const leftDoor = g.part('door', {
      name: 'Left door',
      inputs: { ...doorInputs, side: 'left' },
      connectors: { hinge: { ...leftHinge, origin: [0, 0, 0] } },
      appearance: 'oak',
    }).pose({ position: leftHinge.origin });
    // highlight-next-line
    g.mate('revolute', carcass.connectors.leftHinge, leftDoor.connectors.hinge).flip().limits(0, doorSwing).name('Left door');
    const rightDoor = g.part('door', {
      name: 'Right door',
      inputs: { ...doorInputs, side: 'right' },
      connectors: { hinge: { ...rightHinge, origin: [0, 0, 0] } },
      appearance: 'oak',
    }).pose({ position: rightHinge.origin });
    g.mate('revolute', carcass.connectors.rightHinge, rightDoor.connectors.hinge).flip().limits(0, doorSwing).name('Right door');

    // The drawers have equal inputs, so they share one template, built once.
    const drawerParts = [];
    for (let i = 1; i <= drawers; i++) {
      const drawer = g.part('drawer', {
        name: `Drawer ${i}`,
        inputs: { width, height: drawerFront - GAP, depth: depth - BOARD - 30 },
        connectors: { slide: { origin: [0, 0, 0], z: [0, -1, 0], x: [1, 0, 0] } },
        appearance: 'oak',
      }).pose({ position: runners[`drawer${i}`].origin });
      // highlight-next-line
      g.mate('slider', carcass.connectors[`drawer${i}`], drawer.connectors.slide).flip().limits(0, 0.75 * depth).name(`Drawer ${i}`);
      drawerParts.push(drawer);
    }

    // What the inserting assembly reaches as wardrobe.parts.carcass, …
    return { carcass, doors: { left: leftDoor, right: rightDoor }, drawers: drawerParts };
  }

  // Phase 2, once per part template the engine holds no build of: the
  // shapes of one part, in its own coordinates. Static, so it reads only
  // its type and inputs, and a build is kept for as long as they are equal.
  // highlight-next-line
  static build(type, inputs, ctx) {
    // 'preview' while a control in the dialog is still moving: leave out the
    // small parts. 'full' once it settles.
    const pulls = ctx.detail === 'full';
    if (type === 'carcass') {
      return WardrobeUnit.#carcass(ctx, inputs);
    }
    if (type === 'door') {
      return WardrobeUnit.#door(ctx, inputs, pulls);
    }
    if (type === 'drawer') {
      return WardrobeUnit.#drawer(ctx, inputs, pulls);
    }
    // A throw fails that part's row; the rest of the wardrobe builds.
    throw new Error(`wardrobe: no part of type '${type}'`);
  }

  static #carcass(ctx, { width: w, height: h, depth: d }) {
    const t = BOARD;
    return WardrobeUnit.#boxes(ctx, [
      [[0, 0, 0], [t, d, h]], // left side
      [[w - t, 0, 0], [w, d, h]], // right side
      [[t, 0, 0], [w - t, d, t]], // bottom
      [[t, 0, h - t], [w - t, d, h]], // top
      [[t, d - t, t], [w - t, d, h - t]], // back
    ]);
  }

  // A slab in front of the carcass (y from -BOARD to 0), from its hinge across.
  static #door(ctx, { width: w, height: h, side }, pulls) {
    const t = BOARD;
    const [x0, x1] = side === 'left' ? [0, w] : [-w, 0];
    const boxes = [[[x0, -t, 0], [x1, 0, h]]];
    if (pulls) {
      // A bar pull near the opening edge.
      const at = side === 'left' ? x1 - 50 : x0 + 38;
      boxes.push([[at, -t - 25, h / 2 - 150], [at + 12, -t, h / 2 + 150]]);
    }
    return WardrobeUnit.#boxes(ctx, boxes);
  }

  // A front across the carcass, and an open box behind it between the sides.
  static #drawer(ctx, { width: w, height: h, depth: d }, pulls) {
    const t = BOARD;
    const s = 12;
    const [x0, x1, z0, z1] = [t + 15, w - t - 15, 20, h - 40];
    const boxes = [
      [[0, -t, 0], [w, 0, h]], // front
      [[x0, 0, z0], [x0 + s, d, z1]], // left side
      [[x1 - s, 0, z0], [x1, d, z1]], // right side
      [[x0 + s, 0, z0], [x1 - s, d - s, z0 + s]], // bottom
      [[x0 + s, d - s, z0], [x1 - s, d, z1]], // back
    ];
    if (pulls) {
      boxes.push([[w / 2 - 80, -t - 25, h / 2 - 6], [w / 2 + 80, -t, h / 2 + 6]]);
    }
    return WardrobeUnit.#boxes(ctx, boxes);
  }

  // One solid per [low corner, high corner] pair, built with raw OpenCascade.
  // ctx.occ() frees everything made inside it except what it returns.
  static #boxes(ctx, corners) {
    return ctx.occ(({ oc, track }) => corners.map(([lo, hi]) => ShapeFactory.fromShape(
      track(new oc.BRepPrimAPI_MakeBox(new oc.gp_Pnt(...lo), new oc.gp_Pnt(...hi)).Shape()),
    )));
  }
}
