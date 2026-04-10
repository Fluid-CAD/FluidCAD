// @screenshot showAxes
import { axis, extrude, rect, rotate, sketch } from 'fluidcad/core';

sketch("xy", () => {
    rect([100, 100], 200, 100)
})

extrude(20)

const a = axis("z", { offsetX: 90, offsetY: 90 })

rotate(a, 90, true)
rotate(a, 180, true)
