# kb.toluna.me — Production Ingress Architecture

Status: DECIDED (design) · Routing model: subdomain-per-space · Date: 2026-10-19
Scope: Toluna-internal deployment design. Not part of the published OpenKnowledge docs site.
Account: 603106382807 · Region: us-east-1 · Profile: buffet-non-prod

This document is the agreed target architecture for serving Toluna's read-only
OpenKnowledge knowledge bases to a browser over a stable hostname. It supersedes
the earlier scratch `docs/ingress-feasibility.md`.

## Goal

Replace the proof-of-concept access path (random per-launch MicroVM endpoints
reached through a local header-injecting proxy) with a stable, browsable,
production ingress: one subdomain per knowledge-base space, each backed by its
own read-only OpenKnowledge MicroVM that clones markdown-from-git. Git remains
the single source of truth; the browser is a read-only view.

## Routing model: subdomain-per-space (DECIDED)

Each space is a subdomain of `kb.toluna.me`:

- `plm.kb.toluna.me` -> MicroVM serving the PLM knowledge repo
- `platform.kb.toluna.me` -> MicroVM serving the Platform repo
- `support.kb.toluna.me` -> MicroVM serving the Support repo

Subdomain-per-space was chosen over path-prefix routing (`kb.toluna.me/plm/`)
because:

- Each MicroVM serves OpenKnowledge at `/` with its own external URL, so there
  is NO OpenKnowledge code change required.
- It sidesteps the asset/SPA breakage of path routing: OpenKnowledge serves a
  single-page app with root-absolute asset and API paths (`/assets/...`,
  `/api/...`, `/collab`), and the web build fixes its asset base at build time
  (Vite `base: './'` in `packages/app/vite.config.ts`). Serving it under a path
  prefix would require a multi-surface `server.basePath` feature in core
  (schema + env + Vite base + index.html base-href + server route matching in
  `http-app.ts`, `content-dispatch.ts`, `collaboration-host.ts` + client
  `client-fetch.ts`, `cc1.ts`). Subdomain routing needs none of it.
- The app host guard is satisfied trivially: each MicroVM sees its own real
  host (its subdomain) as the request `Host`, which equals its own derived
  external URL.

Trade-off accepted: a wildcard certificate for `*.kb.toluna.me` and one DNS
record per space, versus a single hostname. Path-prefix remains a future option
only if a single hostname becomes a hard requirement, and only after funding the
`server.basePath` upstream feature.

## Request path

```
Browser (plain HTTPS, no auth headers)
  -> Route53: *.kb.toluna.me (alias)
  -> CloudFront distribution (wildcard ACM cert in us-east-1)
       -> CloudFront Function (viewer-request):
            read the space directory (CloudFront KVS) keyed by the request host,
            resolve the space, stamp a non-secret header (x-ok-space / x-ok-origin)
       -> Lambda@Edge (origin-request):
            read the space's proxy token from Secrets Manager (short warm cache),
            inject X-aws-proxy-auth + X-aws-proxy-port: 9000,
            rewrite the origin to the space's current MicroVM endpoint
  -> MicroVM :9000 (run-hook server)
       -> OpenKnowledge app :3000 (OK_READ_ONLY=1)
            -> git clone of the space repo into /content
```

### Why the edge is two functions, not one

A CloudFront Function can read KVS and mutate request headers, but it runs only
on viewer-request/viewer-response and has no network access. It therefore CANNOT
rewrite the origin (an origin-request concern) and CANNOT read Secrets Manager.
Lambda@Edge runs on origin-request and can do both, but CANNOT read KVS.

The split follows from these constraints:

- CloudFront Function (viewer-request): read KVS, classify the space from the
  host, hand off via a non-secret header. Keeps the secret out of the Function.
- Lambda@Edge (origin-request): consume the header, read the token from Secrets
  Manager, inject the proxy headers, rewrite the origin to the MicroVM endpoint.

## Space directory (CloudFront KVS)

- Key: the space host, e.g. `plm.kb.toluna.me`.
- Value (JSON string, under the 1 KB KVS per-value limit): non-secret routing
  only.

```json
{
  "originDomain": "<random>.lambda-microvm.us-east-1.on.aws",
  "secretId": "kb/plm/proxy-token",
  "gitRepoUrl": "git@github.com:toluna/plm-kb.git",
  "gitBranch": "main",
  "readOnly": true,
  "microvmId": "microvm-..."
}
```

The proxy token is NOT stored in KVS. KVS limits (value 1 KB, key 512 B, store
5 MB) and its eventually-consistent edge propagation make it the wrong home for
a secret that rotates every under-60 minutes. KVS holds only the Secrets Manager
pointer (`secretId`) and the current `originDomain`.

A CloudFront Function can only READ KVS. Writes go through the control plane
(`cloudfront-keyvaluestore PutKey`), an ETag-guarded optimistic-concurrency API:
read the ETag, write with it, retry on conflict.

Adding a space = one KVS key write (plus launching its MicroVM and seeding its
Secrets Manager token). Removing a space = delete the KVS key + terminate the
MicroVM.

