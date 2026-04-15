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

const grooveX = extrude(3, s1).thin(-1).remove().symmetric();

repeat("linear", "y", {
    count: 3,
    offset: 25,
    centered: true
}, grooveX);

const grooveY = extrude(3, s2).thin(-1).remove().symmetric();

repeat("linear", "x", {
    count: 7,
    offset: 20,
    centered: true
}, grooveY);
