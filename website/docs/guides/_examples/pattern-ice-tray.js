import { sketch, extrude, cut, repeat, move, rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(300, 104).centered()
})

const tray = extrude(50)

// One pocket
sketch(tray.endFaces(), () => {
    move([-143, -45])
    rect(30, 40)
})

const pocket = cut(30).draft(-10)

// Repeat the pocket in a 7x2 grid
repeat("linear", ["x", "y"], {
    count: [7, 2],
    length: [255, 50]
}, pocket)
