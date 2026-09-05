// @screenshot view top hideDimensions
import { sketch, line, circle, origin, yAxis } from 'fluidcad/core';
import { symmetric, coincident, vertical, distance, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    // A bore with a keyway. The keyway's two walls are drawn at unequal
    // distances from the centreline.
    const bore = circle([0, 0], 40);
    coincident(bore.center(), origin());
    diameter(bore, 40);
    const leftWall = line([-4, 19], [-4, 24]);
    const rightWall = line([2, 20], [2, 24]);
    const top = line([-4, 24], [2, 24]);
    coincident(leftWall.end(), top.start());
    coincident(top.end(), rightWall.end());
    coincident(leftWall.start(), bore);     // both walls start on the bore
    vertical(leftWall);
    // Each wall endpoint mirrors its partner across the Y axis — the
    // sketch's centreline — so the keyway stays centred on the bore.
    // highlight-start
    symmetric(leftWall.start(), rightWall.start(), yAxis());
    symmetric(leftWall.end(), rightWall.end(), yAxis());
    // highlight-end
    distance(leftWall, rightWall, 6);       // keyway width
    distance(origin(), top, 23);            // keyway depth from the bore center
})
