#!/bin/sh
# recnrun-launcher.sh <command> [argument ...]
#
# The launcher's commands (POC PLAN.md P4.5), over lifecycle.sh. POSIX sh only, no JSON parser,
# nothing read from a file is ever run or expanded; positional arguments and enumerated flags only.
#
#   start <state-dir> <record> <namespace> [--once]
#       takes the launcher lock, then every RECNRUN_LAUNCHER_INTERVAL_S (10) requests, headed, each
#       profile the record registers in the namespace (lifecycle.sh request). It opens no other
#       profile and leaves a paused or stopped one alone until lifecycle.sh resume (the owner's stop
#       is never undone by the next pass). Exits 73, 75, 69, 71, and 70 of a request are logged, not
#       errors; 65 and 66 are logged once and the profile skipped until the launcher restarts.
#       After the requests of each pass it runs provision.sh once (the master's "Prepare workers" operations,
#       one step per operation, P6.1; exits are logged), then catalog.sh once per distinct downloadsRoot the
#       record registers in the namespace (the extension finds its peers only through the
#       registry.json it writes); its exits are logged, not errors.
#       --once runs one pass; otherwise it runs in the foreground, writes <state-dir>/launcher.pid,
#       and ends cleanly on SIGTERM.
#   status <state-dir>                          "launcher running pid=<n>" or "launcher stopped", then
#                                               lifecycle.sh status
#   stop <state-dir> [--all]                    SIGTERM to the pid in launcher.pid while its command
#                                               line is this script's start on this state dir; --all also stops each profile
#                                               with a live pid (lifecycle.sh stop), except the
#                                               profiles of a shared root, which it names and skips
#   autostart on|off|status <state-dir> <record> <namespace>    see autostart.sh
#
# Not a command of this script: base.sh (create-base, template, quit, freeze, update) prepares the clean
# base of the clones (POC PLAN.md P5.1; update copies a frozen base to the next one, P5.6) and clone.sh (create-clone, list-clones, discard-partial) copies it
# (P5.2); provision.sh (run, status) chains them for the master's "Prepare workers" request (P6.1); clone-open.sh (open-clone) opens and provisions a clone the first time (P5.3), or reopens one
# the record registers; open.sh, first-run.sh, and catalog.sh skip a root base.sh froze and a copy clone.sh has not
# published.
#
# Environment: RECNRUN_LAUNCHER_INTERVAL_S (10), RECNRUN_LIFECYCLE_STOP_S (20), and lifecycle.sh's.
# Exit: 0 done, 64 wrong call, 65 refused, 70 failed, 75 busy (another launcher holds the lock).

la_as_library=${RECNRUN_DISCOVERY_LIB:-}
# shellcheck source=lifecycle.sh
RECNRUN_DISCOVERY_LIB=1 . "$(dirname -- "$0")/lifecycle.sh"
RECNRUN_DISCOVERY_LIB=$la_as_library # a dot keeps its own assignment: give back what this script saw
# shellcheck source=autostart.sh
. "$(dirname -- "$0")/autostart.sh"
la_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
la_script=$la_dir/recnrun-launcher.sh

log() { printf 'recnrun-launcher.sh: %s\n' "$*" >&2; }

# --- The record ------------------------------------------------------------------------------

# Prints the id of the closed block when it belongs to the wanted namespace, once per id.
emit_block() {
  if [ "$rb_ns" != "$rb_want" ] || [ -z "$rb_id" ]; then return 0; fi
  if ! is_v4 "$rb_id"; then
    log "skipped a block: $rb_id is not a lowercase v4 uuid"
    return 0
  fi
  case $rb_seen in *" $rb_id "*) return 0 ;; esac
  rb_seen="$rb_seen$rb_id "
  printf '%s\n' "$rb_id"
}
# Prints the profile ids of the blocks in namespace $2, in record order.
record_profile_ids() {
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then return 1; fi
  [ "$(wc -c <"$1" | tr -d ' ')" -le 65536 ] || return 1
  rb_want=$2 rb_seen=' ' rb_id='' rb_ns=''
  while IFS= read -r rb_line || [ -n "$rb_line" ]; do
    case $rb_line in
      '')
        emit_block
        rb_id='' rb_ns=''
        ;;
      profileId=*) rb_id=${rb_line#*=} ;;
      namespace=*) rb_ns=${rb_line#*=} ;;
    esac
  done <"$1"
  emit_block
}

