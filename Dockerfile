# Build stage using Bun
FROM oven/bun:latest AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install

COPY . .

# Next.js compiles telemetry data collection by default.
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# Production runtime image using Distroless Node 24
FROM gcr.io/distroless/nodejs:24 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
