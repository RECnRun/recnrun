#!/bin/sh
# The owner's explicit close and open of one clone (POC PLAN.md P7.5), sourced by lifecycle.sh, which
# provides log, die, the st_* state, the locks, and open.sh's find_profile and validate_profile. Both
# commands run under the profile lock and check the state against the record before any signal or launch.
#
#   close <state-dir> <record> <namespace> <profileId>
#       SIGINT only. Refused before any signal when the block is not the one worker block of the id or its
#       root is a base, a partial copy, or the OS default root (65), the state names another root than the
#       record (65), the root is shared (70), the pid is not the Chrome of the root (65), or an open attempt is under way
#       (75; one older than RECNRUN_OPEN_TIMEOUT_S is abandoned). The stop is written first (status
#       stopped, which holds the clone like the owner's stop), so a Chrome that outlives the wait leaves
#       the intent and its pid recorded: exit 74. Prints was=1 when a Chrome ended, was=0 when none ran.
#   open-clone <state-dir> <record> <namespace> <profileId> <headed|headless>
#       Resumes a stopped clone and opens it in the mode: a verified running Chrome of that mode is
#       adopted (no launch), one of the other mode is refused (65, close it first), none is launched with
#       a fresh attempt, whatever a stale presence or a stale open state says. Prints boot= like request.

# shellcheck disable=SC2034 # the settings and the state are read by the libraries lifecycle.sh sources
# Set by the commands below; named here so ShellCheck sees them.
open_s='' backoff_s='' max_attempts='' stop_s='' cl_target='' lc_attempt='' p_user='' p_role='' p_count='' pause_file='' pause_reason=''
st_user='' st_status='' st_started='' st_pid='' st_boot='' st_root='' st_shared='' l_before=''

# Under the lock, the block must be the one worker block of the id and its root a clone root: never a
# template, a master, a frozen base, an unpublished copy, or the OS default root. RECNRUN_CONTROL_ROOT is
# the root the caller checked; another one means the record changed after that check.
control_guard() {
  [ "$p_count" -eq 1 ] || die 65 "the record names $lc_id in $p_count blocks, not one"
  [ "$p_role" = worker ] || die 65 "$lc_id is not a worker clone of the record"
  [ -z "${RECNRUN_CONTROL_ROOT:-}" ] || [ "$RECNRUN_CONTROL_ROOT" = "$p_user" ] || die 65 "$p_user is not the root $RECNRUN_CONTROL_ROOT that was checked"
  ! is_base_root "$p_user" || die 65 'a frozen base is not a clone'
  ! is_partial_root "$p_user" || die 65 'an unpublished clone copy is not a clone'
  [ "$p_user" != "$(default_root)" ] || die 65 'the OS default root is not a clone'
}
# Reads the state of the profile under its lock and checks it against the record.
control_prepare() {
  [ "$#" -ge 4 ] || die 64 'usage: <command> <state-dir> <record> <namespace> <profileId> ...'
  open_s=$(setting "${RECNRUN_OPEN_TIMEOUT_S:-}" 60 RECNRUN_OPEN_TIMEOUT_S) || exit $?
  backoff_s=$(setting "${RECNRUN_LIFECYCLE_BACKOFF_S:-}" 5 RECNRUN_LIFECYCLE_BACKOFF_S) || exit $?
  max_attempts=$(setting "${RECNRUN_LIFECYCLE_MAX_ATTEMPTS:-}" 5 RECNRUN_LIFECYCLE_MAX_ATTEMPTS) || exit $?
  lc_record=$2 lc_ns=$3 lc_id=$4
  is_namespace "$lc_ns" || die 65 'the namespace is not a namespace'
  is_v4 "$lc_id" || die 65 'the profile id is not a lowercase v4 uuid'
  state_dir "$1"
  lc_lock=$1/profiles/$lc_id.lock
  take_lock "$lc_lock" "$$"
  trap 'release_lock "$lc_lock" "$$"' EXIT
  find_profile "$lc_record" "$lc_ns" "$lc_id"
  control_guard
  read_state "$1/profiles/$lc_id"
  [ -z "$st_user" ] || [ "$st_user" = "$p_user" ] || die 65 "the state of $lc_id names $st_user, not the registered $p_user: not touched"
  lc_now=$(date +%s)
  if [ "$st_status" = opening ] && [ $((lc_now - st_started)) -lt "$open_s" ]; then
    die 75 "an open attempt of $lc_id is under way"
  fi
}