## Token lifecycle

- The proxy token (`X-aws-proxy-auth`) authorizes the AWS MicroVM proxy front
  door. It is minted by `aws lambda-microvms create-microvm-auth-token`
  (max TTL 60 minutes) pinned to port 9000.
- A refresher (EventBridge Scheduler -> Lambda) mints a fresh token per live
  MicroVM and writes it to that space's Secrets Manager secret before expiry.
  Cadence: every ~30 minutes against the 60-minute TTL, giving a ~30-minute
  safety margin and token overlap.
- Lambda@Edge reads the secret per request with a short warm cache (TTL shorter
  than the token life). Rotation vs in-flight races are bounded by that cache
  TTL, not by KVS propagation, because both old and new tokens are valid during
  the overlap window.
- Staleness behavior: the edge never serves stale CONTENT. If a token is expired
  (a missed refresh), the AWS proxy returns an auth failure, surfaced as a
  5xx-class error that self-heals on the next refresh. The token gates the
  proxy, not the cache.

Refresher IAM (least privilege): `lambda-microvms:CreateMicrovmAuthToken`,
`lambda-microvms:GetMicrovm`/`ListMicrovms`, `secretsmanager:PutSecretValue`
on the per-space secret ARNs, and (only when an endpoint changes)
`cloudfront-keyvaluestore:DescribeKeyValueStore` + `PutKey` on the KVS ARN.

## MicroVM pool controller

A scheduled Lambda (not Step Functions, not a standing ECS service) owns the
pool: one MicroVM per space, each launched from the `ok-space` image with its
`/run` payload (`gitRepoUrl`, `gitBranch`, and for private repos `gitSshKey` +
`gitKnownHosts`; `externalUrl` set to the space subdomain).

MicroVM `maximum-duration-in-seconds` is up to 8 hours (not 30 minutes), so
relaunch cadence is measured in hours. Relaunch is blue-green per space to avoid
a serving gap:

1. Before the running MicroVM hits its max duration, launch a replacement for
   the same space.
2. Wait for `RUNNING` + a healthy `/readyz` (the run-hook `503 starting -> 200`
   sequence).
3. Mint the replacement's token into Secrets Manager, then flip the KVS
   `originDomain` to the new endpoint (one atomic PutKey).
4. After propagation + in-flight drain, terminate the old MicroVM.

The random-endpoint-per-launch property is therefore a non-event at the edge:
the only edge-visible change per relaunch is one KVS `originDomain` update,
gated behind a healthy replacement.

## Caching

- `/assets/*`: a dedicated cacheable behavior, path-only cache key, long TTL.
  The viewer sends no auth; Lambda@Edge attaches the proxy token only on the
  ORIGIN fetch (cache miss). Cached responses are served auth-free from the edge.
  This eliminates the asset-request burst that triggered HTTP 429 through the
  PoC local proxy.
- Dynamic routes: caching effectively disabled; the token is attached per
  origin request.
- WebSocket (`/collab`, live editing): a no-cache behavior with the token
  forwarded. Moot while read-only, but kept out of the cached behavior.

## Posture

- Markdown-only: preserved. Content is `.md`/`.mdx` + YAML frontmatter cloned
  from each space's git repo. The KVS directory is routing metadata, not content.
- Read-only: `OK_READ_ONLY=1` is enforced whole-instance in the app. Edge-level
  verb blocking (using the KVS `readOnly` flag) is optional defense-in-depth,
  not the enforcement point.
- Change surface: the edge (CloudFront, KVS, Function, Lambda@Edge, refresher,
  pool controller, Route53/ACM) is new Toluna-owned infrastructure. The chosen
  subdomain model requires NO OpenKnowledge code change.

## Open items before build

Must measure or confirm:

- CloudFront KVS PutKey -> edge propagation latency. No AWS SLA is published;
  measure empirically in-account. It gates the refresher cadence and the
  blue-green cutover timing.
- Which AWS account owns the `toluna.me` Route53 hosted zone.

Human / account actions (no agent execution):

- Request + DNS-validate a wildcard ACM certificate for `*.kb.toluna.me` in
  us-east-1 (CloudFront requires us-east-1 certs).
- Confirm the Route53 hosted zone and add the `*.kb.toluna.me` alias to the
  distribution.
- Create IAM roles for the refresher and pool-controller Lambdas.
- Approve Secrets-Manager-holds-token (recommended) as the token store.

## Provenance

Design produced by the OpenKnowledge crew on 2026-10-19:

- Control-flow + contract, host-guard reconciliation: architecture review
  against `docker/microvm/run-hook-server.mjs`, `packages/server/src/ingress-policy.ts`,
  `packages/server/src/http/http-app.ts`.
- AWS feasibility (edge compute split, KVS limits, token refresher, pool
  controller, caching, Route53/ACM): verified against AWS documentation.
- Base-path capability check that drove the subdomain decision: verified against
  `packages/app/vite.config.ts`, `packages/server/src/http/content-dispatch.ts`,
  `packages/core` config schema, and `packages/cli/src/commands/start.ts`.
