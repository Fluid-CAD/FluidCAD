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
  line, select, sketch,
} from "fluidcad/core";
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
      'Two straight sides and semicircular ends form the arm profile, with the pivot centers 76 mm apart.',
    body: `sketch("xy", () => {
  line([0, -ARM_RADIUS], [SPAN, -ARM_RADIUS]);
  arc([SPAN, -ARM_RADIUS], [SPAN, ARM_RADIUS], [SPAN, 0]);
  line([SPAN, ARM_RADIUS], [0, ARM_RADIUS]);
  arc([0, ARM_RADIUS], [0, -ARM_RADIUS], [0, 0]);
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
    detail: 'Draw a 32 mm circle on the arm’s top face for the raised pivot hub.',
    body: `sketch(arm.endFaces(), () => {
  circle([0, 0], HUB_DIAMETER);
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
    detail: 'Sketch a 20 mm pivot hole and an 11 mm hole at the other end. Nothing is cut yet.',
    body: `sketch(boss.endFaces(), () => {
  circle([0, 0], PIVOT_DIAMETER);
  circle([SPAN, 0], TIP_HOLE_DIAMETER);
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
