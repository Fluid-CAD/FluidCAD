import { circle, copy, extrude, sketch } from 'fluidcad/core';

sketch("xy", () => {
    circle([150, 150], 100)
})

// A cylinder; extrude() with no distance uses the default of 25.
extrude()

// highlight-start
// Four instances in a row along world X, 150 apart — the original counts.
copy("linear", "x", {
    count: 4,
    offset: 150
})
// highlight-end
