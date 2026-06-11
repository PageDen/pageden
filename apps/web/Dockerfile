# Build the SPA, then serve it via nginx with a same-origin /api proxy.
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
ENV VITE_API_BASE_URL=/api
ARG VITE_WORKSPACE_BASE_DOMAIN=pageden.app
ENV VITE_WORKSPACE_BASE_DOMAIN=$VITE_WORKSPACE_BASE_DOMAIN
RUN pnpm --filter @pageden/web build

FROM nginx:1.27-alpine
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
