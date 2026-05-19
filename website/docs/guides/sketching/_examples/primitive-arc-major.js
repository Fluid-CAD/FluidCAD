import { sketch, arc } from 'fluidcad/core';

sketch("xy", () => {
    // Minor arc (default): the shorter of the two arcs that fit
    arc([0, 0], [100, 0]).radius(80)

    // Major arc: same chord and radius, but the long way around
    arc([150, 0], [250, 0]).radius(80).major()
})
