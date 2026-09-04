// @screenshot view top
import { sketch, line, circle, point } from 'fluidcad/core';
import { midpoint, coincident, horizontal, vertical, fix, distance, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    // A mounting tab with one hole that must stay in its center however
    // the tab is resized.
    const bottom = line([0, 0], [50, 0]);
    const right = line([50, 0], [50, 30]);
    const top = line([50, 30], [0, 30]);
    const left = line([0, 30], [0, 0]);
    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    horizontal(top);
    vertical(left);
    vertical(right);
    fix(bottom.start());
    distance(bottom.start(), bottom.end(), 50);
    distance(left.start(), left.end(), 30);
    // Three-point form: halfway between two diagonal corners IS the
    // center of the tab — no numbers needed.
    const hole = circle([20, 12], 10);
    // highlight-next-line
    midpoint(hole.center(), bottom.start(), top.start());
    diameter(hole, 10);
    // Point + line form: an anchor at the middle of the top edge, where
    // a later feature (a rib, a connector) will attach.
    const anchor = point([30, 30]);
    // highlight-next-line
    midpoint(anchor, top);
})
