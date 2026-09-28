/**
 * A plain record whose MISSING identifier-shaped reads are refused instead
 * of yielding `undefined` — the guard behind `def.features.<name>` and
 * `instance.properties.<name>`, where an undefined slipping into a
 * consumer surfaces later as a baffling argument error.
 *
 * Only identifier-shaped string keys are guarded: symbol keys and protocol
 * probes (`then` from await coercion, JSON/console lookups) fall through so
 * the record still awaits, stringifies and logs like a plain object.
 */

/** Names the runtime itself may probe on any object — never treated as a missing member. */
const PROTOCOL_PROPS = new Set([
  "then", "catch", "finally", "toJSON", "toString", "valueOf", "constructor", "inspect",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Whether a missing-property read looks like a real `record.<name>` lookup. */
export function isMemberLookup(name: string): boolean {
  if (PROTOCOL_PROPS.has(name)) {
    return false;
  }
  return IDENTIFIER.test(name);
}

/**
 * Wrap `target` so a read of a declared member returns it unchanged, and a
 * read of an undeclared identifier calls `onMissing` — which throws the
 * pointed error (or re-propagates a breakpoint pause) for that name.
 */
export function guardedRecord<T>(
  target: Record<string, T>,
  onMissing: (name: string) => never,
): Record<string, T> {
  return new Proxy(target, {
    get: (record, prop, receiver) => {
      if (typeof prop === "string" && !(prop in record) && isMemberLookup(prop)) {
        onMissing(prop);
      }
      return Reflect.get(record, prop, receiver);
    },
  });
}
