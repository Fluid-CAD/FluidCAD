import { describe, it, expect } from "vitest";
import { extractErrorSourceLocation, extractSourceLocation } from "../index.js";

// A thrown error's location: the stack's first script frame, the error's own
// header left out — a message that ends in a script location
// (`… at flange.part.js:21`) must not read as a frame.
describe("extractErrorSourceLocation", () => {
  /** An error whose stack is `stack`, as V8 would print it for `message`. */
  function thrown(message: string, frames: string): Error {
    const error = new Error(message);
    error.stack = `Error: ${message}\n${frames}`;
    return error;
  }

  it("skips a message that ends in a script location", () => {
    const error = thrown(
      "bolt.instance(4) was skipped by the copy at flange.part.js:21",
      "    at Connector.instance (/ws/node_modules/fluidcad/lib/dist/features/connector.js:120:19)\n"
      + "    at eval (virtual:live-render:/ws/rig.assembly.js:12:22)",
    );
    expect(extractErrorSourceLocation(error)).toEqual({ filePath: "/ws/rig.assembly.js", line: 12, column: 22 });
  });

  it("skips a multi-line message", () => {
    const error = thrown(
      "first line\nsee widget.part.js:3",
      "    at Object.<anonymous> (/ws/model.fluid.js:7:1)",
    );
    expect(extractErrorSourceLocation(error)).toEqual({ filePath: "/ws/model.fluid.js", line: 7, column: 1 });
  });

  it("parses a stack without a header as it is", () => {
    const error = new Error("see widget.part.js:3");
    error.stack = "instance@virtual:live-render:/ws/rig.assembly.js:12:22";
    expect(extractErrorSourceLocation(error)).toEqual({ filePath: "/ws/rig.assembly.js", line: 12, column: 22 });
  });

  it("returns null for a value with no stack", () => {
    expect(extractErrorSourceLocation("boom")).toBeNull();
    expect(extractErrorSourceLocation(null)).toBeNull();
    expect(extractErrorSourceLocation({ message: "x" })).toBeNull();
  });
});

describe("extractSourceLocation", () => {
  it("parses Linux virtual:live-render frame", () => {
    const stack = `Error
    at breakpoint (file:///home/user/node_modules/fluidcad/lib/dist/core/breakpoint.js:4:11)
    at eval (virtual:live-render:/home/user/project/test.fluid.js:10:5)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toEqual({
      filePath: "/home/user/project/test.fluid.js",
      line: 10,
      column: 5,
    });
  });

  it("parses Linux real file path", () => {
    const stack = `Error
    at Object.<anonymous> (/home/user/project/test.fluid.js:10:5)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toEqual({
      filePath: "/home/user/project/test.fluid.js",
      line: 10,
      column: 5,
    });
  });

  it("parses Windows virtual:live-render frame with backslashes", () => {
    const stack = `Error
    at breakpoint (file:///C:/Users/marwan/proj/test5/node_modules/fluidcad/lib/dist/core/breakpoint.js:4:11)
    at eval (C:\\Users\\marwan\\AppData\\Local\\Programs\\Microsoft VS Code\\virtual:live-render:C:\\Users\\marwan\\proj\\test5\\test.fluid.js:8:11)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toEqual({
      filePath: "C:/Users/marwan/proj/test5/test.fluid.js",
      line: 8,
      column: 11,
    });
  });

  it("parses Windows file:/// URL with forward slashes", () => {
    const stack = `Error
    at Object.<anonymous> (file:///C:/Users/marwan/proj/test.fluid.js:4:11)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toEqual({
      filePath: "C:/Users/marwan/proj/test.fluid.js",
      line: 4,
      column: 11,
    });
  });

  it("skips non-FluidCAD-script files", () => {
    const stack = `Error
    at breakpoint (/home/user/node_modules/fluidcad/lib/dist/core/breakpoint.js:4:11)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toBeNull();
  });

  it("parses .part.js frames", () => {
    const stack = `Error
    at eval (virtual:live-render:/home/user/project/widget.part.js:12:3)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toEqual({
      filePath: "/home/user/project/widget.part.js",
      line: 12,
      column: 3,
    });
  });

  it("parses .assembly.js frames", () => {
    const stack = `Error
    at Object.<anonymous> (/home/user/project/robot.assembly.js:7:9)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toEqual({
      filePath: "/home/user/project/robot.assembly.js",
      line: 7,
      column: 9,
    });
  });

  it("skips frames with no file", () => {
    const stack = `Error
    at Array.forEach (<anonymous>)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toBeNull();
  });

  it("returns null for empty stack", () => {
    const loc = extractSourceLocation("");
    expect(loc).toBeNull();
  });

  it("skips breakpoint.js and finds the .fluid.js caller", () => {
    const stack = `Error
    at captureSourceLocation (/home/user/node_modules/fluidcad/lib/dist/index.js:9:15)
    at breakpoint (/home/user/node_modules/fluidcad/lib/dist/core/breakpoint.js:4:11)
    at Object.<anonymous> (/home/user/project/model.fluid.js:3:1)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toEqual({
      filePath: "/home/user/project/model.fluid.js",
      line: 3,
      column: 1,
    });
  });
});
