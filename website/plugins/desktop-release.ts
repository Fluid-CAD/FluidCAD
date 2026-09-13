import type {LoadContext, Plugin} from '@docusaurus/types';

/**
 * The desktop builds, read from the GitHub release at build time.
 *
 * The download section states today's truth or nothing: rather than pointing
 * at URLs that electron-builder *will* produce and 404 until it does, this
 * asks the release what it actually carries. The day the binaries are
 * attached, the next deploy lights the buttons up with no code change; until
 * then every platform renders its "not published yet" state.
 *
 * Failure is not fatal. A build behind a proxy, offline, or rate-limited gets
 * an empty asset list and the same honest state, with a warning in the log.
 */

export type DesktopAsset = {
  label: string;
  url: string;
  size: number;
};

export type DesktopRelease = {
  /** Release tag, e.g. `v0.0.42`. Empty when the lookup failed. */
  tag: string;
  /** Where a visitor goes when their platform has no asset. */
  releasesUrl: string;
  mac: DesktopAsset[];
  windows: DesktopAsset[];
  linux: DesktopAsset[];
};

const REPO = 'Fluid-CAD/FluidCAD';
const TIMEOUT_MS = 6000;

/**
 * Which platform an asset belongs to, and how to name it in the UI.
 *
 * Matched on extension rather than on electron-builder's filename template:
 * the template carries the product name and version, both of which change,
 * while `.dmg` is a macOS disk image whatever it is called.
 */
const KINDS: {test: RegExp; platform: 'mac' | 'windows' | 'linux'; label: (name: string) => string}[] = [
  {test: /\.dmg$/i, platform: 'mac', label: (n) => (/arm64/i.test(n) ? 'Apple silicon (.dmg)' : 'Intel (.dmg)')},
  {test: /-mac\.zip$/i, platform: 'mac', label: () => 'Zip archive'},
  {test: /\.exe$/i, platform: 'windows', label: () => 'Installer (.exe)'},
  {test: /\.appimage$/i, platform: 'linux', label: () => 'AppImage'},
  {test: /\.deb$/i, platform: 'linux', label: () => 'Debian package (.deb)'},
];

type GitHubAsset = {name: string; browser_download_url: string; size: number};

async function fetchLatest(): Promise<DesktopRelease> {
  const empty: DesktopRelease = {
    tag: '',
    releasesUrl: `https://github.com/${REPO}/releases`,
    mac: [],
    windows: [],
    linux: [],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {Accept: 'application/vnd.github+json'};
    // CI has one; a laptop usually does not. Only affects the rate limit.
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status}`);
    }
    const release = (await response.json()) as {tag_name?: string; assets?: GitHubAsset[]};
    const out: DesktopRelease = {...empty, tag: release.tag_name ?? ''};
    for (const asset of release.assets ?? []) {
      const kind = KINDS.find((k) => k.test.test(asset.name));
      if (kind) {
        out[kind.platform].push({
          label: kind.label(asset.name),
          url: asset.browser_download_url,
          size: asset.size,
        });
      }
    }
    return out;
  } catch (error) {
    console.warn(
      `[desktop-release] Could not read the latest release (${(error as Error).message}). ` +
        'The download section will render its unpublished state.',
    );
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

export default function desktopRelease(_context: LoadContext): Plugin<DesktopRelease> {
  return {
    name: 'fluidcad-desktop-release',
    async loadContent() {
      return fetchLatest();
    },
    contentLoaded({content, actions}) {
      actions.setGlobalData(content);
    },
  };
}
