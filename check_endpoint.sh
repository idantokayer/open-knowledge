
#!/usr/bin/env bash
set -euo pipefail

# ==========================================
# Configuration
# ==========================================
export AWS_PROFILE="buffet-non-prod"
export AWS_REGION="us-east-1"

IMAGE="ok-space"
IMAGE_VERSION="1.0"
AWS_ACCOUNT_ID="603106382807"
IMAGE_ARN="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:microvm-image:${IMAGE}"
APP_PORT=3000
HOOK_PORT=9000
MAX_DURATION=3600
TOKEN_EXPIRATION=60

ALL_INGRESS="arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS"
LOG_GROUP="/aws/lambda-microvms/${IMAGE}"

GIT_REPO="https://github.com/idantokayer/open-knowledge"
GIT_BRANCH="fix/microvm-runhook-payload-unwrap"
EXTERNAL_URL="https://ok.snake-release-non-prod.toluna.me"

echo "=========================================="
echo " OpenKnowledge MicroVM Deployment"
echo "=========================================="

# ==========================================
# Step 1 - Verify image and RUN hook
# ==========================================
echo "[1/6] Checking MicroVM image..."

IMAGE_INFO=$(aws lambda-microvms get-microvm-image \
  --image-identifier "$IMAGE_ARN" \
  --region "$AWS_REGION" \
  --output json)

echo "$IMAGE_INFO" | jq -e '
  .state == "CREATED"
' >/dev/null || {
  echo "ERROR: image state is not CREATED (got: $(echo "$IMAGE_INFO" | jq -r '.state // "unknown"')). Rebuild or wait."
  exit 1
}

echo "Image is CREATED and usable."

# ==========================================
# Step 2 - Launch MicroVM
# ==========================================
echo "[2/6] Launching MicroVM..."

RUN_PAYLOAD=$(jq -nc \
  --arg repo "$GIT_REPO" \
  --arg branch "$GIT_BRANCH" \
  --arg url "$EXTERNAL_URL" \
  '{
    gitRepoUrl: $repo,
    gitBranch: $branch,
    externalUrl: $url
  }')

RUN_RESPONSE=$(aws lambda-microvms run-microvm \
  --image-identifier "$IMAGE_ARN" \
  --ingress-network-connectors "$ALL_INGRESS" \
  --maximum-duration-in-seconds "$MAX_DURATION" \
  --run-hook-payload "$RUN_PAYLOAD" \
  --client-token "ok-space-$(date +%s)" \
  --region "$AWS_REGION" \
  --output json)

MVM_ID=$(echo "$RUN_RESPONSE" | jq -r '.microvmId // empty')
ENDPOINT=$(echo "$RUN_RESPONSE" | jq -r '.endpoint // empty')

if [[ -z "$MVM_ID" || -z "$ENDPOINT" ]]; then
  echo "ERROR: Missing MicroVM ID or endpoint."
  echo "$RUN_RESPONSE" | jq .
  exit 1
fi

echo "MicroVM ID: $MVM_ID"
echo "Endpoint: $ENDPOINT"

# ==========================================
# Step 3 - Wait for RUNNING
# ==========================================
echo "[3/6] Waiting for MicroVM..."

RUNNING=false

for i in {1..30}; do
  STATE_RESPONSE=$(aws lambda-microvms get-microvm \
    --microvm-identifier "$MVM_ID" \
    --region "$AWS_REGION" \
    --output json)

  STATE=$(echo "$STATE_RESPONSE" | jq -r '.state // "UNKNOWN"')
  REASON=$(echo "$STATE_RESPONSE" | jq -r '.stateReason // ""')

  echo "Attempt $i: $STATE ${REASON:+- $REASON}"

  if [[ "$STATE" == "RUNNING" ]]; then
    RUNNING=true
    break
  fi

  if [[ "$STATE" =~ ^(TERMINATED|FAILED|STOPPED)$ ]]; then
    echo "MicroVM stopped unexpectedly."
    break
  fi

  sleep 2
done

# ==========================================
# Step 4 - Create authentication token
# ==========================================
if [[ "$RUNNING" == true ]]; then
  echo "[4/6] Creating proxy authentication token..."

  PROXY_AUTH=$(aws lambda-microvms create-microvm-auth-token \
    --microvm-identifier "$MVM_ID" \
    --expiration-in-minutes "$TOKEN_EXPIRATION" \
    --allowed-ports "[{\"port\":${HOOK_PORT}}]" \
    --region "$AWS_REGION" \
    --query 'authToken."X-aws-proxy-auth"' \
    --output text)

  echo "Token generated (length: ${#PROXY_AUTH})"

  # ========================================
  # Step 5 - Test HTTP endpoint
  # ========================================
  echo "[5/6] Testing OpenKnowledge..."

  curl -i --max-time 20 \
    "https://${ENDPOINT}/" \
    -H "X-aws-proxy-auth: ${PROXY_AUTH}" \
    -H "X-aws-proxy-port: ${HOOK_PORT}" || true
else
  echo "[4/6] Skipped token creation."
  echo "[5/6] Skipped HTTP test."
fi

# ==========================================
# Step 6 - Retrieve CloudWatch logs
# ==========================================
echo
echo "[6/6] Retrieving MicroVM logs..."

STREAM=$(aws logs describe-log-streams \
  --log-group-name "$LOG_GROUP" \
  --order-by LastEventTime \
  --descending \
  --max-items 1 \
  --region "$AWS_REGION" \
  --query 'logStreams[0].logStreamName' \
  --output text 2>/dev/null || true)

if [[ -n "$STREAM" && "$STREAM" != "None" ]]; then
  aws logs get-log-events \
    --log-group-name "$LOG_GROUP" \
    --log-stream-name "$STREAM" \
    --start-from-head \
    --region "$AWS_REGION" \
    --query 'events[].message' \
    --output text
else
  echo "No CloudWatch log stream found."
fi

echo
echo "=========================================="
echo " MicroVM Summary"
echo "=========================================="
echo "ID:       $MVM_ID"
echo "State:    $STATE"
echo "Endpoint: https://$ENDPOINT/"
echo "App port: $APP_PORT"
echo "=========================================="

