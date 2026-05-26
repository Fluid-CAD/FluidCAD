// @screenshot waitForInput
import { sketch, aLine, vLine, move, tCircle } from 'fluidcad/core';

sketch("xy", () => {
    const l1 = aLine(45, 200).guide()
    move([-50, 0])
    const l2 = vLine(200).guide()

    // mustTouch=true keeps only solutions that physically touch both segments
    tCircle(l1, l2, 200, true)
})
