#!/usr/bin/env bash
set -euo pipefail

: "${AWS_PROFILE:=buffet-non-prod}"
: "${AWS_REGION:=us-east-1}"
export AWS_PROFILE AWS_REGION

IMAGE_NAME="${IMAGE_NAME:-ok-space}"
WITH_TOKEN=0
EVAL_MODE=0

usage() {
  cat >&2 <<USAGE
Usage: microvm-params.sh [options]

Discovers the running MicroVM (image: \$IMAGE_NAME, default ok-space) and prints
its params: id, endpoint, image ARN/version, duration, started-at, connectors.

Options:
  --id <microvmId>   Inspect a specific VM instead of auto-picking the running one.
  --token            Also mint a 60-min port-9000 proxy token (X-aws-proxy-auth).
  --eval             Emit only 'export VAR=...' lines, so you can load vars into
                     your current shell:   eval "\$(scripts/microvm-params.sh --eval)"
  -h, --help         This help.

Env: AWS_PROFILE (default buffet-non-prod), AWS_REGION (default us-east-1),
     IMAGE_NAME (default ok-space).
USAGE
}

MV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --id) MV="${2:?--id needs a value}"; shift 2 ;;
    --token) WITH_TOKEN=1; shift ;;
    --eval) EVAL_MODE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

log() { [ "$EVAL_MODE" -eq 1 ] || echo "$@" >&2; }

if [ -z "$MV" ]; then
  log "Looking for a RUNNING MicroVM (image $IMAGE_NAME)..."
  MV=$(aws lambda-microvms list-microvms --region "$AWS_REGION" \
    --query 'items[?state==`RUNNING`].microvmId | [0]' --output text)
fi

if [ "$MV" = "None" ] || [ -z "$MV" ]; then
  echo "No RUNNING MicroVM found. Launch one first (run-microvm), then re-run." >&2
  exit 1
fi

J=$(aws lambda-microvms get-microvm --microvm-identifier "$MV" --region "$AWS_REGION" --output json)

MICROVM_ID=$(echo "$J" | jq -r '.microvmId')
STATE=$(echo "$J" | jq -r '.state')
ENDPOINT=$(echo "$J" | jq -r '.endpoint // empty')
IMAGE_ARN=$(echo "$J" | jq -r '.imageArn // empty')
IMAGE_VERSION=$(echo "$J" | jq -r '.imageVersion // empty')
MAX_DURATION=$(echo "$J" | jq -r '.maximumDurationInSeconds // empty')
STARTED_AT=$(echo "$J" | jq -r '.startedAt // empty')
INGRESS=$(echo "$J" | jq -r '.ingressNetworkConnectors // [] | join(",")')
EGRESS=$(echo "$J" | jq -r '.egressNetworkConnectors // [] | join(",")')

TOKEN=""
if [ "$WITH_TOKEN" -eq 1 ]; then
  log "Minting port-9000 proxy token (60 min)..."
  TOKEN=$(aws lambda-microvms create-microvm-auth-token \
    --microvm-identifier "$MICROVM_ID" --expiration-in-minutes 60 \
    --allowed-ports '[{"port":9000}]' --region "$AWS_REGION" \
    --query 'authToken."X-aws-proxy-auth"' --output text)
fi

if [ "$EVAL_MODE" -eq 1 ]; then
  echo "export MV='$MICROVM_ID'"
  echo "export EP='$ENDPOINT'"
  echo "export IMAGE_ARN='$IMAGE_ARN'"
  [ -n "$TOKEN" ] && echo "export TOKEN='$TOKEN'"
  exit 0
fi

echo "microvmId        = $MICROVM_ID"
echo "state            = $STATE"
echo "endpoint         = $ENDPOINT"
echo "imageArn         = $IMAGE_ARN"
echo "imageVersion     = $IMAGE_VERSION"
echo "maxDurationSec   = $MAX_DURATION"
echo "startedAt        = $STARTED_AT"
echo "ingress          = $INGRESS"
echo "egress           = $EGRESS"
if [ -n "$TOKEN" ]; then
  echo "proxyToken(9000) = ${TOKEN:0:24}... (len ${#TOKEN})"
fi
echo
echo "# Load these into your shell:"
echo "#   eval \"\$($0 --eval${WITH_TOKEN:+ --token})\""
if [ -n "$ENDPOINT" ] && [ -n "$TOKEN" ]; then
  echo "# Quick check:"
  echo "#   curl -i \"https://$ENDPOINT/\" -H \"X-aws-proxy-auth: \$TOKEN\" -H \"X-aws-proxy-port: 9000\""
fi
