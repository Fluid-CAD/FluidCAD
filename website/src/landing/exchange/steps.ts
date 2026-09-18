/** One selectable step per sketch or solid feature, in build order. */
export type FeatureStep = {
  id: string
  label: string
  feature: 'sketch' | 'extrude' | 'cut' | 'fillet'
  summary: string
  detail: string
  body: string
}

const PREAMBLE = `import {
  arc, circle, cut, extrude, fillet,
  line, origin, select, sketch,
} from "fluidcad/core";
import {
  coincident, diameter, distance,
  horizontal, radius, tangent,
} from "fluidcad/constraints";
import { edge } from "fluidcad/filters";
const SPAN = 76;
const ARM_RADIUS = 24;
const ARM_THICKNESS = 12;
const HUB_DIAMETER = 32;
const HUB_HEIGHT = 14;
const PIVOT_DIAMETER = 20;
const TIP_HOLE_DIAMETER = 11;
const FILLET_RADIUS = 4;
`

export const STEPS: FeatureStep[] = [
  {
    id: 'profile',
    label: 'Sketch 1',
    feature: 'sketch',
    summary: 'Arm profile',
    detail:
      'Fully constrain the arm profile with tangent semicircular ends, a 24 mm radius and pivot centers 76 mm apart.',
    body: `sketch("xy", () => {
  const bottom = line([0, -ARM_RADIUS], [SPAN, -ARM_RADIUS]);
  const tip = arc([SPAN, -ARM_RADIUS], [SPAN, ARM_RADIUS], [SPAN, 0]);
  const top = line([SPAN, ARM_RADIUS], [0, ARM_RADIUS]);
  const pivot = arc([0, ARM_RADIUS], [0, -ARM_RADIUS], [0, 0]);
  coincident(bottom.end(), tip.start());
  coincident(tip.end(), top.start());
  coincident(top.end(), pivot.start());
  coincident(pivot.end(), bottom.start());
  tangent(bottom, tip);
  tangent(tip, top);
  tangent(top, pivot);
  tangent(pivot, bottom);
  horizontal(bottom);
  horizontal(top);
  coincident(pivot.center(), origin());
  radius(pivot, ARM_RADIUS);
  distance(pivot.center(), tip.center(), SPAN, "x");
});`
  },
  {
    id: 'arm',
    label: 'Extrude 1',
    feature: 'extrude',
    summary: '12 mm arm',
    detail: 'Extrude the closed profile 12 mm to form the body of the arm.',
    body: 'const arm = extrude(ARM_THICKNESS);'
  },
  {
    id: 'hub-sketch',
    label: 'Sketch 2',
    feature: 'sketch',
    summary: 'Hub profile',
    detail: 'Fully constrain the hub circle at the sketch origin with a 32 mm diameter on the arm’s top face.',
    body: `sketch(arm.endFaces(), () => {
  const hub = circle([0, 0], HUB_DIAMETER);
  coincident(hub.center(), origin());
  diameter(hub, HUB_DIAMETER);
});`
  },
  {
    id: 'hub',
    label: 'Extrude 2',
    feature: 'extrude',
    summary: '14 mm hub',
    detail: 'Raise the hub 14 mm above the arm. The extrusion joins the existing body.',
    body: 'const boss = extrude(HUB_HEIGHT);'
  },
  {
    id: 'holes-sketch',
    label: 'Sketch 3',
    feature: 'sketch',
    summary: 'Pivot holes',
    detail: 'Fully constrain the 20 mm and 11 mm hole profiles with aligned centers 76 mm apart. Nothing is cut yet.',
    body: `sketch(boss.endFaces(), () => {
  const pivot = circle([0, 0], PIVOT_DIAMETER);
  const tip = circle([SPAN, 0], TIP_HOLE_DIAMETER);
  coincident(pivot.center(), origin());
  diameter(pivot, PIVOT_DIAMETER);
  horizontal(pivot.center(), tip.center());
  distance(pivot.center(), tip.center(), SPAN, "x");
  diameter(tip, TIP_HOLE_DIAMETER);
});`
  },
  {
    id: 'holes',
    label: 'Cut',
    feature: 'cut',
    summary: 'Through both ends',
    detail: 'Cut both circular profiles through the arm and hub.',
    body: 'cut();'
  },
  {
    id: 'blend',
    label: 'Fillet',
    feature: 'fillet',
    summary: '4 mm edge blend',
    detail: 'Round the hub’s circular edges with a 4 mm fillet to finish the rocker arm.',
    body: `select(edge().circle(HUB_DIAMETER));
fillet(FILLET_RADIUS);`
  }
]

export function fileAt(index: number): { code: string; from: number; to: number } {
  const before =
    PREAMBLE +
    '\n' +
    STEPS.slice(0, index)
      .map((step) => step.body + '\n\n')
      .join('')
  const code = before + STEPS[index].body
  return {
    code,
    from: before.split('\n').length,
    to: code.split('\n').length
  }
}
