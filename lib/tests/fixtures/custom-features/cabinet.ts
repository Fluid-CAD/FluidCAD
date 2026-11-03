// The cabinet fixture: a generator (Generator.with / defineAssembly) that
// makes a cabinet as a sub-assembly — a carcass (one part, grounded), two
// doors on revolute joints limited to the hinge's swing and coupled so they
// open together, and up to four drawers on slider joints limited to their
// travel. Each part is a plain box built with raw OpenCascade inside
// ctx.occ(). The two doors are one template (equal inputs and connectors);
// so are the drawers. Written against the SDK entry points only.

import { Generator, type GeneratorBuildContext, type GeneratorWith } from "../../../sdk/index.js";
import { ShapeFactory, type Shape } from "../../../sdk/kernel.js";

export const CABINET_DEFAULTS = {
  width: 600, height: 720, depth: 560, drawers: 2, drawerHeight: 150, hingeAngle: 110, finish: 'oak',
} as const;

/** The board thickness the doors are and the carcass's front stands proud by. */
export const BOARD = 18;

/** The cabinet's values, as `Generator.with()` declares them. */
export const CABINET_PARAMS = {
  width: { type: 'length', default: CABINET_DEFAULTS.width, min: 10, description: 'The cabinet across' },
  height: { type: 'length', default: CABINET_DEFAULTS.height, min: 10 },
  depth: { type: 'length', default: CABINET_DEFAULTS.depth, min: 10 },
  drawers: { type: 'integer', default: CABINET_DEFAULTS.drawers, min: 0, max: 4, description: 'How many drawers under the doors' },
  drawerHeight: { type: 'length', default: CABINET_DEFAULTS.drawerHeight, min: 1, label: 'Drawer height' },
  hingeAngle: { type: 'angle', default: CABINET_DEFAULTS.hingeAngle, min: 90, max: 175, label: 'Door swing' },
  finish: {
    type: 'select', default: CABINET_DEFAULTS.finish, label: 'Finish',
    options: [{ label: 'Oak', value: 'oak' }, { label: 'Walnut', value: 'walnut' }],
  },
} as const;

/** How far a drawer travels out of a cabinet `depth` deep. */
export function drawerTravel(depth: number): number {
  return depth * 0.8;
}

/** The cabinet class: what `defineAssembly()` takes. */
export type CabinetClass = GeneratorWith<typeof CABINET_PARAMS> & {
  readonly id: string;
  build(type: string, inputs: any, ctx: GeneratorBuildContext): Shape[];
};

/** The variants a test can ask for. */
export type CabinetVariant = {
  /** Every build of this part type throws. */
  failBuild?: string;
};

/**
 * The cabinet class, made anew on every call — a workspace module is
 * evaluated again on every render — with the count of its builds by part
 * type, and each build's part type and detail tier in build order
 * (`'door:preview'`).
 */
export function defineCabinet(variant: CabinetVariant = {}): { Cabinet: CabinetClass; builds: Map<string, number>; details: string[] } {
  const builds = new Map<string, number>();
  const details: string[] = [];

  class Cabinet extends Generator.with(CABINET_PARAMS) {
    static id = 'acme.cabinet';

    layout(g: Parameters<Generator['layout']>[0]) {
      const { width, height, depth, drawers, drawerHeight, hingeAngle, finish } = this.values;
      const drawersTop = drawers * drawerHeight;
      const doorHeight = height - drawersTop;
      if (doorHeight < height / 3) {
        throw new Error(`${drawers} drawers of ${drawerHeight} leave no room for the doors of a cabinet ${height} high`);
      }

      const runners: Record<string, { origin: [number, number, number]; z: [number, number, number] }> = {};
      for (let i = 0; i < drawers; i++) {
        runners[`runner${i}`] = { origin: [BOARD, 0, i * drawerHeight], z: [0, -1, 0] };
      }
      const carcass = g.part('carcass', {
        name: 'Carcass',
        inputs: { width, height, depth },
        connectors: {
          leftHinge: { origin: [0, -BOARD, drawersTop], z: [0, 0, 1], x: [1, 0, 0] },
          rightHinge: { origin: [width, -BOARD, drawersTop], z: [0, 0, 1], x: [1, 0, 0] },
          base: { origin: [width / 2, depth / 2, 0], z: [0, 0, -1] },
          ...runners,
        },
        appearance: finish,
        material: 'plywood',
      }).grounded();

      // Both doors are one template: equal inputs, equal connectors.
      const door = { inputs: { width: width / 2, height: doorHeight }, connectors: { hinge: { origin: [0, 0, 0], z: [0, 0, 1] } }, appearance: finish } as const;
      const left = g.part('door', { name: 'Left door', ...door }).pose({ position: [0, -BOARD, drawersTop] });
      const right = g.part('door', { name: 'Right door', ...door }).pose({ position: [width, -BOARD, drawersTop], rotation: [0, 0, 180] });
      const leftSwing = g.mate('revolute', carcass.connectors.leftHinge, left.connectors.hinge).limits(0, hingeAngle).name('Left door');
      const rightSwing = g.mate('revolute', carcass.connectors.rightHinge, right.connectors.hinge).limits(-hingeAngle, 0).name('Right door');
      g.relation('gear', leftSwing, rightSwing, 1).reverse().name('Doors together');

      const drawerParts = [];
      for (let i = 0; i < drawers; i++) {
        const drawer = g.part('drawer', {
          name: `Drawer ${i + 1}`,
          inputs: { width: width - 2 * BOARD, height: drawerHeight - 4, depth: depth - BOARD },
          connectors: { runner: { origin: [0, 0, 0], z: [0, -1, 0] } },
        }).pose({ position: [BOARD, 0, i * drawerHeight] });
        g.mate('slider', carcass.connectors[`runner${i}`], drawer.connectors.runner).limits(0, drawerTravel(depth)).name(`Drawer ${i + 1}`);
        drawerParts.push(drawer);
      }
      return { carcass, doors: { left, right }, drawers: drawerParts };
    }

    static build(type: string, inputs: any, ctx: GeneratorBuildContext): Shape[] {
      builds.set(type, (builds.get(type) ?? 0) + 1);
      details.push(`${type}:${ctx.detail}`);
      if (variant.failBuild === type) {
        throw new Error(`no ${type} today`);
      }
      if (type === 'carcass') {
        return [Cabinet.box(ctx, inputs.width, inputs.depth, inputs.height)];
      }
      if (type === 'door') {
        return [Cabinet.box(ctx, inputs.width, BOARD, inputs.height)];
      }
      if (type === 'drawer') {
        return [Cabinet.box(ctx, inputs.width, inputs.depth, inputs.height)];
      }
      throw new Error(`unknown part type '${type}'`);
    }

    /** A `dx`×`dy`×`dz` box from the part's origin. */
    private static box(ctx: GeneratorBuildContext, dx: number, dy: number, dz: number): Shape {
      return ctx.occ(({ oc, track }) => ShapeFactory.fromShape(track(new oc.BRepPrimAPI_MakeBox(dx, dy, dz).Shape())));
    }
  }

  return { Cabinet, builds, details };
}
