// @screenshot view top hideDimensions
import { sketch, line, xAxis } from 'fluidcad/core';
import { parallel, coincident, horizontal, fix, distance, angle } from "fluidcad/constraints";

sketch("xy", () => {
    // The cross-section of a tilted channel: a floor and two flanks.
    // The flanks are drawn at rough, unequal angles.
    const floor = line([0, 0], [30, 0]);
    const leftFlank = line([0, 0], [-16, 42]);
    const rightFlank = line([30, 0], [18, 40]);
    coincident(leftFlank.start(), floor.start());
    coincident(rightFlank.start(), floor.end());
    horizontal(floor);
    fix(floor.start());
    distance(floor.start(), floor.end(), 30);
    // The left flank sets the lean; the right flank follows it, so the
    // channel keeps a constant width whatever the lean becomes.
    angle(xAxis(), leftFlank, 110);
    // highlight-next-line
    parallel(leftFlank, rightFlank);
    distance(leftFlank.start(), leftFlank.end(), 45);
    distance(rightFlank.start(), rightFlank.end(), 45);
})
