#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <microvm-id>" >&2
  exit 2
fi

export AWS_PROFILE="${AWS_PROFILE:-buffet-non-prod}"
export AWS_REGION="${AWS_REGION:-us-east-1}"

aws lambda-microvms create-microvm-auth-token \
  --microvm-identifier "$1" \
  --expiration-in-minutes 60 \
  --allowed-ports '[{"port":9000}]' \
  --region "$AWS_REGION" \
  --query 'authToken."X-aws-proxy-auth"' \
  --output text \
  --no-cli-pager
