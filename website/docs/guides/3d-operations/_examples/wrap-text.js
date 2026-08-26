import { sketch, plane, text, line, select, wrap, cylinder } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

cylinder(25, 60);
const target = select(face().cylinder());

const decal = sketch(plane("front", 25), () => {
    // The text flows along a guide line starting at [0, 24].
    const path = line([0, 24], [60, 24]).guide();
    text("FLUID", path).size(12);
  });

wrap(1, decal, target);
