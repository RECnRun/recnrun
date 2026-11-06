#!/bin/sh
# clone-control.sh run <state-dir> <record> <namespace>
#
# The launcher's "Control clones" step (POC PLAN.md P7.5): the dashboard of the master opens a clone
# headless or visible, closes it, or reopens it in the other mode. POSIX sh only, no JSON parser,
# nothing read from a file is ever run or expanded; positional arguments only. Source it with
# RECNRUN_DISCOVERY_LIB=1 for the functions.
#
# `run` finds the one block of the record with role=master in the namespace (none or several: logged,
# exit 0), makes <master downloadsRoot>/RECnRun/poc/<ns>/control/ when it is a plain path, and scans
# <control>/<requestId>/request.json: a plain file of at most 4096 bytes without a NUL byte, in a folder
# named by a lowercase v4 uuid, no link at any component, in the closed layout of the extension's
# CloneControlRequestSchema (JSON.stringify key order, nothing else tolerated):
#   {"requestId","kind":"clone-control","action","instanceId","namespace","masterProfileId",
#    "masterIdentity":{"key","signedAt","signature"},"createdAt"}
# Any other file is logged and left alone, with no status. A well-formed request that must not run
# (another namespace or master, createdAt older than 10 minutes or more than 5 s ahead, an instanceId
# that is not the one block of the record, a worker clone under a folder named clones with a matching marker, an
# open of the clone under way) gets state=refused and nothing is launched or signalled.
#   action        what it does (the transitions are lifecycle.sh close and open-clone, under the profile lock)
#   close         SIGINT only, never SIGTERM or SIGKILL; holds the clone closed until an open. Refused before
#                 any signal when the state names another root, the root is shared, or an open is under way
#   open-headless | open-visible
#                 resumes the clone and opens it in that mode; a running Chrome of that mode is adopted, one
#                 of the other mode is refused (reopen instead)
#   reopen-headless | reopen-visible
#                 close, then open in that mode; a closed clone is only opened; a close that times out
#                 is an error and nothing opens
# Several pending requests are handled in one call, per clone ordered by createdAt: the newest runs and
# the older ones are refused as superseded. A successful open is listed in <state-dir>/control/opened so
# the launcher forgets that it skipped the clone. A clone must be the one Default profile block of its
# instanceId, under clones/ with no linked folder, and its marker must name the request's instanceId.
# Each request keeps <state-dir>/control/<requestId> (key=value lines action, instanceId, state,
# message); a state of done, refused, or error is final and never runs again, a request found
# running was interrupted and becomes error.
# <control>/<requestId>/status.json is the launcher's, replaced by rename:
#   {"requestId","action","instanceId","state":"running|done|refused|error","message","updatedAt"}
# <control>/clones.json lists the worker clones, rewritten on every call:
#   {"clones":[{"name","instanceId","state":"closed|opening|open","mode":"headless|headed|","boot"}],"updatedAt"}
# Environment: RECNRUN_LIFECYCLE_STOP_S (20) and what lifecycle.sh reads.
#
# Exit: 0 done, 64 wrong call, 65 refused (record or state), 73 cannot write, 75 busy (another run).

cc_as_library=${RECNRUN_DISCOVERY_LIB:-}
# shellcheck source=clone-open.sh
RECNRUN_DISCOVERY_LIB=1 . "$(dirname -- "$0")/clone-open.sh"
# shellcheck source=lifecycle-state.sh
. "$(dirname -- "$0")/lifecycle-state.sh"
RECNRUN_DISCOVERY_LIB=$cc_as_library # a dot keeps its own assignment: give back what this script saw
# shellcheck source=clone-control-request.sh
. "$(dirname -- "$0")/clone-control-request.sh"
# shellcheck source=clone-control-ops.sh
. "$(dirname -- "$0")/clone-control-ops.sh"
cc_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

log() { printf 'clone-control.sh: %s\n' "$*" >&2; }
record_refuse() {
  log "refused: $*"
  exit 65
}
cc_nl='
'
cc_fresh_ms=600000
cc_ahead_ms=5000

# --- The master and its workers ----------------------------------------------------------------