# --- Close -----------------------------------------------------------------------------------

# Sets cl_target to the main pid of the Chrome on the root, or empty; any other process is refused. The
# pid in the state is only a hint: it may be a helper or a recycled pid.
close_target() {
  cl_target=$(main_pid_of "$p_user" || :)
  [ -n "$cl_target" ] || return 0
  is_chrome_of "$(ps -o command= -p "$cl_target" 2>/dev/null)" "$p_user" || die 65 "pid $cl_target does not name $p_user: not signalled"
}
cmd_close() {
  stop_s=$(setting "${RECNRUN_LIFECYCLE_STOP_S:-}" 20 RECNRUN_LIFECYCLE_STOP_S) || exit $?
  [ "$#" -eq 4 ] || die 64 'usage: close <state-dir> <record> <namespace> <profileId>'
  control_prepare "$@"
  if root_is_shared "$p_user" "$lc_record"; then
    st_user=$p_user
    die 70 "$(shared_message)"
  fi
  close_target
  st_user=$p_user
  state_set status stopped
  write_state
  if [ -z "$cl_target" ]; then
    state_set pid ''
    write_state
    printf 'was=0\n'
    return 0
  fi
  kill -INT "$cl_target"
  cc_waited=0
  while pid_alive "$cl_target" && [ "$cc_waited" -lt "$stop_s" ]; do
    sleep 1
    cc_waited=$((cc_waited + 1))
  done
  if pid_alive "$cl_target"; then
    state_set pid "$cl_target"
    write_state
    die 74 "pid $cl_target still runs after $stop_s s"
  fi
  state_set pid ''
  write_state
  printf 'was=1\n'
}

# --- Open ------------------------------------------------------------------------------------

# Records the running Chrome $1 of the root as the open clone, without a launch.
adopt_running() {
  state_set pid "$1"
  state_set status open
  state_set mode "$lc_mode"
  state_set userDataDir "$p_user"
  state_set attempts 0
  state_set nextAt 0
  st_shared=0
  if root_is_shared "$p_user" "$lc_record"; then st_shared=1; fi
  write_state
  printf 'boot=%s\n' "$st_boot"
}
cmd_open_clone() {
  [ "$#" -eq 5 ] || die 64 'usage: open-clone <state-dir> <record> <namespace> <profileId> <headed|headless>'
  case $5 in headed | headless) lc_mode=$5 ;; *) die 65 'the mode is neither headed nor headless' ;; esac
  control_prepare "$@"
  validate_profile
  if pause_stated "$lc_ns" "$lc_id" "$st_root"; then
    die 65 "$pause_file states $pause_reason: reconnect the profile in the extension, or delete the file"
  fi
  oc_pid=$(main_pid_of "$p_user" || :)
  if [ -n "$oc_pid" ]; then
    is_chrome_of "$(ps -o command= -p "$oc_pid" 2>/dev/null)" "$p_user" || die 65 "pid $oc_pid does not name $p_user: not adopted"
    oc_have=$(mode_of_pid "$oc_pid")
    [ "$oc_have" = "$lc_mode" ] || die 65 "$lc_id already runs in ${oc_have:-an unknown mode}; close it first"
    adopt_running "$oc_pid"
    return 0
  fi
  state_set status idle
  state_set attempts 0
  state_set nextAt 0
  state_set pid ''
  st_shared=0
  if root_is_shared "$p_user" "$lc_record"; then st_shared=1; fi
  l_before=idle
  lc_control=1
  launch
}
