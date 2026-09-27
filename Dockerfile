# syntax=docker/dockerfile:1

FROM node:20-bookworm AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY courses ./courses

RUN pnpm install --frozen-lockfile
# Compile the native addon explicitly; pnpm 10 can skip dependency scripts during install.
RUN cd /app/node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3 \
  && npx --yes node-gyp rebuild --release
RUN pnpm --filter @rehearsal/contracts build

FROM build AS control-plane-build
RUN pnpm --filter @rehearsal/control-plane build

FROM build AS agent-worker-build
RUN pnpm --filter @rehearsal/agent-worker build

FROM node:20-bookworm AS control-plane
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY --from=control-plane-build /app/node_modules ./node_modules
COPY --from=control-plane-build /app/apps/control-plane/node_modules ./apps/control-plane/node_modules
COPY --from=control-plane-build /app/packages/contracts ./packages/contracts
COPY --from=control-plane-build /app/apps/control-plane/dist ./apps/control-plane/dist
COPY --from=control-plane-build /app/apps/control-plane/package.json ./apps/control-plane/package.json
COPY --from=control-plane-build /app/courses ./courses
RUN mkdir -p /app/apps/control-plane/.data
EXPOSE 3000
CMD ["node", "apps/control-plane/dist/main.js"]

FROM node:20-bookworm AS agent-worker
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY --from=agent-worker-build /app/node_modules ./node_modules
COPY --from=agent-worker-build /app/apps/agent-worker/node_modules ./apps/agent-worker/node_modules
COPY --from=agent-worker-build /app/packages/contracts ./packages/contracts
COPY --from=agent-worker-build /app/apps/agent-worker/dist ./apps/agent-worker/dist
COPY --from=agent-worker-build /app/apps/agent-worker/package.json ./apps/agent-worker/package.json
COPY --from=agent-worker-build /app/courses ./courses
CMD ["node", "apps/agent-worker/dist/index.js", "start"]