record_hook_line() {
  case $line in role=*) cc_role=${line#role=} ;; esac
}
record_hook_block() {
  cc_block_role=$cc_role cc_role=
  cc_ids="$cc_ids$b_id$cc_nl"
  [ "$b_ns" = "$ns" ] || return 0
  case $cc_block_role in
    master)
      cc_masters=$((cc_masters + 1))
      cc_master_id=$b_id cc_master_root=$b_downloads
      ;;
    worker)
      # A block that is not the Default profile of its root is listed without a root, so it never qualifies.
      [ -z "$b_user" ] || [ "$b_profile" = Default ] || b_user=''
      cc_workers="$cc_workers$b_id=$b_user$cc_nl"
      ;;
  esac
}
# Sets cc_master_id, cc_master_root, cc_control, and cc_workers (id=userDataDir lines), or fails.
find_roster() {
  cc_role='' cc_masters=0 cc_master_id='' cc_master_root='' cc_workers='' cc_ids=''
  if [ ! -f "$record" ] || [ ! -r "$record" ]; then refuse 'the record is not a readable file'; fi
  record_load "$record"
  record_parse 1
  if [ "$cc_masters" -ne 1 ]; then
    log "the record holds $cc_masters blocks with role=master in namespace $ns, not one: nothing to control"
    return 1
  fi
  is_v4 "$cc_master_id" || { log 'the master block has no lowercase v4 profileId'; return 1; }
  [ -n "$cc_master_root" ] || { log 'the master block has no downloadsRoot'; return 1; }
  cc_control=$cc_master_root/RECnRun/poc/$ns/control
  plain_path "$cc_master_root" RECnRun poc "$ns" || { log "no plain RECnRun/poc/$ns folder below $cc_master_root"; return 1; }
  no_link_below "$cc_master_root" "RECnRun/poc/$ns/control" || { log "$cc_control is a link"; return 1; }
  [ -d "$cc_control" ] || mkdir -- "$cc_control" 2>/dev/null || { log "cannot make $cc_control"; return 1; }
}

# The main Chrome pid of the clone root, or nothing.
running_pid() { (st_pid=''; main_pid_of "$cc_root") || :; }
life_status() {
  (
    read_state "$cc_state/profiles/$1" 2>/dev/null
    printf '%s' "$st_status"
  )
}

# --- One request -------------------------------------------------------------------------------

handle_request() {
  op_action='' op_instance=''
  put_op running 'working on it'
  if ! parse_request "$cc_control/$rq_id/request.json" "$rq_id"; then
    put_op refused "$rq_why"
    return 0
  fi
  op_action=$rq_action op_instance=$rq_instance
  if ! check_fresh || ! eligible_clone "$rq_instance"; then
    put_op refused "$rq_why"
    return 0
  fi
  perform
}
# Adds "createdAt id instance action" of the still unanswered request $1 to cc_pending; one that is not
# in the closed grammar counts as time 0 with no instance, so handle_request answers it.
note_pending() {
  rq_id=$1
  parse_request "$cc_control/$1/request.json" "$1" || { rq_created=0 rq_instance='' rq_action=''; }
  cc_pending="$cc_pending${cc_pending:+$cc_nl}$rq_created $1 ${rq_instance:--} ${rq_action:--}"
}
# Handles the pending requests oldest first; a request that a newer one for the same clone follows
# is superseded, so a late click can never be undone by an earlier one.
run_pending() {
  rp_seen=' ' rp_keep=''
  while read -r _ rp_id rp_inst rp_action; do
    case $rp_seen in
      *" $rp_inst "*)
        rq_id=$rp_id op_action=$rp_action op_instance=$rp_inst
        put_op refused 'superseded by a newer request for the same clone'
        continue
        ;;
    esac
    [ "$rp_inst" = - ] || rp_seen="$rp_seen$rp_inst "
    rp_keep="$rp_id${rp_keep:+$cc_nl$rp_keep}"
  done <<PENDING
$(printf '%s\n' "$cc_pending" | LC_ALL=C sort -k1,1nr -k2,2r)
PENDING
  while IFS= read -r rq_id; do
    [ -z "$rq_id" ] || handle_request
  done <<KEPT
