// @screenshot waitForInput
import { sketch, text, extrude } from 'fluidcad/core';

sketch("xy", () => text("Hello").size(20))
extrude(6)
