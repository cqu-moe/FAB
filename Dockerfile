FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .design ./.design

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN pnpm build

FROM base
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3030
RUN pnpm install --prod --frozen-lockfile && mkdir -p /app/data && chown node:node /app/data
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
USER node
EXPOSE 3030
CMD ["node", "--env-file-if-exists=.env", "--import", "tsx", "src/server/index.ts"]
