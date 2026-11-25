#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_tooling="$task_root/../.tooling"
task_cache="${CCSWITCH_BUILD_CACHE:-$HOME/cc-switch-android-cache}"
task_logs="$task_root/../builds/cc-switch-android/logs"
mkdir -p "$task_cache" "$task_logs"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$task_cache/target"
task_ndk="${ANDROID_NDK_HOME:-$task_cache/android-ndk-r29}"
if [[ ! -x "$task_ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android30-clang" ]]; then
    python3 - "$task_tooling/downloads/android-ndk-r29-linux.zip" "$task_cache" <<'PY'
import sys, zipfile, os
with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2])
    for item in archive.infolist():
        mode = item.external_attr >> 16
        if mode & 0o111:
            os.chmod(os.path.join(sys.argv[2], item.filename), mode & 0o777)
PY
fi
# zipfile extracts symlinks as small text files; restore only the archive's
# links whose names and relative targets stay inside this verified NDK cache.
if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
python3 - "$task_tooling/downloads/android-ndk-r29-linux.zip" "$task_cache" <<'PY'
import sys, zipfile, os, stat
from pathlib import Path
root = Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as archive:
    for item in archive.infolist():
        if not stat.S_ISLNK(item.external_attr >> 16):
            continue
        path = root / item.filename
        target = archive.read(item).decode('utf-8')
        if not path.parent.resolve().is_relative_to(root) or not (path.parent / target).resolve().is_relative_to(root):
            raise RuntimeError('NDK symlink escapes cache')
        if path.is_symlink():
            continue
        if path.exists():
            path.unlink()
        path.symlink_to(target)
PY
fi
if ! rustup target list --installed | rg -q '^aarch64-linux-android$'; then
    rustup target add aarch64-linux-android
fi
task_bin="$task_ndk/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$task_bin/aarch64-linux-android30-clang"
export CC_aarch64_linux_android="$task_bin/aarch64-linux-android30-clang"
export AR_aarch64_linux_android="$task_bin/llvm-ar"
export CXX_aarch64_linux_android="$task_bin/aarch64-linux-android30-clang++"
export CARGO_BUILD_JOBS=6
export RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--target=aarch64-linux-android30 --sysroot=$task_ndk/toolchains/llvm/prebuilt/linux-x86_64/sysroot"
task_libclang=$(find /usr/lib/llvm-* -name 'libclang.so*' -print -quit 2>/dev/null || true)
if [[ -z "$task_libclang" ]]; then
    printf '%s\n' 'QuickJS Android bindings require system libclang (libclang-dev).' >&2
    exit 2
fi
export LIBCLANG_PATH=$(dirname -- "$task_libclang")
cd "$task_root/native"
cargo build --release --target aarch64-linux-android "$@" 2>&1 | tee "$task_logs/native-core-android-build.log"
mkdir -p "$task_root/android/app/src/main/jniLibs/arm64-v8a"
cp "$CARGO_TARGET_DIR/aarch64-linux-android/release/libcc_switch_android_core.so" "$task_root/android/app/src/main/jniLibs/arm64-v8a/"
printf 'Native core: %s\n' "$task_root/android/app/src/main/jniLibs/arm64-v8a/libcc_switch_android_core.so"
