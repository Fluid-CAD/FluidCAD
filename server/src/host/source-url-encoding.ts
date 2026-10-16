import type { DevEnvironment } from 'vite';

const SOURCE_URL_MARKER = '\n//# sourceURL=';

/**
 * Percent-encode the characters V8 will not accept in a `sourceURL` value.
 * `%` is encoded alongside whitespace so decoding the frame path back is
 * always exact, whatever the directory is called.
 */
export function encodeSourceUrl(url: string): string {
  return url.replace(/[\s%]/g, (c) => encodeURIComponent(c));
}

/**
 * Keep every script's `//# sourceURL=` readable to V8 when its path holds
 * whitespace.
 *
 * Vite ends each module it hands the runner with `//# sourceURL=<module id>`,
 * written verbatim, and V8 discards a magic comment whose value contains a
 * space. A workspace under a directory like `My Projects` then evaluates
 * every script as `<anonymous>`: its inline source map never attaches, its
 * stack frames name no file, and no feature gets a source location — the
 * model renders but nothing in the UI can map a shape back to its code.
 *
 * This rewrites that comment with the id percent-encoded, which V8 keeps;
 * `extractSourceLocation` decodes the frame path back to the real one.
 * The value is rebuilt from the module id rather than from the comment:
 * newer Vite already encodes the whitespace (but not `%`), and encoding its
 * output again would leave `%2520` behind.
 */
export function installSourceUrlEncoding(environment: DevEnvironment): void {
  const viteFetch = environment.fetchModule.bind(environment);
  environment.fetchModule = async (id, importer, options) => {
    const result = await viteFetch(id, importer, options);
    if (!('code' in result)) {
      return result;
    }
    const start = result.code.lastIndexOf(SOURCE_URL_MARKER);
    if (start === -1) {
      return result;
    }
    const valueStart = start + SOURCE_URL_MARKER.length;
    const lineEnd = result.code.indexOf('\n', valueStart);
    const valueEnd = lineEnd === -1 ? result.code.length : lineEnd;
    const encoded = encodeSourceUrl(result.id);
    return {
      ...result,
      code: result.code.slice(0, valueStart) + encoded + result.code.slice(valueEnd),
    };
  };
}
