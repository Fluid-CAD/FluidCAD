import { sketch, extrude, cut, repeat, move, rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(300, 104).centered()
})

const tray = extrude(50)

sketch(tray.endFaces(), () => {
    move([-143, -45])
    rect(30, 40)
})

const c = cut(15)

repeat("linear", ["x", "y"], {
    count: [7, 2],
    length: [255, 50]
}, c)
