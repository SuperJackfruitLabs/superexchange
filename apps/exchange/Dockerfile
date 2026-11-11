# SuperExchange, built from the repository root: docker build -f apps/exchange/Dockerfile .
FROM oven/bun:1.2.8-slim
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/exchange/package.json apps/exchange/
RUN bun install --frozen-lockfile --production
COPY apps/exchange/src apps/exchange/src
USER bun
ENV PORT=8795
EXPOSE 8795
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "apps/exchange/src/main.ts"]
