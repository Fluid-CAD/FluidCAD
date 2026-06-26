// @screenshot waitForInput
import { sketch, text, extrude } from 'fluidcad/core';

sketch("xy", () => text("Bold").size(20).font("Times New Roman").weight("bold"))
extrude(6)
