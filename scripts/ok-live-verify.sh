#!/usr/bin/env bash
set -euo pipefail
export AWS_PROFILE=buffet-non-prod AWS_REGION=us-east-1

KEY_FILE="$HOME/.ssh/deploy_key"
REPO='git@github.com:idantokayer/knowledge-base.git'
BRANCH='main'
IMAGE_ARN='arn:aws:lambda:us-east-1:603106382807:microvm-image:ok-space'
ALL_INGRESS='arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:SHELL_INGRESS'
BASE_PATH="${OK_BASE_PATH:-}"
if [ "$BASE_PATH" = "/" ]; then BASE_PATH=""; fi

[ -r "$KEY_FILE" ] || { echo "key not readable: $KEY_FILE" >&2; exit 1; }

# Build the /run payload with the key read FROM THE FILE (never pasted).
# jq --rawfile reads the file verbatim into a JSON string (preserves newlines).
KNOWN_HOSTS="$(ssh-keyscan -t ed25519 github.com 2>/dev/null | grep '^github.com')"
PAYLOAD="$(jq -cn \
  --arg repo "$REPO" --arg branch "$BRANCH" \
  --arg basePath "$BASE_PATH" \
  --rawfile key "$KEY_FILE" --arg hosts "$KNOWN_HOSTS" \
  '{gitRepoUrl:$repo, gitBranch:$branch, basePath:$basePath, gitSshKey:$key, gitKnownHosts:$hosts}')"

echo "payload bytes: ${#PAYLOAD} (must be < 4096)"
[ "${#PAYLOAD}" -lt 4096 ] || { echo "payload too big" >&2; exit 1; }

R=$(aws lambda-microvms run-microvm \
  --image-identifier "$IMAGE_ARN" \
  --ingress-network-connectors "$ALL_INGRESS" \
  --maximum-duration-in-seconds 3600 \
  --run-hook-payload "$PAYLOAD" \
  --idle-policy '{
    "autoResumeEnabled": true,
    "maxIdleDurationSeconds": 900,
    "suspendedDurationSeconds": 1800
  }' \
  --client-token "kblive-$(date +%s)" \
  --region us-east-1 --output json)
MV=$(echo "$R" | jq -r '.microvmId')
echo "microvmId = $MV"

echo "waiting for RUNNING..."
for i in $(seq 1 40); do
  S=$(aws lambda-microvms get-microvm --microvm-identifier "$MV" --region us-east-1 --query 'state' --output text)
  echo "  state: $S"; [ "$S" = "RUNNING" ] && break; sleep 4
done
EP=$(aws lambda-microvms get-microvm --microvm-identifier "$MV" --region us-east-1 --query 'endpoint' --output text)
echo "endpoint = $EP"

TOKEN=$(aws lambda-microvms create-microvm-auth-token \
  --microvm-identifier "$MV" --expiration-in-minutes 60 \
  --allowed-ports '[{"port":9000}]' --region us-east-1 \
  --query 'authToken."X-aws-proxy-auth"' --output text)

PROBE_PATH="${BASE_PATH}/"
echo "polling GET ${PROBE_PATH} (503 while it clones the private repo + boots, then 200)..."
for i in $(seq 1 60); do
  C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://${EP}${PROBE_PATH}" \
    -H "X-aws-proxy-auth: ${TOKEN}" -H "X-aws-proxy-port: 9000")
  echo "  attempt $i: HTTP $C"; [ "$C" = "200" ] && break; sleep 10
done

echo "==== RESULT ===="
curl -s -i --max-time 20 "https://${EP}${PROBE_PATH}" \
  -H "X-aws-proxy-auth: ${TOKEN}" -H "X-aws-proxy-port: 9000" | grep -iE '^HTTP/|^content-type|<title>'
echo
echo "microvmId=$MV  endpoint=$EP"
echo "terminate when done:  aws lambda-microvms terminate-microvm --microvm-identifier $MV --region us-east-1"
