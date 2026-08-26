import { sketch, arc, offset } from "fluidcad/core";

sketch("xy", () => {
    arc([0, 0], [50, 100], [15, 55]);
    offset(10).close()
})
