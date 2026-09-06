// @screenshot showAxes framePlanes view iso-ftr
import { plane } from 'fluidcad/core';

// Two parallel vertical planes: the YZ origin plane and the same plane
// shifted 60 along X.
const p1 = plane("yz");
const p2 = plane("yz", 60);

// highlight-start
// The plane halfway between them, at X = 30 — the Plane dialog's Mid plane
// type with the two plane rows as Bases. The two sources are folded into it:
// only the mid plane stays in the viewport.
const mid = plane(p1, p2);
// highlight-end
