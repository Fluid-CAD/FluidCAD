import { arc, offset, sketch } from "fluidcad/core";

sketch("xy", () => {
    arc([50, 100]);
    offset(10).close()
})
