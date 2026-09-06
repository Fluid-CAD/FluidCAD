// @screenshot showAxes framePlanes view iso-ftr
import { sketch, arc, plane } from 'fluidcad/core';

// An open path: one quarter-circle arc of radius 80 on the front plane,
// from (80, 80) down to the origin around the centre (80, 0).
const path = sketch("front", () => {
    arc([80, 80], [0, 0], [80, 0]);
});

// highlight-start
// A plane standing on the arc halfway along it — From edge type with the
// arc as Base and the position 'middle'. The arc's tangent at that point is
// the plane's normal, so a profile sketched here is square to the path; the
// arrow shows the tangent direction.
const onPath = plane(path, 'middle');
// highlight-end
