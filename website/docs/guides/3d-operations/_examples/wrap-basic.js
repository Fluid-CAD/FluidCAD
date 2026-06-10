import { sketch, plane, rect, move, select, wrap, cylinder } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

cylinder(25, 60);
const target = select(face().cylinder());

sketch(plane("front", 25), () => {
    move([5, 23]);
    rect(30, 14);
});

wrap(2, target);
