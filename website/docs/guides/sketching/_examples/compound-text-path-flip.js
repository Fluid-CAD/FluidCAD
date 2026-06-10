// @screenshot waitForInput
import { circle, extrude, text } from 'fluidcad/core';

const ring = circle("xy", 90).reusable();
const outside = text("OUTSIDE", ring).size(10).align("center");
// startAt(141) ≈ half the circumference: badge-style text on the far side.
const inside = text("INSIDE", ring).size(10).align("center").flip().startAt(141);
extrude(3, outside);
extrude(3, inside);
