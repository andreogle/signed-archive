# syntax=docker/dockerfile:1
# Keep in step with mise.toml, so the image runs the Bun version that CI and development use.
ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
# The binary needs only runtime dependencies; the provider list it bundles is already generated in src/.
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN bun run build && mkdir -p /out/data /out/backups

# The compiled binary embeds Bun and links only glibc. The nonroot variant has no shell and runs as uid 65532.
FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=build /src/dist/signed-archive /app/signed-archive
# Named volumes copy these directories, ownership included, the first time they are mounted.
COPY --from=build --chown=65532:65532 /out/data /data
COPY --from=build --chown=65532:65532 /out/backups /backups
ENV NODE_ENV=production DB_PATH=/data/archive.sqlite
ENTRYPOINT ["/app/signed-archive"]
CMD ["archive"]
