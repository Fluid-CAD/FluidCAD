/**
 * The build the exchange section replays.
 *
 * One part, six beats. The first five are the mouse's: a gesture in the
 * viewport, and the statement it left in the file. The sixth goes the other
 * way — a number typed into the file, and the geometry that follows it. That
 * round trip is the whole claim of the page, so it is made with one part
 * rather than two half-demonstrations.
 *
 * `body` is what the beat adds to the file, verbatim. The pane concatenates
 * them, so the code on screen is a real file at a real point in its life, not
 * an excerpt arranged to fit. Renders in `static/img/landing/exchange-N.png`
 * were captured from that same file at that same beat — see
 * `../models/README.md` for the recipe.
 */

export type Beat = {
  id: string;
  /** What the hand did. Past tense: this already happened, the file records it. */
  gesture: string;
  /** The tool the gesture used, named the way the toolbar names it. */
  tool: string;
  /** Lines this beat added, or the whole file when it rewrote one. */
  body: string;
  /** Set on a beat that edits earlier lines instead of appending to them. */
  rewrites?: boolean;
  image: string;
  alt: string;
};

const PREAMBLE = `import {
    circle, cut, extrude, fillet,
    move, select, sketch, tArc, tLine,
} from "fluidcad/core";
import { edge } from "fluidcad/filters";
import { enclosing, outside } from "fluidcad/constraints";
`;

const profile = (span: number) => `
const SPAN = ${span};

sketch("xy", () => {
    const hub = circle(38).guide();
    const eye = circle([SPAN, 0], 20).guide();

    const t1 = tLine(outside(hub), outside(eye));
    const t2 = tLine(enclosing(hub), enclosing(eye));
    tArc(t1.end(), t2.end(), t1.tangent());
    move(t1.start());
    tArc(t2.start(), t1.start(), t1.tangent().reverse());
});
`;

const ARM = `
const arm = extrude(12);
`;

const HUB = `
sketch(arm.endFaces(), () => {
    circle([0, 0], 32);
});

const boss = extrude(14);
`;

const BORES = `
sketch(boss.endFaces(), () => {
    circle([0, 0], 20);
    circle([SPAN, 0], 11);
});

cut();
`;

const BLEND = `
select(edge().circle(32));

fillet(4);
`;

export const BEATS: Beat[] = [
  {
    id: 'profile',
    tool: 'Sketch',
    gesture: 'Dropped two circles as construction, then asked for the lines and arcs tangent to both.',
    body: PREAMBLE + profile(76),
    image: '/img/landing/exchange-1.png',
    alt: 'A sketch of two dash-dot construction circles with solved tangent lines and arcs closing a rocker-arm profile between them.',
  },
  {
    id: 'arm',
    tool: 'Extrude',
    gesture: 'Grabbed the region inside the profile and pulled it up 12 mm.',
    body: ARM,
    image: '/img/landing/exchange-2.png',
    alt: 'The profile extruded into a flat rocker arm.',
  },
  {
    id: 'hub',
    tool: 'Boss',
    gesture: 'Sketched a circle on the top face and pulled that up too.',
    body: HUB,
    image: '/img/landing/exchange-3.png',
    alt: 'A cylindrical hub standing on the wide end of the arm.',
  },
  {
    id: 'bores',
    tool: 'Bore',
    gesture: 'Two circles on the hub face, cut through everything under them.',
    body: BORES,
    image: '/img/landing/exchange-4.png',
    alt: 'The hub and the small end bored through.',
  },
  {
    id: 'blend',
    tool: 'Fillet',
    gesture: 'Clicked the hub where it meets the arm. 4 mm.',
    body: BLEND,
    image: '/img/landing/exchange-5.png',
    alt: 'The hub blended into the arm with a fillet, and its top rim rounded.',
  },
  {
    id: 'span',
    tool: 'Edit',
    gesture: 'Typed 104 over the 76. The tangents re-solve, the bore stays on centre.',
    body: PREAMBLE + profile(104) + ARM + HUB + BORES + BLEND,
    rewrites: true,
    image: '/img/landing/exchange-6.png',
    alt: 'The same arm, reaching further, with the tangency between the two ends preserved.',
  },
];

/** The file as it stands at `index`, and the lines that beat is responsible for. */
export function fileAt(index: number): {code: string; from: number; to: number} {
  const beat = BEATS[index];
  if (beat.rewrites) {
    const code = beat.body.trimEnd();
    // The rewrite touches one line — the constant the rest of the file reads.
    const line = code.split('\n').findIndex((text) => text.startsWith('const SPAN')) + 1;
    return {code, from: line, to: line};
  }
  const before = BEATS.slice(0, index)
    .map((b) => b.body)
    .join('');
  const code = (before + beat.body).trimEnd();
  // Every body but the first ends in a newline, so its own last line is empty
  // and must not be counted; the first beat opens the file at line 1.
  const from = before === '' ? 1 : before.replace(/\n$/, '').split('\n').length + 1;
  return {code, from, to: code.split('\n').length};
}
