# Production dependencies stage
FROM oven/bun:latest AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production

# Build stage using Bun
FROM oven/bun:latest AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install
COPY . .

# Next.js compiles telemetry data collection by default.
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# Production runtime image using Node 24 Slim
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd -r nodejs || true
RUN useradd -r -u 1001 -g nodejs -s /usr/sbin/nologin nextjs || true

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=deps /app/node_modules ./node_modules

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
