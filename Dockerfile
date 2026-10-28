FROM rust:1-bookworm AS rust
FROM node:24-bookworm-slim AS build
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.8.1
WORKDIR /app
COPY . .
ENV TURBO_CACHE_DIR=/app/.turbo/cache ELECTRON_SKIP_REBUILD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@inkeep/open-knowledge... --env-mode=loose
RUN mkdir /out && pnpm --dir packages/cli pack --pack-destination /out

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /tmp/package
RUN npm install --global /tmp/package/*.tgz && rm -rf /tmp/package /root/.npm
RUN mkdir /content && chown node:node /content
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
USER node
WORKDIR /content
ENV TOLUNA_CONTENT_DIR=/content PORT=3000 HOST=0.0.0.0 OK_ALLOW_EXTERNAL=1 OK_READ_ONLY=1
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
