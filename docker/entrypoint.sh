#!/usr/bin/env bash
set -Eeuo pipefail
: "${TOLUNA_CONTENT_DIR:=/content}"
: "${PORT:=3000}"
: "${HOST:=0.0.0.0}"
: "${GIT_BRANCH:=main}"
export GIT_TERMINAL_PROMPT=0
if [[ -n "${GIT_SSH_KEY_FILE:-}" ]]; then
  [[ -r "$GIT_SSH_KEY_FILE" && -r "${GIT_KNOWN_HOSTS_FILE:-}" ]] || { printf 'Git key and known-hosts files must be readable\n' >&2; exit 1; }
  install -d -m 700 "$HOME/.ssh"
  install -m 600 "$GIT_SSH_KEY_FILE" "$HOME/.ssh/id_deploy"
  install -m 600 "$GIT_KNOWN_HOSTS_FILE" "$HOME/.ssh/known_hosts"
  export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
fi
if [[ -n "${GIT_REPO_URL:-}" ]]; then
  if [[ -d "$TOLUNA_CONTENT_DIR/.git" ]]; then
    [[ "$(git -C "$TOLUNA_CONTENT_DIR" remote get-url origin)" == "$GIT_REPO_URL" ]] || { printf 'Content volume belongs to a different repository; use a separate volume\n' >&2; exit 1; }
    [[ "$(git -C "$TOLUNA_CONTENT_DIR" branch --show-current)" == "$GIT_BRANCH" ]] || { printf 'Content volume belongs to a different branch; use a separate volume\n' >&2; exit 1; }
    git -C "$TOLUNA_CONTENT_DIR" fetch --depth 1 origin "$GIT_BRANCH"
    git -C "$TOLUNA_CONTENT_DIR" -c user.name='Toluna OK' -c user.email='toluna-ok@example.invalid' merge --ff-only FETCH_HEAD
  else
    git clone --depth 1 --branch "$GIT_BRANCH" "$GIT_REPO_URL" "$TOLUNA_CONTENT_DIR"
  fi
fi
[[ -d "$TOLUNA_CONTENT_DIR" ]] || { printf 'Content directory does not exist\n' >&2; exit 1; }
mkdir -p "$TOLUNA_CONTENT_DIR/.ok"
if [[ ! -e "$TOLUNA_CONTENT_DIR/.ok/config.yml" ]]; then
  printf "{}\n" > "$TOLUNA_CONTENT_DIR/.ok/config.yml"
fi
cd "${TOLUNA_CONTENT_DIR}"
if [[ -n "${OK_EXTERNAL_URL:-}" ]]; then
  export OK_EXTERNAL_URL
fi
exec ok start --port "$PORT" --bind "$HOST" --idle-shutdown off
