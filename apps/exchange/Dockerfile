# SuperExchange, built from the repository root: docker build -f apps/exchange/Dockerfile .
# Alpine, not slim: the end-to-end encryption binding (@matrix-org/matrix-sdk-crypto-nodejs) needs
# glibc 2.32 or newer, and every Debian image of Bun 1.2.8 is bullseye's 2.31. It ships a musl
# build, which its postinstall fetches here (bun runs it: root package.json trustedDependencies).
FROM oven/bun:1.2.8-alpine
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/exchange/package.json apps/exchange/
RUN bun install --frozen-lockfile --production
COPY apps/exchange/src apps/exchange/src
# The store's directory (SUPEREXCHANGE_DATA_DIR, /data by default), owned by the user the service
# runs as. A named volume mounted here takes this ownership when it is first created. The
# speaker's crypto store lives under it too (crypto/), and must be backed up with the database.
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV PORT=8795
EXPOSE 8795
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "apps/exchange/src/main.ts"]
