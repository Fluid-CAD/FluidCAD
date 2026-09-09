import {useEffect, useState} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

// Mirrors the viewer's fragment decoders (loaders.js decodeFragmentCode /
// decodeFragmentFiles): base64url(deflate-raw(text)), decoded with the native
// DecompressionStream. `code=` carries one source, `files=` the JSON of a
// { path: source } tree with its file names.
async function encodeFragment(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < compressed.length; i += 0x8000) {
    binary += String.fromCharCode(...compressed.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A multi-file model: file name (path inside the source tree) → source. */
export type ViewerFiles = Record<string, string>;

// Screenshot-automation directives are meaningless outside the docs build.
const stripDirectives = (source: string) =>
  source.replace(/^\/\/ @screenshot.*\r?\n/gm, '');

/**
 * Builds a viewer link. One source (typically a raw-loader import) becomes
 * `#v=&entry=&code=`; a { path: source } map becomes `#v=&entry=&files=`
 * with every file name preserved, `entry` naming the model to render first
 * (defaults to model.fluid.js in the viewer). Returns null until the link is
 * ready (SSR, first paint, or browsers without CompressionStream).
 */
export function useViewerLink(code: string | ViewerFiles, entry?: string): string | null {
  const {siteConfig} = useDocusaurusContext();
  const [href, setHref] = useState<string | null>(null);
  // Effect dependency for the map form: a fresh object literal per render
  // must not re-encode unless its content changed.
  const filesKey = typeof code === 'string' ? code : JSON.stringify(code);

  useEffect(() => {
    if (typeof CompressionStream === 'undefined') {
      return undefined;
    }
    let cancelled = false;
    const {fluidcadVersion, fluidcadViewerUrl} = siteConfig.customFields as {
      fluidcadVersion: string;
      fluidcadViewerUrl: string;
    };
    let payload: Promise<[string, string]>;
    if (typeof code === 'string') {
      payload = encodeFragment(stripDirectives(code)).then((encoded) => ['code', encoded]);
    } else {
      const tree: ViewerFiles = {};
      for (const [path, source] of Object.entries(code)) {
        tree[path] = stripDirectives(source);
      }
      payload = encodeFragment(JSON.stringify(tree)).then((encoded) => ['files', encoded]);
    }
    payload.then(([param, encoded]) => {
      if (cancelled) {
        return;
      }
      const params = new URLSearchParams();
      params.set('v', fluidcadVersion);
      if (entry && entry !== 'model.fluid.js') {
        params.set('entry', entry);
      }
      params.set(param, encoded);
      setHref(`${fluidcadViewerUrl}/#${params.toString()}`);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey, entry, siteConfig]);

  return href;
}
