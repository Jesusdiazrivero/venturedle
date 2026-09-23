# Two stages: build the SPA, then a runtime that is the backend (under tsx, no compile step — D1)
# plus that SPA. The build context is the repo root because `shared/` is a workspace both need.

# ---- build the SPA ----
FROM node:24-alpine AS build
WORKDIR /app
# All four manifests so `npm ci` can validate the lockfile, even though only two are installed.
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY extractor/package.json extractor/
RUN npm ci --workspace shared --workspace frontend --include-workspace-root
COPY shared shared
COPY frontend frontend
RUN npm run build -w frontend

# ---- runtime ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    STATIC_DIR=/app/frontend/dist \
    COMPANIES_FILE=/data/companies.json
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY extractor/package.json extractor/
RUN npm ci --omit=dev --workspace shared --workspace backend --include-workspace-root \
 && npm cache clean --force
COPY shared shared
COPY backend backend
COPY --from=build /app/frontend/dist frontend/dist
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
# node + the local tsx, never npx: starting the container must not touch the network.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "backend/src/server.ts"]
