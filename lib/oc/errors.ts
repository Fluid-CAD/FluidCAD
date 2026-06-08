import { getOC } from "./init.js";

/**
 * ocjs v3 / OCCT V8 raises C++ failures as native `WebAssembly.Exception`
 * objects. Their default stringification is the opaque
 * `[object WebAssembly.Exception]`, so decode the OCCT failure type + message
 * via the module's `getExceptionMessage`. Ordinary JS errors pass through with
 * their stack/message.
 */
export function describeOcException(e: unknown): string {
  if (isWasmException(e)) {
    try {
      const [type, message] = getOC().getExceptionMessage(e);
      return `${type}: ${message}`;
    } catch {
      return "WebAssembly.Exception (failed to decode OCCT message)";
    }
  }
  if (e instanceof Error) {
    return e.stack ?? e.message;
  }
  return String(e);
}

function isWasmException(e: unknown): e is object {
  const ctor = (globalThis as { WebAssembly?: { Exception?: Function } }).WebAssembly?.Exception;
  return typeof ctor === "function" && e instanceof ctor;
}
