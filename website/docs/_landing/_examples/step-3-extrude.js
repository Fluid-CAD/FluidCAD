// @screenshot showAxes noAutoCrop aspectRatio 1.67
import { sketch, extrude } from 'fluidcad/core'
import { circle } from 'fluidcad/core'

sketch("xy", () => {
    circle(50)
})

const e = extrude(50)
