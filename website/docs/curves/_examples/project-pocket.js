// @screenshot hideGrid
import { sketch, extrude, cut, plane, line, project } from 'fluidcad/core';
import { rect } from 'fluidcad/shapes';

// A block with a pocket in its top.
sketch('xy', () => {
  rect([0, 0], 80, 40).centered();
});
const block = extrude(20);
sketch(plane('xy', 20), () => {
  rect([0, 0], 30, 30).centered();
});
cut(8);

// A line drawn above the block, across the pocket.
const bar = sketch(plane('xy', 40), () => {
  line([-35, 0], [35, 0]);
});

// Straight down onto the block, keeping what each point meets first: the
// top face on either side of the pocket and the pocket's floor, three
// curves. The walls under the line and the block's bottom face are behind.
// highlight-next-line
const groove = project(bar, block);
