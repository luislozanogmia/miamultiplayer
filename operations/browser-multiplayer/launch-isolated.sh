#!/usr/bin/env bash
# Dev UI launcher. Does not install, copy credentials, disable authentication,
# disable encryption, or bypass Chromium's sandbox. Existing profiles are refused.
set -euo pipefail
if [[ $# -ne 6 && $# -ne 7 ]]; then
  echo 'Usage: launch-isolated.sh source-tree electron dependency-tree runtime-root data-root port [--resume-isolated]' >&2
  exit 2
fi
test_source=$(realpath "$1")
test_electron=$(realpath "$2")
test_dependencies=$(realpath "$3")
test_runtime=$(realpath "$4")
test_data=$(realpath -m "$5")
test_port=$6
[[ $test_port =~ ^[0-9]+$ ]] && (( test_port > 1024 && test_port < 64000 )) || exit 2
[[ -f "$test_source/macos/src/main.cjs" && -x "$test_electron" && -x "$test_runtime/hermes-launcher" && -x "$test_runtime/hermes/hermes-agent/venv/bin/python" ]] || exit 2
if [[ -e "$test_data" ]]; then
  [[ ${7:-} == --resume-isolated && -f "$test_data/verification-source.txt" && $(<"$test_data/verification-source.txt") == "$test_source" ]] || {
    echo 'Existing data is preserved. Resume requires this launcher’s matching isolated marker.' >&2; exit 2;
  }
fi
umask 077
mkdir -p "$test_data/data" "$test_data/workspace" "$test_data/provider-home" "$test_data/hermes"
printf '%s\n' "$test_source" > "$test_data/verification-source.txt"
unset MIAOS_URL MIAOS_NO_AUTH MIAOS_DESKTOP_NO_AUTH MIAOS_HERMES_GATEWAY_URL MIAOS_HERMES_GATEWAY_TOKEN
export MIA_DEV_DATA_ROOT="$test_data" MIAOS_ENGINEERING_ROOT="$test_source"
export MIAOS_DB_PATH="$test_data/data/mia-os.db" MIAOS_RUNTIME_DIR="$test_data/data"
export MIAOS_ENV_FILE=/dev/null MIAOS_WORKSPACE_DIR="$test_data/workspace"
export MIAOS_ARTIFACT_DIR="$test_data/data/workspace-artifacts" MIAOS_ATTACHMENT_DIR="$test_data/data/attachments"
export MIAOS_BOT_PACKAGE_DIR="$test_data/data/bots" MIAOS_AUTOMATION_ARTIFACT_DIR="$test_data/workspace/bots"
export HERMES_HOME="$test_data/hermes" HERMES_BIN="$test_runtime/hermes-launcher"
export MIAOS_HERMES_BIN="$HERMES_BIN" HERMES_AGENT_ROOT="$test_runtime/hermes/hermes-agent"
export HERMES_PYTHON="$test_runtime/hermes/hermes-agent/venv/bin/python"
export MIAOS_HERMES_GATEWAY_PORT="$((test_port + 1000))" MIAOS_HERMES_PROCESS_HOME="$test_data/provider-home"
export MIAOS_NODE_PATH=/opt/node-v22.22.3/bin/node MIAOS_PORT="$test_port"
export NODE_PATH="$test_dependencies/backend/node_modules:$test_dependencies/macos/node_modules"
export MIAOS_CLERK_INSTANCE=production MIAOS_CLERK_AUTH=1 MIAOS_LOCAL_PROFILE=1
cd "$test_source/macos"
exec "$test_electron" .
