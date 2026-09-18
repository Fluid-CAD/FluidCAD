import {readFileSync} from 'node:fs';
import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// The released version: download links and the version badge on the landing
// page. This is the tag that exists, not the one being written towards.
const fluidcadVersion: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// The engine bundle every embedded viewer asks for. The docs live inside the
// FluidCAD repo, so their models are written against the release being built
// towards rather than the last one tagged — this runs ahead of
// `fluidcadVersion` and only catches up when that release ships. Until its
// bundle is in R2 the viewer answers the probe with a 404 and falls back to
// the engine it was deployed with, which is the build the shell shipped from.
const fluidcadEngineVersion: string = process.env.FLUIDCAD_ENGINE_VERSION ?? '0.0.44';

// `docusaurus build` is the only command that should carry analytics.
const isBuild = process.argv.includes('build');

const config: Config = {
  title: 'FluidCAD',
  tagline: 'Parametric CAD for everyone',
  favicon: 'img/favicon.png',

  customFields: {
    fluidcadVersion,
    fluidcadEngineVersion,
    fluidcadViewerUrl: process.env.FLUIDCAD_VIEWER_URL ?? 'https://viewer.fluidcad.io',
  },

  future: {
    v4: true,
    faster: {
      // Avoid restoring stale Rspack module graphs across server restarts.
      rspackPersistentCache: false,
    },
  },

  url: 'https://fluidcad.io',
  baseUrl: '/',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          lastVersion: 'current',
          versions: {
            current: {
              label: 'Next',
            },
          },
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
        // Analytics only ship in the production build: gating on the command
        // (not NODE_ENV) keeps `npm start` free of gtag/GTM even when the shell
        // has NODE_ENV=production, which otherwise registers the gtag client
        // module without its script tag ("window.gtag is not a function").
        ...(isBuild && {
          googleTagManager: {
            containerId: 'GTM-TB3P23FS',
          },
          gtag: {
            trackingID: 'G-0R7TSFFQTC',
            anonymizeIP: true,
          },
        }),
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    function devHtmlTemplate() {
      return {
        name: 'dev-html-template',
        configureWebpack: () => ({
          // Docusaurus 3.10 also enables the disk cache through experiments,
          // independently of rspackPersistentCache. Disable that path too.
          experiments: {cache: false},
          module: {
            // html-webpack-plugin's EJS loader emits CommonJS. Explicitly
            // preserve that module format when Rspack compiles the dev shell.
            rules: [{test: /dev\.html\.template\.ejs$/, type: 'javascript/auto'}],
          },
        }),
      };
    },
    // Reads the desktop builds off the latest GitHub release at build time so
    // the download section can state today's truth. Non-fatal when offline.
    './plugins/desktop-release.ts',
    // Dev-server twin of static/_headers: cross-origin isolation so the
    // embedded viewer iframe gets SharedArrayBuffer during `npm start` too.
    function crossOriginIsolation() {
      return {
        name: 'cross-origin-isolation',
        configureWebpack: () =>
          ({
            devServer: {
              headers: {
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'credentialless',
              },
            },
          }) as object,
      };
    },
  ],

  themeConfig: {
    image: 'img/social-card.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'FluidCAD',
      logo: {
        alt: 'FluidCAD Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          type: 'docSidebar',
          sidebarId: 'apiSidebar',
          position: 'left',
          label: 'API',
        },
        {
          type: 'docsVersionDropdown',
          position: 'right',
        },
        {
          href: 'https://github.com/Fluid-CAD/FluidCAD',
          label: 'GitHub',
          position: 'right',
          className: 'header-social-link header-github-link',
          'aria-label': 'FluidCAD on GitHub',
        },
        {
          href: 'https://x.com/fluid_cad',
          label: 'X',
          position: 'right',
          className: 'header-social-link header-x-link',
          'aria-label': 'FluidCAD on X',
        },
        {
          href: 'https://www.reddit.com/r/FluidCAD/',
          label: 'Reddit',
          position: 'right',
          className: 'header-social-link header-reddit-link',
          'aria-label': 'FluidCAD on Reddit',
        },
        {
          href: 'https://www.youtube.com/@FluidCAD',
          label: 'YouTube',
          position: 'right',
          className: 'header-social-link header-youtube-link',
          'aria-label': 'FluidCAD on YouTube',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            {
              label: 'Getting Started',
              to: '/docs/getting-started',
            },
            {
              label: 'Sketching',
              to: '/docs/sketching',
            },
            {
              label: 'Assembly',
              to: '/docs/assembly',
            },
            {
              label: 'Tutorials',
              to: '/docs/tutorials',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/Fluid-CAD/FluidCAD',
            },
            {
              label: 'X',
              href: 'https://x.com/fluid_cad',
            },
            {
              label: 'Reddit',
              href: 'https://www.reddit.com/r/FluidCAD/',
            },
            {
              label: 'YouTube',
              href: 'https://www.youtube.com/@FluidCAD',
            },
          ],
        },
      ],
      copyright: `Copyright \u00a9 ${new Date().getFullYear()} FluidCAD. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.vsDark,
    },
    algolia: {
      appId: process.env.ALGOLIA_APP_ID ?? 'YOUR_APP_ID',
      apiKey: process.env.ALGOLIA_SEARCH_API_KEY ?? 'YOUR_SEARCH_API_KEY',
      indexName: process.env.ALGOLIA_INDEX_NAME ?? 'fluidcad',
      contextualSearch: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
