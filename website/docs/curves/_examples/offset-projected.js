// @screenshot hideGrid noAxes
import { sketch, sphere, split, plane, project, offset, select } from 'fluidcad/core';
import { rect } from 'fluidcad/shapes';
import { face } from 'fluidcad/filters';

// The dome: a ball of radius 40 cut flat at XY, its top half kept.
const ball = sphere(40);
split('xy', { keep: 'front' }, ball);
const dome = select(face().sphere());

// A rectangle drawn above the dome and laid onto it.
const logo = sketch(plane('xy', 60), () => {
  rect([0, 0], 30, 20).centered();
});
const mark = project(logo, dome);

// A curve 3 to each side of the projected one, on the dome. The rectangle
// runs counter-clockwise seen from above: to its left is inside, to its
// right outside. Outside, the corners are rounded by arcs about them;
// inside they stay sharp. The projected curve hides and stays readable.
// highlight-start
const inner = offset(3, mark, { on: dome });
const outer = offset(-3, mark, { on: dome });
// highlight-end
