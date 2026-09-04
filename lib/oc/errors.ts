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

/**
 * Whatever the binding's decoder takes — `WebAssembly.Exception` where the
 * compiler can see that type, `any` where it cannot (it is not in this
 * project's lib set; only the binding's own declarations name it).
 */
type OcException = Parameters<ReturnType<typeof getOC>["getExceptionMessage"]>[0];

function isWasmException(e: unknown): e is OcException {
  const ctor = (globalThis as { WebAssembly?: { Exception?: Function } }).WebAssembly?.Exception;
  return typeof ctor === "function" && e instanceof ctor;
}