$rp_keep
KEPT
}
advance_request() {
  read_op "$1" || { log "ignored the state of $1: not in the closed grammar"; return 0; }
  case $op_state in
    done | refused | error) return 0 ;;
    running)
      rq_id=$1
      put_op error 'interrupted; ask again'
      return 0
      ;;
  esac
  note_pending "$1"
}
scan_requests() {
  cc_pending=''
  for sr_folder in "$cc_control"/*/; do
    sr_id=${sr_folder%/}
    sr_id=${sr_id##*/}
    if ! is_v4 "$sr_id" || ! plain_path "$cc_master_root" RECnRun poc "$ns" control "$sr_id"; then
      [ "$sr_id" = '*' ] || log "ignored $sr_folder: not a plain folder named by a lowercase v4 uuid"
      continue
    fi
    if ! request_file_ok "$sr_id"; then
      log "ignored the request of $sr_id: not a plain file of at most 4096 bytes"
      continue
    fi
    advance_request "$sr_id"
  done
  [ -z "$cc_pending" ] || run_pending
}

# --- clones.json -------------------------------------------------------------------------------

# One clones.json entry for the eligible clone in cc_root (instance $1), or nothing.
clone_entry() {
  ce_pid=$(running_pid)
  ce_mode='' ce_boot=''
  if [ -n "$ce_pid" ]; then
    ce_state=open
    ce_mode=$(mode_of_pid "$ce_pid")
    ce_boot=$(
      read_state "$cc_state/profiles/$1" 2>/dev/null
      printf '%s' "$st_boot"
    )
  elif [ "$(life_status "$1")" = opening ]; then
    ce_state=opening
  else
    ce_state=closed
  fi
  printf '{"name":"%s","instanceId":"%s","state":"%s","mode":"%s","boot":"%s"}' "$cc_name" "$1" "$ce_state" "$ce_mode" "$ce_boot"
}
write_clones() {
  wc_out=''
  while IFS= read -r wc_line; do
    [ -n "$wc_line" ] || continue
    eligible_clone "${wc_line%%=*}" || continue
    wc_out="$wc_out${wc_out:+,}$(clone_entry "${wc_line%%=*}")"
  done <<WORKERS
$cc_workers
WORKERS
  wc_tmp=$cc_control/.clones.json.$(lc_random).tmp
  (
    set -C
    printf '{"clones":[%s],"updatedAt":%s000}' "$wc_out" "$(date +%s)" >"$wc_tmp"
  ) || die 73 "cannot write $wc_tmp"
  mv -f -- "$wc_tmp" "$cc_control/clones.json" || die 73 'cannot replace clones.json'
}

# --- Commands ----------------------------------------------------------------------------------

cleanup() {
  [ -z "$cc_child" ] || kill -TERM "$cc_child" 2>/dev/null
  drop_run
  release_lock "$cc_state/control.lock" "$$"
}
cmd_run() {
  [ "$#" -eq 3 ] || die 64 'usage: run <state-dir> <record> <namespace>'
  state_dir "$1"
  no_link_below "$1" control || die 65 "$1/control is a symbolic link"
  mkdir -p -- "$1/control"
  cc_state=$1 record=$2 ns=$3
  is_namespace "$ns" || die 65 'the namespace is not a namespace'
  if ! is_directory "$record" || [ ! -f "$record" ]; then die 65 'the record is not an absolute file'; fi
  setting "${RECNRUN_LIFECYCLE_STOP_S:-}" 20 RECNRUN_LIFECYCLE_STOP_S >/dev/null || exit $?
  find_roster || return 0
  take_lock "$cc_state/control.lock" "$$"
  trap cleanup EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  scan_requests
  write_clones
}

if [ -z "$cc_as_library" ]; then
  [ "$#" -ge 1 ] || die 64 'usage: clone-control.sh run [argument ...]'
  cc_command=$1
  shift
  case $cc_command in
    run) cmd_run "$@" ;;
    *) die 64 "unknown command $cc_command" ;;
  esac
fi
