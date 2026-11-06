import { parse as parseStackTrace } from "stacktrace-parser";

/** One frame of a captured stack that names a file and a line, its file read as a path. */
export type StackFrame = {
  filePath: string;
  line: number;
  column: number;
};

/**
 * Reading the frames of a JavaScript stack: what attributes a statement to
 * its line in a script (`captureSourceLocation`) and a `load()` or a
 * `.font()` to the file that wrote the call (`AssetRoots`).
 */
export class StackFrames {
  /**
   * The stack depth a capture reads. V8 keeps 10 frames by default, and a
   * statement reached through helper modules, a part body and an insert from
   * an assembly can sit deeper than that: its script frame would be cut off
   * and the object would get no location — no unit, no part, no way back to
   * its line.
   */
  static readonly CAPTURE_LIMIT = 50;

  private static readonly VIRTUAL_PREFIX = 'virtual:live-render:';

  /**
   * The stack where this is called, {@link CAPTURE_LIMIT} frames deep, or
   * null on an engine that gives none. The limit is raised for this one
   * capture only: every other error keeps the limit the host chose. Engines
   * without the knob (Firefox, Safari) leave it undefined.
   */
  static capture(): string | null {
    const limit = Error.stackTraceLimit;
    const raise = typeof limit === 'number' && limit < StackFrames.CAPTURE_LIMIT;
    let stack: string | undefined;
    if (raise) {
      Error.stackTraceLimit = StackFrames.CAPTURE_LIMIT;
    }
    try {
      stack = new Error().stack;
    } finally {
      if (raise) {
        Error.stackTraceLimit = limit;
      }
    }
    return stack ? stack : null;
  }

  /**
   * The frames of `stack` that name a file and a line, innermost first, each
   * file read as a path ({@link filePath}).
   */
  static parse(stack: string): StackFrame[] {
    const frames: StackFrame[] = [];
    for (const frame of parseStackTrace(stack)) {
      if (!frame.file || frame.lineNumber == null) {
        continue;
      }
      frames.push({ filePath: StackFrames.filePath(frame.file), line: frame.lineNumber, column: frame.column ?? 0 });
    }
    return frames;
  }

  /**
   * A frame's file as the path it names: the live editor buffer's
   * `virtual:live-render:` overlay and a `file://` URL's scheme dropped, the
   * percent-encoding undone, and backslashes turned forward. A script frame's
   * path arrives percent-encoded — `file://` URLs always are, and the server
   * encodes the `sourceURL` it hands V8 because V8 drops one holding
   * whitespace (a workspace under `My Projects`). A path that is not valid
   * percent-encoding is kept as it came.
   */
  static filePath(file: string): string {
    let filePath = file;
    const virtualIdx = filePath.lastIndexOf(StackFrames.VIRTUAL_PREFIX);
    if (virtualIdx !== -1) {
      filePath = filePath.slice(virtualIdx + StackFrames.VIRTUAL_PREFIX.length);
    }
    if (filePath.startsWith('file:///')) {
      filePath = filePath.slice('file:///'.length);
      if (!/^[A-Za-z]:/.test(filePath)) {
        filePath = '/' + filePath;
      }
    }
    try {
      filePath = decodeURIComponent(filePath);
    } catch {
      // Not percent-encoding: kept as it came.
    }
    return filePath.replace(/\\/g, '/');
  }
}
