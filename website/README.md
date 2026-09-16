# Website

This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

## Installation

```bash
yarn
```

## Local Development

```bash
yarn start
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

### Environment

`npm start` and `npm run build:local` read `.env.local` (gitignored) through
`dotenv-cli`. It is loaded once at process start, so a change to it needs the
dev server restarted.

| Variable | Purpose |
| --- | --- |
| `ALGOLIA_APP_ID`, `ALGOLIA_SEARCH_API_KEY`, `ALGOLIA_INDEX_NAME` | DocSearch credentials. |
| `FLUIDCAD_VIEWER_URL` | Origin the embedded viewer loads from — the hero viewport on the landing page, `<ViewerEmbed>` and every "Open in viewer" link. Defaults to `https://viewer.fluidcad.io`. |

To point the site at a viewer running on this machine, build and serve the
viewer repo (`npm run build && npm run serve` in `FluidCAD-Viewer`, which
listens on `8788`) and set:

```
FLUIDCAD_VIEWER_URL=http://localhost:8788
```

The name has to match exactly: an unrecognised variable is not an error, the
site just falls back to the deployed viewer.

## Build

```bash
yarn build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

## Deployment

Using SSH:

```bash
USE_SSH=true yarn deploy
```

Not using SSH:

```bash
GIT_USER=<Your GitHub username> yarn deploy
```

If you are using GitHub pages for hosting, this command is a convenient way to build the website and push to the `gh-pages` branch.
