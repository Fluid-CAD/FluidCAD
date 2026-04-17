import { SourceLocation } from "./scene-object.js";

export class BreakpointHit extends Error {
  readonly sourceLocation: SourceLocation | null;

  constructor(sourceLocation: SourceLocation | null) {
    super('FluidCAD breakpoint hit');
    this.name = 'BreakpointHit';
    this.sourceLocation = sourceLocation;
    Object.setPrototypeOf(this, BreakpointHit.prototype);
  }
}
