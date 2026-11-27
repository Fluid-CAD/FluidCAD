// @screenshot hideGrid
import { sketch, sphere, split, plane, line, project, select } from 'fluidcad/core';
import { rect } from 'fluidcad/shapes';
import { face } from 'fluidcad/filters';

// The dome: a ball of radius 40 cut flat at XY, its top half kept.
const ball = sphere(40);
split('xy', { keep: 'front' }, ball);

// Drawn flat on a plane 60 above XY: a closed rectangle and an open line.
const logo = sketch(plane('xy', 60), () => {
  rect([0, 0], 30, 20).centered();
  line([-25, 28], [25, 28]);
});

// The sketch dropped onto the dome's round face. No .direction(): the
// curves travel along the normal of the plane they lie in, Z here, and each
// lands where that line through its points meets the dome. The sketch hides;
// later statements can still read it.
// highlight-next-line
const mark = project(logo, select(face().sphere()));
