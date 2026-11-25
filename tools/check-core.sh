#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_logs="$task_root/../builds/cc-switch-android/logs"
mkdir -p "$task_logs"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CCSWITCH_BUILD_CACHE:-$HOME/cc-switch-android-cache}/target"
cd "$task_root/native"
cargo check "$@" 2>&1 | tee "$task_logs/native-core-check.log"
