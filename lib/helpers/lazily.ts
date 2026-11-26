/**
 * `target` with `key` computed on its first read and kept: the property is
 * a getter until then, a plain value after.
 */
export function lazily<T extends object, K extends string, V>(target: T, key: K, compute: () => V): T & { readonly [P in K]: V } {
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      const value = compute();
      Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: false });
      return value;
    },
  });
  return target as T & { readonly [P in K]: V };
}
