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
