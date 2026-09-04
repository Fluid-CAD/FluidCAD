// @screenshot view top
import { sketch, line, circle } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    // A tall plate drawn leaning; the constraints stand it upright.
    const bottom = line([0, 0], [40, 0]);
    const right = line([40, 0], [46, 90]);
    const top = line([46, 90], [6, 90]);
    const left = line([6, 90], [0, 0]);
    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    horizontal(top);
    // highlight-start
    vertical(left);                   // line form: the sides become vertical
    vertical(right);
    // highlight-end
    fix(bottom.start());
    distance(bottom.start(), bottom.end(), 40);
    distance(left.start(), left.end(), 90);
    // A column of holes: the point form stacks their centers on one x.
    const h1 = circle([22, 15], 8);
    const h2 = circle([18, 45], 8);
    const h3 = circle([24, 75], 8);
    // highlight-next-line
    vertical(h1.center(), h2.center(), h3.center());
    diameter(h1, 8);
    diameter(h2, 8);
    diameter(h3, 8);
    distance(left, h1.center(), 20);
    distance(bottom, h1.center(), 15);
    distance(h1.center(), h2.center(), 30);
    distance(h2.center(), h3.center(), 30);
})
