// @screenshot hideGrid
import { sketch, circle, extrude, intersect, plane } from 'fluidcad/core';

sketch("xy", () => {
    circle([0, 0], 40);
});
const body = extrude(60);

// Outside a sketch: the curve where the cylinder's wall meets a plane
// tilted 30° — one closed ellipse.
const ic = intersect(body.sideFaces(), plane("xy", { offset: 30, rotateX: 30 }));
