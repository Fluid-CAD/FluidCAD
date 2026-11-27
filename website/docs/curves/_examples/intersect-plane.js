// @screenshot hideGrid
import { sketch, circle, extrude, intersect, plane } from 'fluidcad/core';

sketch('xy', () => {
  circle([0, 0], 40);
});
const body = extrude(60);

// A plane() as the second argument is taken as infinite: the cut runs all
// the way round the wall, whatever size the plane's quad is drawn at. A
// plane can only be the second argument, on its own.
// highlight-next-line
const ic = intersect(body.sideFaces(), plane('xy', { offset: 30, rotateX: 30 }));
