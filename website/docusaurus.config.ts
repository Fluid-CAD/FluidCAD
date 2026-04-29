import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'FluidCAD',
  tagline: 'Parametric CAD for everyone',
  favicon: 'img/favicon.png',

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
              label: 'Guides',
              to: '/docs/guides',
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
