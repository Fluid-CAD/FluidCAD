// @screenshot waitForInput
import { color, extrude, plane, sketch, vMove } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch(plane("xy"), () => {
    rect(200, 100).centered()
})

const e = extrude(20).draft(15)

// highlight-next-line
color("red", e.sideFaces(0));

sketch(plane("yz", { offset: 100 }), () => {
    vMove(20);
    rect(20, 20).centered()
});

// highlight-next-line
extrude(e.sideFaces(0));
