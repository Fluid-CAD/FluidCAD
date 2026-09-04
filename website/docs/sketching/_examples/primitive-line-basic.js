import { sketch, line } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance } from "fluidcad/constraints";

sketch("xy", () => {
    // An L-bracket outline: six lines drawn corner to corner. The
    // coordinates are guesses; nothing joins consecutive lines until a
    // constraint says so.
    const base = line([0, 0], [80, 0]);
    const toe = line([80, 0], [80, 15]);
    const shelf = line([80, 15], [15, 15]);
    const inner = line([15, 15], [15, 60]);
    const top = line([15, 60], [0, 60]);
    const back = line([0, 60], [0, 0]);
    // The Polyline tool writes these when each new line starts on the
    // previous end (Auto-constraints); by hand you write them yourself.
    coincident(base.end(), toe.start());
    coincident(toe.end(), shelf.start());
    coincident(shelf.end(), inner.start());
    coincident(inner.end(), top.start());
    coincident(top.end(), back.start());
    coincident(back.end(), base.start());
    // Square the bracket up and give it its two leg lengths and thickness.
    horizontal(base);
    vertical(toe);
    horizontal(shelf);
    vertical(inner);
    horizontal(top);
    vertical(back);
    fix(base.start(), [0, 0]);
    distance(base.start(), base.end(), 80);
    distance(back.start(), back.end(), 60);
    distance(toe.start(), toe.end(), 15);
    distance(top.start(), top.end(), 15);
})
