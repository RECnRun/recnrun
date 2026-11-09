#!/bin/sh
# launcher.sh start [<lab>] (--allow <origin>)... | --allow-any [--pair <64 hex>]
#
# The lab launcher of the owner flow (owner-flow plan v3): it bridges the website master in the
# person's own Chrome and one headless worker Chrome on a private root, through files only. It pairs
# with the master key the site writes, reads master-signed launch requests, provisions the worker
# root with the bundled extension, launches the worker, and copies one offer in and one answer out.
# POSIX sh and OS tools only; hashing and signatures go through openssl; nothing read from a file is
# ever run or expanded. <lab> defaults to ~/RECnRun-lab; the site's folder is <lab>/workspace.
#
# Environment: RECNRUN_LAB_TICK_S (1) and RECNRUN_LAB_HEARTBEAT_S (2) pace the loop and the heartbeat,
# RECNRUN_LAB_STOP_S (20) bounds a worker stop, RECNRUN_LAB_INSTALL_S (90) a provisioning,
# RECNRUN_LAB_ANSWER_S (20) the wait for an answer; RECNRUN_LAB_OPENSSL replaces the openssl binary
# and RECNRUN_LAB_BUNDLE the extension folder (checks only).
# Exit: 64 wrong call, 65 a symbolic link in the lab, 70 survivors after the stop (state/stop-failed),
# 73 the lab cannot be written, 75 another launcher holds the lab, 130 SIGINT, 143 SIGTERM.

umask 077
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P) || exit 70
LIB=$(CDPATH='' cd -- "$HERE/../../../../scripts/poc-cross-profile" && pwd -P) || exit 70
# shellcheck source=launcher-base.sh
. "$HERE/launcher-base.sh"

usage() { die 64 "usage: launcher.sh start [<lab>] (--allow <origin>)... | --allow-any [--pair <64 hex>]${1:+: $1}"; }

# An origin the worker compares with URL.origin: http or https, a lowercase host, an optional port.
is_origin() {
  case $1 in http://?* | https://?*) ;; *) return 1 ;; esac
  io_host=${1#*://}
  case $io_host in *:*) io_port=${io_host#*:} io_host=${io_host%%:*} ;; *) io_port=1 ;; esac
  case $io_host in '' | *[!a-z0-9.-]*) return 1 ;; esac
  case $io_port in '' | *[!0-9]*) return 1 ;; esac
}

parse_start() {
  LAB=${HOME:-}/RECnRun-lab
  case ${1:-} in '' | --*) ;; *) LAB=$1 && shift ;; esac
  allow='' allow_any='' PAIR=''
  while [ "$#" -gt 0 ]; do
    case $1 in
      --allow)
        [ "$#" -ge 2 ] && is_origin "$2" || usage "--allow takes an http or https origin"
        allow="$allow${allow:+,}\"$2\""
        shift 2
        ;;
      --allow-any) allow_any=1 && shift ;;
      --pair)
        [ "$#" -ge 2 ] && is_hex "$2" 64 || usage "--pair takes the 64 hex fingerprint"
        PAIR=$2
        shift 2
        ;;
      *) usage "unknown option $1" ;;
    esac
  done
  [ -z "$allow_any" ] || allow='"*"'
  [ -n "$allow" ] || usage 'name the targets with --allow <origin> or --allow-any'
  case $LAB in /*) ;; *) usage 'the lab is not an absolute path' ;; esac
  case $LAB in *[!A-Za-z0-9._/-]* | */../* | */..) usage 'the lab path has a character other than letters, digits, dot, underscore, hyphen, and slash' ;; esac
  ALLOW_JSON="[$allow]"
}

# --- Stop ------------------------------------------------------------------------------------

cleaned=''
survivors=''
cleanup() {
  [ -z "$cleaned" ] || return 0
  cleaned=1
  set_phase stopping
  stop_children
  if [ -n "${hb_pid:-}" ]; then
    kill -TERM "$hb_pid" 2>/dev/null
    wait "$hb_pid" 2>/dev/null
  fi
  rm -f -- "$WS/launcher/heartbeat" "$STATE/session"
  if [ -n "$survivors" ]; then
    printf 'pids=%s\nat=%s\n' "$survivors" "$(date +%s)" | write_atomic "$STATE/stop-failed"
    log "processes still name $LAB/roots after the stop: pids $survivors (state/stop-failed)"
  fi
  release_lock "$STATE/launcher.lock" "$$"
}
on_signal() {
  cleanup
  exit "$1"
}
on_exit() {
  oe_status=$?
  cleanup
  [ -z "$survivors" ] || oe_status=70
  exit "$oe_status"
}

# --- Start -----------------------------------------------------------------------------------

start_launcher() {
  parse_start "$@"
  TICK=$(lab_seconds "${RECNRUN_LAB_TICK_S:-}" 1 RECNRUN_LAB_TICK_S)
  HEARTBEAT_S=$(lab_seconds "${RECNRUN_LAB_HEARTBEAT_S:-}" 2 RECNRUN_LAB_HEARTBEAT_S)
  lab_release
  lab_openssl || die 70 'no openssl found'
  [ -d "$LAB" ] || mkdir -p -- "$LAB" || die 73 "cannot create $LAB"
  [ ! -L "$LAB" ] || die 65 "$LAB is a symbolic link"
  WS=$LAB/workspace STATE=$LAB/state ROOT=$LAB/roots/w1
  lab_layout
  take_lock "$STATE/launcher.lock" "$$"
  trap 'on_signal 130' INT
  trap 'on_signal 143' TERM
  trap on_exit EXIT
  rm -f -- "$STATE/stop-failed"
  SESSION=$(lc_random)
  printf '%s\n' "$SESSION" | write_atomic "$STATE/session"
  set_phase idle
  log "lab $LAB, session $SESSION, launcher $release_version, extension $release_extension, $("$OPENSSL" version 2>&1)"
  recover_launcher
  sh "$HERE/launcher-heartbeat.sh" "$LAB" "$SESSION" "$$" "$HEARTBEAT_S" "$release_version" "$release_extension" \
    </dev/null >/dev/null 2>&1 &
  hb_pid=$!
  while :; do
    lab_tick
    sleep "$TICK"
  done
}

# shellcheck source=launcher-loop.sh
. "$HERE/launcher-loop.sh"

case ${1:-} in
  start) shift && start_launcher "$@" ;;
  *) usage ;;
esac
