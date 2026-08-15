import { describe, it, expect } from "vitest";
import { extractSourceLocation } from "../index.js";

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
