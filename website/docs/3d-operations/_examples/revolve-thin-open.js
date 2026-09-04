// @screenshot showAxes
import { sketch, revolve } from 'fluidcad/core';
import { line } from 'fluidcad/core';

sketch("xz", () => {
    line([40, 0], [100, 0])
})

// highlight-next-line
revolve("z", 275).thin(8).new()
