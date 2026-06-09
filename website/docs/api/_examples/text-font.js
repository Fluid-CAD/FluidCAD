// @screenshot waitForInput
import { text, extrude } from 'fluidcad/core';

text("xy", "Bold").size(20).font("Times New Roman").weight("bold")
extrude(6)
