# Website

This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

## Installation

```bash
yarn
```

## Local Development

```bash
npm run start
```

This starts Docusaurus and the local viewer at `http://localhost:8788`, so
embedded models render without a second terminal. The viewer checkout is
expected at `../../FluidCAD-Viewer` relative to this directory, with its npm
dependencies installed. Missing viewer build output is built automatically;
to refresh an existing build after viewer changes, run `npm run build` in
that checkout. Most docs changes appear live.

An already running viewer is reused. Ctrl+C stops the docs and any viewer
started by this command; an existing viewer is left running. Docusaurus
arguments still work, for example `npm run start -- --no-open --port 3001`.

### Environment

`npm start` and `npm run build:local` read `.env.local` (gitignored) through
`dotenv-cli`. It is loaded once at process start, so a change to it needs the
dev server restarted.

| Variable | Purpose |
| --- | --- |
| `ALGOLIA_APP_ID`, `ALGOLIA_SEARCH_API_KEY`, `ALGOLIA_INDEX_NAME` | DocSearch credentials. |
| `FLUIDCAD_VIEWER_URL` | Viewer origin. `npm start` defaults to `http://localhost:8788` and starts a viewer for loopback URLs. A remote URL skips local startup. Builds default to `https://viewer.fluidcad.io`. |
| `FLUIDCAD_VIEWER_DIR` | Viewer checkout path, absolute or relative to `website`. Defaults to `../../FluidCAD-Viewer`. |

To choose a different local viewer port, set:

```
FLUIDCAD_VIEWER_URL=http://localhost:8789
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
