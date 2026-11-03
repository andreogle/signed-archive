# syntax=docker/dockerfile:1
# Keep in step with mise.toml, so the image runs the Bun version that CI and development use.
ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
# The binary needs only runtime dependencies. The airnode and feed lists are not bundled; they are copied from config/
# below and read at run time.
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN bun run build && mkdir -p /out/data /out/backups

# The compiled binary embeds Bun and links only glibc. The nonroot variant has no shell and runs as uid 65532.
FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=build /src/dist/signed-archive /app/signed-archive
# The default config: the settings file and, under config/, the airnode and feed lists it names. Mount your own
# copies over them, or set CONFIG.
COPY signed-archive.yaml /app/signed-archive.yaml
COPY config /app/config
# Named volumes copy these directories, ownership included, the first time they are mounted.
COPY --from=build --chown=65532:65532 /out/data /data
COPY --from=build --chown=65532:65532 /out/backups /backups
ENV NODE_ENV=production DB_PATH=/data/archive.sqlite CONFIG=/app/signed-archive.yaml
ENTRYPOINT ["/app/signed-archive"]
CMD ["archive"]
