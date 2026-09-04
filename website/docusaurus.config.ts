import {readFileSync} from 'node:fs';
import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// The docs live inside the FluidCAD repo: pin viewer links to the version of
// the code they were written against. Until that version's engine bundle is in
// R2 (first tagged release after the browser host), the viewer falls back to
// its dev engine.
const fluidcadVersion: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const config: Config = {
  title: 'FluidCAD',
  tagline: 'Parametric CAD for everyone',
  favicon: 'img/favicon.png',

  customFields: {
    fluidcadVersion,
    fluidcadViewerUrl: process.env.FLUIDCAD_VIEWER_URL ?? 'https://viewer.fluidcad.io',
  },

  future: {
    v4: true,
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
        googleTagManager: {
          containerId: 'GTM-TB3P23FS',
        },
        gtag: {
          trackingID: 'G-0R7TSFFQTC',
          anonymizeIP: true,
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
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
    image: 'img/docusaurus-social-card.jpg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'FluidCAD',
      logo: {
        alt: 'FluidCAD Logo',
        src: 'img/logo.png',
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
