# Tandem — editor, website and collaboration server in one small image.
#
#   docker build -t tandem .
#   docker run -p 8787:8787 -v tandem-data:/data tandem
#
# Then open http://localhost:8787  (the editor lives at /app/).

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    EDITOR_DIST=/srv/editor \
    SITE_DIST=/srv/site
WORKDIR /srv
# The server bundle is self-contained; no node_modules are needed at runtime.
COPY --from=build /repo/apps/server/dist/server.js ./server.js
COPY --from=build /repo/apps/editor/dist ./editor
COPY --from=build /repo/apps/site/dist ./site
RUN addgroup -S tandem && adduser -S tandem -G tandem && mkdir -p /data && chown tandem:tandem /data
USER tandem
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "server.js"]
