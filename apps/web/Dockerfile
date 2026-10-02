FROM node:20-bookworm AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @rehearsal/contracts build
RUN pnpm --filter @rehearsal/web build

FROM nginx:1.27-alpine
# Defaults to the Compose config, whose API upstream is the sibling
# `control-plane` container. The Fly build passes deploy/fly/nginx.fly.conf,
# which resolves the API app over the private network instead.
ARG NGINX_CONF=apps/web/nginx.conf
COPY ${NGINX_CONF} /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
