import { sketch, plane, rect, move, select, wrap, cylinder } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

cylinder(25, 60);
const target = select(face().cylinder());

sketch(plane("front", 25), () => {
    move([2, 20]);
    rect(36, 20);
    move([7, 25]);
    rect(26, 10);
});

wrap(2, target);
