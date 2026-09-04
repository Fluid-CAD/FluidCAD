// @screenshot view top
import { sketch, text, extrude } from 'fluidcad/core';

sketch("xy", () => text("Multi\nLine").size(12).align("center"))
extrude(4)
