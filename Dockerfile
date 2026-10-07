FROM node:24-bookworm-slim

WORKDIR /app
COPY . .
RUN npm ci \
  && npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force \
  # A project's init.js does `import 'fluidcad'`; link the build into
  # node_modules so projects under /app/projects resolve it.
  && ln -s /app node_modules/fluidcad \
  && mkdir -p projects /home/node/.fluidcad \
  && chown node:node projects /home/node/.fluidcad

# Mount /app/projects for the projects themselves, and /home/node/.fluidcad for
# what the launcher keeps between runs: engines downloaded for projects pinned
# to another version, recent projects, previews.
USER node
WORKDIR /app/projects
EXPOSE 3100

# The start screen listens beyond loopback and proxies each project's engine,
# which stays on loopback. Its login URL (with token) is printed to the logs.
# Extra flags given to `docker run` are appended, such as `--public-url https://cad.example.com`.
ENTRYPOINT ["node", "/app/bin/fluidcad.js", "--projects", "/app/projects", "--host", "0.0.0.0", "--port", "3100", "--no-open"]
