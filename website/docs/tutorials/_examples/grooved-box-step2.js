// @screenshot waitForInput
import { sketch, extrude, select, fillet, rect, shell, intersect, repeat } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

sketch("xy", () => {
    rect(170, 100).radius(18).centered();
});

const e = extrude(23.6);

const s = shell(-5, e.endFaces())

fillet(8, s.internalEdges())
