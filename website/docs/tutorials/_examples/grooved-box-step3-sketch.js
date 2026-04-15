// @screenshot waitForInput
import { sketch, extrude, select, fillet, rect, shell, intersect, repeat } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

sketch("xy", () => {
    rect(170, 100).radius(18).centered();
});

const e = extrude(23.6);

const s = shell(-5, e.endFaces())

fillet(8, s.internalEdges())

const facesX = select(face().intersectsWith("front").notOnPlane("xy"))

const s1 = sketch("front", () => {
    intersect(facesX);
});

const facesY = select(face().intersectsWith("left").notOnPlane("xy"))

const s2 = sketch("left", () => {
    intersect(facesY);
});
