import {useEffect, useState} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

// Mirrors the viewer's fragment decoder (loaders.js decodeFragmentCode):
// base64url(deflate-raw(source)), decoded with the native DecompressionStream.
async function encodeFragmentCode(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
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

/**
 * Builds a `#v=&entry=&code=` viewer link for a .fluid.js source (typically a
 * raw-loader import). Returns null until the link is ready (SSR, first paint,
 * or browsers without CompressionStream).
 */
export function useViewerLink(code: string, entry?: string): string | null {
  const {siteConfig} = useDocusaurusContext();
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    if (typeof CompressionStream === 'undefined') {
      return undefined;
    }
    let cancelled = false;
    const {fluidcadVersion, fluidcadViewerUrl} = siteConfig.customFields as {
      fluidcadVersion: string;
      fluidcadViewerUrl: string;
    };
    // Screenshot-automation directives are meaningless outside the docs build.
    const source = code.replace(/^\/\/ @screenshot.*\r?\n/gm, '');
    encodeFragmentCode(source).then((encoded) => {
      if (cancelled) {
        return;
      }
      const params = new URLSearchParams();
      params.set('v', fluidcadVersion);
      if (entry && entry !== 'model.fluid.js') {
        params.set('entry', entry);
      }
      params.set('code', encoded);
      setHref(`${fluidcadViewerUrl}/#${params.toString()}`);
    });
    return () => {
      cancelled = true;
    };
  }, [code, entry, siteConfig]);

  return href;
}
