# Build context: repository root.
# The brain depends on the apps/x pnpm workspace for @x/shared.
FROM node:24-bookworm-slim

WORKDIR /app
RUN corepack enable

COPY apps/harbor/packages/protocol ./apps/harbor/packages/protocol
COPY apps/x ./apps/x
COPY brain ./brain

WORKDIR /app/apps/x
RUN pnpm install --frozen-lockfile
RUN npm run shared && pnpm --filter @x/core build

ENV BRAIN_HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 8787

WORKDIR /app/brain
CMD ["node", "dist/host/main.js"]
