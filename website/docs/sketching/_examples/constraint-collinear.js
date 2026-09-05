// @screenshot view top hideDimensions
import { sketch, line, xAxis, yAxis } from 'fluidcad/core';
import { collinear, coincident, horizontal, vertical, distance } from "fluidcad/constraints";

sketch("xy", () => {
    // Half-profile of a shaft with a snap-ring groove, drawn to be
    // revolved about the X axis. The two lands either side of the groove
    // must share one surface.
    const bottom = line([0, 0], [90, 1]);
    const leftEnd = line([90, 1], [90, 20]);
    const rightLand = line([90, 20], [46, 21]);
    const grooveOut = line([46, 21], [46, 15]);
    const grooveFloor = line([46, 15], [40, 15]);
    const grooveIn = line([40, 15], [40, 19]);
    const leftLand = line([40, 19], [0, 19]);
    const rightEnd = line([0, 19], [0, 0]);
    coincident(bottom.end(), leftEnd.start());
    coincident(leftEnd.end(), rightLand.start());
    coincident(rightLand.end(), grooveOut.start());
    coincident(grooveOut.end(), grooveFloor.start());
    coincident(grooveFloor.end(), grooveIn.start());
    coincident(grooveIn.end(), leftLand.start());
    coincident(leftLand.end(), rightEnd.start());
    coincident(rightEnd.end(), bottom.start());
    // The profile's bottom edge IS the revolve axis: on the X axis, not
    // merely parallel to it.
    // highlight-next-line
    collinear(xAxis(), bottom);
    coincident(bottom.start(), yAxis());
    vertical(leftEnd);
    vertical(rightEnd);
    vertical(grooveIn);
    vertical(grooveOut);
    horizontal(leftLand);
    horizontal(grooveFloor);
    // The right land lies on the left land's line: one shaft diameter,
    // interrupted by the groove.
    // highlight-next-line
    collinear(leftLand, rightLand);
    distance(bottom.start(), bottom.end(), 90);   // shaft length
    distance(rightEnd.start(), rightEnd.end(), 20); // shaft radius
    distance(leftLand.start(), leftLand.end(), 40); // groove position
    distance(grooveIn, grooveOut, 6);              // groove width
    distance(leftLand, grooveFloor, 5);            // groove depth
})
