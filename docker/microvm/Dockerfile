# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# OpenKnowledge AWS Lambda MicroVM image -- built FROM SOURCE (this repo/fork).
#
# Stage 1 mirrors the repo-root Dockerfile build stage verbatim: it compiles
# the workspace and packs packages/cli into a real .tgz at /out.
#
# Stage 2 is the AWS snapshot-safe microVM runtime. It installs that tgz onto
# al2023-minimal via dnf nodejs24 so npm REBUILDS the native-config napi .node
# binary against this image's own node24 / glibc 2.34 (hence nodejs24-devel).
# No KB content is baked: the snapshot ships an EMPTY /content and selects a
# space at runtime via the AWS /run lifecycle hook (run-hook-server.mjs).
# ---------------------------------------------------------------------------

# -- Stage 1: build + pack (verbatim from the root Dockerfile build stage) ---
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
ENV TURBO_CACHE_DIR=/app/.turbo/cache ELECTRON_SKIP_REBUILD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Disk-constrained one-shot install+build+pack+cleanup, as a SINGLE RUN layer.
# create-microvm-image has no disk-size knob, so PEAK build-disk is bounded by
# what each committed layer costs BuildKit to materialize+compress at export
# (`#28 exporting to image`), which must process EVERY referenced stage's
# layers before discarded stages are pruned. node_modules + .turbo cache +
# packages/native-config/target are multi-GB; if install, build and pack are
# separate RUN layers, each fat tree is committed into its own layer and a later
# `rm` cannot shrink it. Fusing them into one layer means those trees are
# created AND deleted within the same layer, so this layer's committed diff is
# just /out/*.tgz -- the gigabytes never reach the export volume.
# Changes vs the root Dockerfile, each lowers PEAK build-disk:
#   1. No `--mount=type=cache` on the pnpm store. A cache mount in a one-shot
#      build keeps the store (tarballs) AND the extracted node_modules on the
#      same volume -- a 2nd full copy of every package -- then is thrown away.
#      A plain store lets `pnpm store prune` (below) actually reclaim it.
#   2. `--filter @inkeep/open-knowledge...` scopes to the CLI package + its
#      workspace closure (core, server, native-config, app), so `desktop`
#      (Electron) and `docs` (Next) are NOT installed. `recursive-install=false`
#      is REQUIRED for the filter to prune the install: with pnpm's default
#      shared-workspace-lockfile, a bare `--filter` still installs every project
#      (pnpm#7387, #8318); this config is the documented opt-out. Lockfile is
#      read-only, so --frozen-lockfile stays valid.
#   3. `pnpm store prune` drops tarballs no longer referenced after the filtered
#      install, freeing store bytes on the same volume before the build/pack.
#   4. Same-layer cleanup after pack removes node_modules (root + per-package),
#      the .turbo cache, the Rust target/, and every dist/ build output, plus the
#      whole pnpm store, so none survive in this layer's committed diff.
# devDeps are intentionally kept (no --prod): turbo build + pack need them.
RUN pnpm install --frozen-lockfile --filter @inkeep/open-knowledge... --config.recursive-install=false \
 && pnpm store prune \
 && pnpm exec turbo run build --filter=@inkeep/open-knowledge... --env-mode=loose \
 && mkdir /out && pnpm --dir packages/cli pack --pack-destination /out \
 && rm -rf node_modules packages/*/node_modules .turbo packages/*/.turbo \
    packages/*/dist packages/native-config/target "$(pnpm store path)"

# -- Stage 2: AWS Lambda MicroVM runtime -------------------------------------
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# Runtime deps from the AL2023 appstream. nodejs24 == 24.21 / npm 11; the
# -devel package is required because `npm install -g` of the tgz below rebuilds
# the native-config napi .node binary against this image's node24 / glibc 2.34.
RUN dnf install -y nodejs24 nodejs24-npm nodejs24-devel git && dnf clean all

# Install the OpenKnowledge CLI from the tgz packed in stage 1 -- NOT from any
# external image. npm rebuilds the native addon here against this base.
COPY --from=build /out/*.tgz /tmp/
RUN npm install -g /tmp/*.tgz && rm -rf /tmp/*.tgz /root/.npm

# Empty content dir: the snapshot bakes ZERO KB content; a space is cloned at
# runtime by entrypoint.sh after the /run hook delivers per-space env.
RUN mkdir -p /content

# Entrypoint + /run hook server. The hook server is the default process; it
# execs entrypoint.sh with the per-space env it receives over the /run hook.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/microvm/run-hook-server.mjs /usr/local/bin/run-hook-server.mjs
RUN chmod 755 /usr/local/bin/entrypoint.sh

# Runtime env mirrors the root Dockerfile. No `USER node`: AL2023 has no node
# user; running as root is acceptable inside a per-tenant Firecracker VM.
ENV PORT=3000 \
    HOST=0.0.0.0 \
    OK_ALLOW_EXTERNAL=1 \
    OK_READ_ONLY=1 \
    TOLUNA_CONTENT_DIR=/content \
    OK_RUN_HOOK_READY_METHOD=POST \
    OK_RUN_HOOK_READY_PATHS=/aws/lambda-microvms/runtime/v1/ready,/ready \
    OK_RUN_HOOK_PATH=/aws/lambda-microvms/runtime/v1/run

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# AWS Lambda MicroVMs deliver per-space config via the /run lifecycle hook
# payload, not env vars, so the default process is the hook server.
ENTRYPOINT ["node", "/usr/local/bin/run-hook-server.mjs"]
