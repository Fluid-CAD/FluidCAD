import { sketch, line, circle } from 'fluidcad/core';
import { vertical, fix, distance, diameter } from "fluidcad/constraints";

sketch("xy", () => {
    const wall = line([0, 0], [0, 100]);
    const near = circle([140, 30], 40);
    const far = circle([140, 70], 40);
    vertical(wall);
    fix(wall.start());
    distance(wall.start(), wall.end(), 100);
    diameter(near, 40);
    diameter(far, 40);
    distance(wall, near, 130);        // to the near side of the circumference
    distance(wall, far, 170).max();   // to the far side instead
})
