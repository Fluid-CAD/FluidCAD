/**
 * A short, stable digest of a text: 53 bits (cyrb53) as 14 hex digits.
 *
 * It names content — a generator's class text in its code version, a
 * template's identity key in a build report — so two equal texts give the
 * same digest in every process. It is not cryptographic: nothing relies on
 * two different texts never sharing a digest beyond what a cache key
 * tolerates (a 1 in 2^53 chance per pair).
 */
export class TextDigest {

  static of(text: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return value.toString(16).padStart(14, '0');
  }
}