# Prints each distinct downloadsRoot of the profile blocks in namespace $2, in record order.
emit_root() {
  if [ "$rr_ns" != "$rr_want" ] || [ -z "$rr_dir" ]; then return 0; fi
  if ! is_record_directory "$rr_dir"; then
    log 'skipped a Downloads root that is not a record directory'
    return 0
  fi
  case $rr_seen in *"|$rr_dir|"*) return 0 ;; esac
  rr_seen="$rr_seen$rr_dir|"
  printf '%s\n' "$rr_dir"
}
record_downloads_roots() {
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then return 1; fi
  [ "$(wc -c <"$1" | tr -d ' ')" -le 65536 ] || return 1
  rr_want=$2 rr_seen='|' rr_dir='' rr_ns=''
  while IFS= read -r rr_line || [ -n "$rr_line" ]; do
    case $rr_line in
      '')
        emit_root
        rr_dir='' rr_ns=''
        ;;
      downloadsRoot=*) rr_dir=${rr_line#*=} ;;
      namespace=*) rr_ns=${rr_line#*=} ;;
    esac
  done <"$1"
  emit_root
}

# --- Start -----------------------------------------------------------------------------------

la_child=''
la_skipped=' '
cleanup() {
  [ -z "$la_child" ] || kill -TERM "$la_child" 2>/dev/null
  release_lock "$la_state/launcher.lock" "$$"
  cu_named=''
  if [ -f "$la_state/launcher.pid" ]; then read -r cu_named <"$la_state/launcher.pid" || :; fi
  if [ "$cu_named" = "$$" ]; then rm -f -- "$la_state/launcher.pid"; fi
}
run_lifecycle() { /bin/sh "$la_dir/lifecycle.sh" "$@"; }
# One lifecycle.sh request, in the background so a SIGTERM ends the wait at once.
request_profile() {
  run_lifecycle request "$1" "$2" "$3" "$4" headed &
  la_child=$!
  wait "$la_child"
  rq_code=$?
  la_child=''
  case $rq_code in
    0) ;;
    65 | 66)
      la_skipped="$la_skipped$4 "
      log "$4: exit $rq_code, skipped until the launcher restarts"
      ;;
    69 | 70 | 71 | 73 | 75) log "$4: exit $rq_code, not an error" ;;
    *) log "$4: exit $rq_code" ;;
  esac
}
# One catalog.sh run for the Downloads root $3, in the background so a SIGTERM ends the wait at once.
catalog_root() {
  /bin/sh "$la_dir/catalog.sh" "$1" "$2" "$3/RECnRun/poc/$2" &
  la_child=$!
  wait "$la_child"
  ct_code=$?
  la_child=''
  case $ct_code in
    0) log "catalog.sh for $3: exit 0" ;;
    73 | 75) log "catalog.sh for $3: exit $ct_code, not an error" ;;
    *) log "catalog.sh for $3: exit $ct_code" ;;
  esac
}
# One provision.sh run (the master's "Prepare workers" operations, one step each), in the background so a SIGTERM ends the wait.
run_provision() {
  /bin/sh "$la_dir/provision.sh" run "$1" "$2" "$3" &
  la_child=$!
  wait "$la_child"
  pv_code=$?
  la_child=''
  case $pv_code in 0) ;; 75) log "provision.sh: exit $pv_code, not an error" ;; *) log "provision.sh: exit $pv_code" ;; esac
}
run_catalog() {
  pass_roots=$(record_downloads_roots "$1" "$2") || return 0
  while IFS= read -r pass_root; do
    [ -n "$pass_root" ] || continue
    catalog_root "$1" "$2" "$pass_root"
  done <<EOF
$pass_roots
EOF
}
run_pass() {
  if ! pass_ids=$(record_profile_ids "$2" "$3"); then
    log "cannot read the record $2"
    return 0
  fi
  while IFS= read -r pass_id; do
    [ -n "$pass_id" ] || continue
    case $la_skipped in *" $pass_id "*) continue ;; esac
    request_profile "$1" "$2" "$3" "$pass_id"
  done <<EOF
