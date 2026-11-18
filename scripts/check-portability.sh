#!/usr/bin/env bash
# Static check of host scripts for macOS-incompatible constructs, then (when
# AFK_MACOS_COMPAT_DIR exists) re-run the host-script tests with BSD awk first
# on PATH and TMPDIR a symlink.
set -euo pipefail

SCRIPTS_DIR=$(cd "$(dirname "$0")" && pwd)

# Host scripts run on a Mac. Sandbox scripts run inside the Linux sandbox.
HOST_SCRIPTS="up.sh restart.sh canary.sh drill.sh check-sandbox-image.sh verify-sandbox-image.sh"
SANDBOX_SCRIPTS="pg-temp.sh install-deps.sh rebase-migrations.sh check-portability.sh"

in_list() {
  _needle=$1
  shift
  for _item in "$@"; do
    [ "$_item" = "$_needle" ] && return 0
  done
  return 1
}

line_has() {
  case "$1" in
    *"$2"*) return 0 ;;
  esac
  return 1
}

report() {
  printf '%s:%s: %s — %s\n' "$1" "$2" "$3" "$4"
  static_failed=1
}

# Rules live here: substring (or the special cases below), each with a reason.
scan_file() {
  _rel=scripts/$(basename "$1")
  _lineno=0
  while IFS= read -r _line || [ -n "$_line" ]; do
    _lineno=$((_lineno + 1))
    case "$_line" in
      *"# portable:"*) continue ;;
    esac
    if line_has "$_line" "/proc/"; then
      report "$_rel" "$_lineno" "/proc/" "macOS 没有 procfs"
    fi
    if line_has "$_line" "wait -n"; then
      report "$_rel" "$_lineno" "wait -n" "macOS 自带 bash 3.2 没有 wait -n"
    fi
    if line_has "$_line" "declare -A"; then
      report "$_rel" "$_lineno" "declare -A" "bash 3.2 没有关联数组"
    fi
    if line_has "$_line" "local -A"; then
      report "$_rel" "$_lineno" "local -A" "bash 3.2 没有关联数组"
    fi
    if line_has "$_line" "mapfile"; then
      report "$_rel" "$_lineno" "mapfile" "bash 3.2 没有 mapfile"
    fi
    if line_has "$_line" "readarray"; then
      report "$_rel" "$_lineno" "readarray" "bash 3.2 没有 readarray"
    fi
    if printf '%s\n' "$_line" | grep -Eq '\$\{[^}]*,,[^}]*\}'; then
      report "$_rel" "$_lineno" '${var,,}' "bash 3.2 没有大小写替换"
    fi
    if printf '%s\n' "$_line" | grep -Eq '\$\{[^}]*\^\^[^}]*\}'; then
      report "$_rel" "$_lineno" '${var^^}' "bash 3.2 没有大小写替换"
    fi
    if line_has "$_line" "|&"; then
      report "$_rel" "$_lineno" "|&" "bash 3.2 没有 |&"
    fi
    if line_has "$_line" "&>>"; then
      report "$_rel" "$_lineno" "&>>" "bash 3.2 没有 &>>"
    fi
    if line_has "$_line" "readlink -f"; then
      report "$_rel" "$_lineno" "readlink -f" "macOS 的 readlink 没有 -f"
    fi
    if line_has "$_line" "realpath"; then
      report "$_rel" "$_lineno" "realpath" "macOS 没有 realpath"
    fi
    if line_has "$_line" "sed -i"; then
      case "$_line" in
        *"sed -i ''"* | *"sed -i''"* | *"sed -i."* | *"sed -i \"\""*) ;;
        *) report "$_rel" "$_lineno" "sed -i" "macOS 的 sed -i 需要空字符串后缀" ;;
      esac
    fi
    if line_has "$_line" "date -d"; then
      report "$_rel" "$_lineno" "date -d" "macOS 的 date 没有 -d"
    fi
    if line_has "$_line" "stat -c"; then
      report "$_rel" "$_lineno" "stat -c" "macOS 的 stat 没有 -c"
    fi
    if line_has "$_line" "grep -P"; then
      report "$_rel" "$_lineno" "grep -P" "macOS 的 grep 没有 -P"
    fi
    if line_has "$_line" "xargs -r"; then
      report "$_rel" "$_lineno" "xargs -r" "macOS 的 xargs 没有 -r"
    fi
    if line_has "$_line" "-printf"; then
      report "$_rel" "$_lineno" "find -printf" "macOS 的 find 没有 -printf"
    fi
    if line_has "$_line" "base64 -w"; then
      report "$_rel" "$_lineno" "base64 -w" "macOS 的 base64 没有 -w"
    fi
    if line_has "$_line" "timeout "; then
      report "$_rel" "$_lineno" "timeout" "macOS 没有 coreutils 的 timeout"
    fi
    if line_has "$_line" "setsid"; then
      report "$_rel" "$_lineno" "setsid" "macOS 没有 setsid"
    fi
  done < "$1"
}

static_failed=0

for _path in "$SCRIPTS_DIR"/*.sh; do
  [ -f "$_path" ] || continue
  _base=$(basename "$_path")
  if ! in_list "$_base" $HOST_SCRIPTS $SANDBOX_SCRIPTS; then
    printf 'scripts/%s: unclassified — add it to the host or sandbox list in check-portability.sh\n' "$_base"
    static_failed=1
    continue
  fi
  if in_list "$_base" $HOST_SCRIPTS; then
    scan_file "$_path"
  fi
done

# Host-script tests re-run under BSD awk + symlink TMPDIR. Defined in one place.
COMPAT_TESTS="packages/cli/src/up-sh.test.ts packages/cli/src/canary-sh.test.ts"

compat_dir="${AFK_MACOS_COMPAT_DIR:-/opt/macos-compat/bin}"
compat_failed=0
compat_real=""
compat_link=""
cleanup_compat() {
  if [ -n "$compat_link" ]; then
    rm -f "$compat_link"
  fi
  if [ -n "$compat_real" ]; then
    rm -rf "$compat_real"
  fi
}
trap cleanup_compat EXIT

if [ -d "$compat_dir" ]; then
  REPO_ROOT=$(cd "$SCRIPTS_DIR/.." && pwd)
  _tmp_root="${TMPDIR:-/tmp}"
  compat_real=$(mktemp -d "${_tmp_root%/}/afk-macos-tmp.XXXXXX")
  compat_link="${compat_real}.lnk"
  ln -s "$compat_real" "$compat_link"
  if ! (
    cd "$REPO_ROOT"
    PATH="$compat_dir:$PATH"
    TMPDIR="${compat_link}/"
    export PATH TMPDIR
    pnpm test $COMPAT_TESTS
  ); then
    compat_failed=1
  fi
  cleanup_compat
  compat_real=""
  compat_link=""
else
  printf 'macos-compat: skipped (no %s in this image)\n' "$compat_dir"
fi

if [ "$static_failed" -ne 0 ] || [ "$compat_failed" -ne 0 ]; then
  exit 1
fi
exit 0
