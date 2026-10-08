FROM node:24-bookworm-slim AS build

WORKDIR /src
# The manifests first, on their own layer: `npm ci` is cached across builds
# whose lockfile did not change, and the sources below invalidate only the
# build. `extension/vscode` is a workspace, so its manifest has to be there.
COPY package.json package-lock.json ./
COPY extension/vscode/package.json extension/vscode/
RUN npm ci

COPY . .
# Build the package, keep only what `npm pack` would publish (the "files" in
# package.json), and prune node_modules to the production dependencies the
# lockfile pins.
RUN npm run build \
  && npm pack --pack-destination /tmp \
  && mkdir -p /out/fluidcad \
  && tar -xzf /tmp/fluidcad-*.tgz -C /out/fluidcad --strip-components=1 \
  && npm prune --omit=dev --workspaces=false \
  && rm -rf node_modules/fluidcad node_modules/.bin \
  && mv node_modules /out/fluidcad/node_modules

FROM node:24-bookworm-slim

# A project's init.js does `import 'fluidcad'`; with the package at
# /app/node_modules/fluidcad, projects under /app/projects resolve it.
COPY --from=build /out/fluidcad /app/node_modules/fluidcad
RUN mkdir -p /app/projects /home/node/.fluidcad \
  && chown node:node /app/projects /home/node/.fluidcad

# Mount /app/projects for the projects themselves, and /home/node/.fluidcad for
# what the launcher keeps between runs: engines downloaded for projects pinned
# to another version, recent projects, previews.
USER node
WORKDIR /app/projects
EXPOSE 3100

# The start screen listens beyond loopback and proxies each project's engine,
# which stays on loopback. Its login URL (with token) is printed to the logs.
# Extra flags given to `docker run` are appended, such as `--public-url https://cad.example.com`
# (or set FLUIDCAD_PUBLIC_URL).
ENTRYPOINT ["node", "/app/node_modules/fluidcad/bin/fluidcad.js", "--projects", "/app/projects", "--host", "0.0.0.0", "--port", "3100", "--no-open"]
