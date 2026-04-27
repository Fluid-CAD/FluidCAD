import { line, hLine, vLine, move, sketch } from 'fluidcad/core';

sketch("xy", () => {
    const wall = line([80, -20], [80, 100]).guide()
    const ceiling = line([0, 60], [120, 60]).guide()

    move([0, 0])
    hLine(wall)          // origin → meets the wall at x=80
    vLine(ceiling)       // up to the ceiling at y=60
})
