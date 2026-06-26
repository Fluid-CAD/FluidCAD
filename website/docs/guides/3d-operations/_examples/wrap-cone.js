import { sketch, plane, line, revolve, slot, select, wrap } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

sketch("xz", () => {
    line([0, 0], [30, 0]);
    line([30, 0], [20, 50]);
    line([20, 50], [0, 50]);
    line([0, 50], [0, 0]);
});
revolve("z");

const target = select(face().cone());

const decal = sketch(plane("front", 26), () => {
    slot([-8, 25], [8, 25], 4);
});

wrap(1.5, decal, target);
