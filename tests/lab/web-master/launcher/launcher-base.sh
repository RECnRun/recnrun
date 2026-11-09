#!/bin/sh
# Shared helpers of launcher.sh: the shims lifecycle-state.sh expects, grammars, and atomic writes.
# Sourced with HERE (this folder) and LIB (scripts/poc-cross-profile) set.

log() {
  printf 'launcher: %s\n' "$*" >&2
  [ -z "${STATE:-}" ] || printf '%s %s\n' "$(date +%s)" "$*" >>"$STATE/launcher.log" 2>/dev/null || :
}
die() {
  d_status=$1
  shift
  log "$*"
  exit "$d_status"
}
system_name() { printf '%s' "${RECNRUN_DISCOVERY_UNAME:-$(uname -s)}"; }
default_root() {
  [ -n "${HOME:-}" ] || return 0
  if [ "$(system_name)" = Darwin ]; then
    printf '%s\n' "$HOME/Library/Application Support/Google/Chrome"
  else
    printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome"
  fi
}
is_runnable() { [ -f "$1" ] && [ -x "$1" ]; }
# The same lookup as profiles.sh chrome_binary, which this launcher does not source.
lab_chrome() {
  lc_prefix=${RECNRUN_DISCOVERY_PREFIX:-}
  if [ "$(system_name)" = Darwin ]; then
    lc_app='Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    for lc_candidate in "$lc_prefix/$lc_app" "${HOME:-/nonexistent}/$lc_app"; do
      if is_runnable "$lc_candidate"; then printf '%s\n' "$lc_candidate" && return 0; fi
    done
    return 66
  fi
  for lc_name in google-chrome-stable google-chrome; do
    lc_found=$(command -v "$lc_name") || continue
    case $lc_found in /*) printf '%s\n' "$lc_found" && return 0 ;; esac
  done
  if is_runnable "$lc_prefix/opt/google/chrome/chrome"; then printf '%s\n' "$lc_prefix/opt/google/chrome/chrome" && return 0; fi
  return 66
}

# shellcheck source=../../../../scripts/poc-cross-profile/lifecycle-state.sh
. "$LIB/lifecycle-state.sh"
# shellcheck source=launcher-crypto.sh
. "$HERE/launcher-crypto.sh"

is_hex() {
  [ "${#1}" -eq "$2" ] || return 1
  case $1 in *[!0-9a-f]*) return 1 ;; esac
}
lab_is_uuid() {
  case $1 in ????????-????-????-????-????????????) ;; *) return 1 ;; esac
  case $1 in *[!0-9a-f-]*) return 1 ;; esac
}
plain_file() { [ -f "$1" ] && [ ! -L "$1" ]; }
file_size() { wc -c <"$1" | tr -d ' '; }
# Seconds as a whole or decimal number, for the tick settings.
lab_seconds() {
  ls_value=${1:-$2}
  case $ls_value in '' | .* | *.*.* | *[!0-9.]*) die 64 "$3 must be a number of seconds" ;; esac
  printf '%s\n' "$ls_value"
}

# Writes stdin to $1 through a dotfile in the same folder, so a reader never sees a partial file.
write_atomic() {
  wa_tmp=${1%/*}/.${1##*/}.$$.tmp
  cat >"$wa_tmp" || return 1
  mv -f -- "$wa_tmp" "$1"
}
set_phase() { printf '%s\n' "$1" | write_atomic "$STATE/phase"; }

# Every folder below LAB, made private; a symbolic link anywhere on the way is refused.
lab_layout() {
  for ll_dir in workspace workspace/launcher workspace/pairing workspace/requests workspace/status \
    workspace/peers workspace/peers/w1 workspace/exchange workspace/exchange/w1 roots \
    state state/claims state/inbox state/pids; do
    no_link_below "$LAB" "$ll_dir" || die 65 "$LAB/$ll_dir is a symbolic link"
    [ -d "$LAB/$ll_dir" ] || mkdir -- "$LAB/$ll_dir" || die 73 "cannot create $LAB/$ll_dir"
  done
}

lab_release() {
  RELEASE_VERSION='' RELEASE_EXTENSION=''
  while IFS= read -r lr_line || [ -n "$lr_line" ]; do
    case $lr_line in
      version=*) RELEASE_VERSION=${lr_line#version=} ;;
      extensionVersion=*) RELEASE_EXTENSION=${lr_line#extensionVersion=} ;;
    esac
  done <"$HERE/RELEASE"
  for lr_value in "$RELEASE_VERSION" "$RELEASE_EXTENSION"; do
    case $lr_value in '' | *[!0-9.]*) die 70 "$HERE/RELEASE has no plain version and extensionVersion" ;; esac
  done
}