$pass_ids
EOF
  run_provision "$1" "$2" "$3"
  run_catalog "$2" "$3"
}
cmd_start() {
  la_once=0
  case $# in
    3) ;;
    4)
      [ "$4" = --once ] || die 64 'usage: start <state-dir> <record> <namespace> [--once]'
      la_once=1
      ;;
    *) die 64 'usage: start <state-dir> <record> <namespace> [--once]' ;;
  esac
  state_dir "$1"
  is_namespace "$3" || die 65 'the namespace is not a namespace'
  if ! is_directory "$2" || [ ! -f "$2" ]; then die 65 'the record is not an absolute file'; fi
  la_interval=$(setting "${RECNRUN_LAUNCHER_INTERVAL_S:-}" 10 RECNRUN_LAUNCHER_INTERVAL_S) || exit $?
  [ "$la_interval" -ge 1 ] || die 64 'RECNRUN_LAUNCHER_INTERVAL_S must be at least 1'
  la_state=$1
  take_lock "$1/launcher.lock" "$$"
  trap cleanup EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  printf '%s\n' "$$" >"$1/launcher.pid"
  while :; do
    run_pass "$1" "$2" "$3"
    [ "$la_once" = 0 ] || break
    sleep "$la_interval" &
    la_child=$!
    wait "$la_child" || :
    la_child=''
  done
}

# --- Status and stop -------------------------------------------------------------------------

# Sets lp_pid and succeeds when launcher.pid names a live process running this script's start on state dir $1.
launcher_pid() {
  lp_pid=''
  if [ ! -f "$1/launcher.pid" ] || [ -L "$1/launcher.pid" ]; then return 1; fi
  read -r lp_pid <"$1/launcher.pid" || :
  pid_alive "$lp_pid" || return 1
  lp_cmd=$(ps -o command= -p "$lp_pid" 2>/dev/null)
  case $lp_cmd in *"recnrun-launcher.sh start $1 "*) return 0 ;; esac
  return 1
}
launcher_status() {
  [ "$#" -eq 1 ] || die 64 'usage: status <state-dir>'
  state_dir "$1"
  if launcher_pid "$1"; then printf 'launcher running pid=%s\n' "$lp_pid"; else printf 'launcher stopped\n'; fi
  cmd_status "$1"
}
stop_launcher() {
  if ! launcher_pid "$1"; then
    log 'the launcher is not running'
    return 0
  fi
  kill -TERM "$lp_pid"
  sl_waited=0
  while pid_alive "$lp_pid" && [ "$sl_waited" -lt "$la_stop_s" ]; do
    sleep 1
    sl_waited=$((sl_waited + 1))
  done
  ! pid_alive "$lp_pid" || die 70 "the launcher (pid $lp_pid) still runs after $la_stop_s s"
}
stop_profiles() {
  sp_code=0
  for sp_file in "$1"/profiles/*; do
    sp_name=${sp_file##*/}
    is_v4 "$sp_name" || continue
    read_state "$sp_file"
    pid_alive "$st_pid" || continue
    if [ "$st_shared" = 1 ]; then
      log "$sp_name: $(shared_message)"
      continue
    fi
    run_lifecycle stop "$1" "$sp_name" || sp_code=$?
  done
  return "$sp_code"
}
launcher_stop() {
  la_all=0
  case ${2:-} in '') ;; --all) la_all=1 ;; *) die 64 'usage: stop <state-dir> [--all]' ;; esac
  [ "$#" -le 2 ] || die 64 'usage: stop <state-dir> [--all]'
  la_stop_s=$(setting "${RECNRUN_LIFECYCLE_STOP_S:-}" 20 RECNRUN_LIFECYCLE_STOP_S) || exit $?
  state_dir "$1"
  stop_launcher "$1"
  [ "$la_all" = 0 ] || stop_profiles "$1"
}

if [ -z "$la_as_library" ]; then
  [ "$#" -ge 1 ] || die 64 'usage: recnrun-launcher.sh start|status|stop|autostart ...'
  la_command=$1
  shift
  case $la_command in
    start) cmd_start "$@" ;;
    status) launcher_status "$@" ;;
    stop) launcher_stop "$@" ;;
    autostart) cmd_autostart "$@" ;;
    *) die 64 "unknown command $la_command" ;;
  esac
fi
