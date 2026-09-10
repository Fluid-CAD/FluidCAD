import {
    axis, circle, cut, extrude, line, loft, offset, origin,
    plane, project, repeat, revolve, shell, sketch, sphere, translate
} from 'fluidcad/core';
import { coincident, diameter, equal, horizontal } from 'fluidcad/constraints';

// Middle body
const p = plane('xy', 24);
sketch(p, () => {
  const l1 = line([50, 0], [25, 43.3]);
  const l2 = line([25, 43.3], [-25, 43.3]);
  const l3 = line([-25, 43.3], [-50, 0]);
  const l4 = line([-50, 0], [-25, -43.3]);
  const l5 = line([-25, -43.3], [25, -43.3]);
  const l6 = line([25, -43.3], [50, 0]);
  const c1 = circle([0, 0], 100).guide();
  coincident(l1.end(), l2.start());
  coincident(l2.end(), l3.start());
  coincident(l3.end(), l4.start());
  coincident(l4.end(), l5.start());
  coincident(l5.end(), l6.start());
  coincident(l6.end(), l1.start());
  equal(l1, l2, l3, l4, l5, l6);
  coincident(l1.start(), c1);
  coincident(l2.start(), c1);
  coincident(l3.start(), c1);
  coincident(l4.start(), c1);
  coincident(l5.start(), c1);
  coincident(l6.start(), c1);
  diameter(c1, 100);
  coincident(c1.center(), origin());
  horizontal(l2);
});
const e = extrude(150).draft(8).new();
shell(-7, e.endFaces(), e.startFaces());

// Cut windows
sketch(e.sideFaces(1), () => {
  const pj = project(e.sideFaces(1)).guide();
  offset(-6, pj);
});
const f = cut(7);
repeat('circular', 'z', { count: 6, angle: 360 }, f);

// Base
sketch('xy', () => {
  const l7 = line([75, 0], [37.5, 64.95]);
  const l8 = line([37.5, 64.95], [-37.5, 64.95]);
  const l9 = line([-37.5, 64.95], [-75, 0]);
  const l10 = line([-75, 0], [-37.5, -64.95]);
  const l11 = line([-37.5, -64.95], [37.5, -64.95]);
  const l12 = line([37.5, -64.95], [75, 0]);
  const c2 = circle([0, 0], 150).guide();
  coincident(l7.end(), l8.start());
  coincident(l8.end(), l9.start());
  coincident(l9.end(), l10.start());
  coincident(l10.end(), l11.start());
  coincident(l11.end(), l12.start());
  coincident(l12.end(), l7.start());
  equal(l7, l8, l9, l10, l11, l12);
  coincident(l7.start(), c2);
  coincident(l8.start(), c2);
  coincident(l9.start(), c2);
  coincident(l10.start(), c2);
  coincident(l11.start(), c2);
  coincident(l12.start(), c2);
  diameter(c2, 150);
  coincident(c2.center(), origin());
  horizontal(l8);
});
const e2 = extrude(12);
sketch(e2.endFaces(), () => {
  const l13 = line([57.5, 0], [28.75, 49.8]);
  const l14 = line([28.75, 49.8], [-28.75, 49.8]);
  const l15 = line([-28.75, 49.8], [-57.5, 0]);
  const l16 = line([-57.5, 0], [-28.75, -49.8]);
  const l17 = line([-28.75, -49.8], [28.75, -49.8]);
  const l18 = line([28.75, -49.8], [57.5, 0]);
  const c3 = circle([0, 0], 115).guide();
  coincident(l13.end(), l14.start());
  coincident(l14.end(), l15.start());
  coincident(l15.end(), l16.start());
  coincident(l16.end(), l17.start());
  coincident(l17.end(), l18.start());
  coincident(l18.end(), l13.start());
  equal(l13, l14, l15, l16, l17, l18);
  coincident(l13.start(), c3);
  coincident(l14.start(), c3);
  coincident(l15.start(), c3);
  coincident(l16.start(), c3);
  coincident(l17.start(), c3);
  coincident(l18.start(), c3);
  diameter(c3, 115);
  coincident(c3.center(), origin());
  horizontal(l14);
});
extrude(12);

// Top
const p2 = plane('xy', 174);
sketch(p2, () => {
  const l19 = line([82.5, 0], [41.25, 71.45]);
  const l20 = line([41.25, 71.45], [-41.25, 71.45]);
  const l21 = line([-41.25, 71.45], [-82.5, 0]);
  const l22 = line([-82.5, 0], [-41.25, -71.45]);
  const l23 = line([-41.25, -71.45], [41.25, -71.45]);
  const l24 = line([41.25, -71.45], [82.5, 0]);
  const c4 = circle([0, 0], 165).guide();
  coincident(l19.end(), l20.start());
  coincident(l20.end(), l21.start());
  coincident(l21.end(), l22.start());
  coincident(l22.end(), l23.start());
  coincident(l23.end(), l24.start());
  coincident(l24.end(), l19.start());
  equal(l19, l20, l21, l22, l23, l24);
  coincident(l19.start(), c4);
  coincident(l20.start(), c4);
  coincident(l21.start(), c4);
  coincident(l22.start(), c4);
  coincident(l23.start(), c4);
  coincident(l24.start(), c4);
  diameter(c4, 165);
  coincident(c4.center(), origin());
  horizontal(l20);
});
const e3 = extrude(12);
const p3 = plane('xy', 238);
sketch(p3, () => {
  const l25 = line([25, 0], [12.5, 21.65]);
  const l26 = line([12.5, 21.65], [-12.5, 21.65]);
  const l27 = line([-12.5, 21.65], [-25, 0]);
  const l28 = line([-25, 0], [-12.5, -21.65]);
  const l29 = line([-12.5, -21.65], [12.5, -21.65]);
  const l30 = line([12.5, -21.65], [25, 0]);
  const c5 = circle([0, 0], 50).guide();
  coincident(l25.end(), l26.start());
  coincident(l26.end(), l27.start());
  coincident(l27.end(), l28.start());
  coincident(l28.end(), l29.start());
  coincident(l29.end(), l30.start());
  coincident(l30.end(), l25.start());
  equal(l25, l26, l27, l28, l29, l30);
  coincident(l25.start(), c5);
  coincident(l26.start(), c5);
  coincident(l27.start(), c5);
  coincident(l28.start(), c5);
  coincident(l29.start(), c5);
  coincident(l30.start(), c5);
  diameter(c5, 50);
  coincident(c5.center(), origin());
  horizontal(l26);
});
const e4 = extrude(12);
loft(e3.endFaces(), e4.startFaces());

// Finial and ring — typed by hand: spheres, translate and axes have no tool yet
let s = sphere(25 / 2);
translate([0, 0, 257], s);

const ringAxis = axis('y', { offsetZ: 290 });

sketch('yz', () => {
  circle([0, 290 + (65 / 2) - (7 / 2)], 7);
});
