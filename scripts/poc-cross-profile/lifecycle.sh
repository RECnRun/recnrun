#!/bin/sh
# lifecycle.sh <command> [argument ...]
#
# The launcher's idempotence, timeouts, locks, and pause policy (POC PLAN.md P4.4, decision 11).
# POSIX sh only, no JSON parser, nothing read from a file is ever run or expanded. Source it with
# RECNRUN_DISCOVERY_LIB=1 to get the functions without the command entry.
#
#   lock <state-dir> | unlock <state-dir>   one launcher per state dir: <state-dir>/launcher.lock names
#                                           the caller's pid ($PPID); a dead pid's lock is taken over
#   request <state-dir> <record> <namespace> <profileId> [headed|headless]
#   pause | resume | reset <state-dir> <profileId>
#   stop <state-dir> <profileId> [--force]  SIGINT (Chrome's normal shutdown; SIGTERM would skip it) to the
#                                           pid the state names, only while its command line is the Chrome of
#                                           open.sh on exactly the user data dir (checked again before SIGKILL);
#                                           --force adds SIGKILL after the wait; stderr names the ending signal
#   adopt <state-dir> <record> <namespace> <profileId> <downloadsRoot> <boot>
#                                           records the profile open: an acked open.sh bind is the proof, even
#                                           when the Chrome that answered was already running (no launch pass)
#   status <state-dir>                      profileId status pid attempts nextAt, one line each
#
# State, <state-dir>/profiles/<profileId>: key=value lines with token, pid, startedAt, attempts,
# nextAt (epoch seconds), status (idle, opening, open, failed, paused, stopped), mode (headed or headless: the
# mode of the last open, which a crash relaunch repeats; empty before any), boot, root (the
# Downloads root), userDataDir, shared (1 when another record block names the same userDataDir or the folder holds another profile: Default or Profile <n> with a Preferences file); any other key or value outside its grammar exits 65. Numbers are canonical decimal (no leading zero, a pid above zero, attempts at most the maximum). userDataDir and
# pid are written when the attempt starts and the Chrome launches, so a timed-out open (69) keeps both
# and stop can still end that Chrome.
# Pause policy: the extension states it, silence never does. A profile that was disconnected or forgotten
# writes <root>/RECnRun/poc/<namespace>/peers/<profileId>/paused.json (reason disconnect or forget, or resumed
# once it is back); a request that finds such a statement, in its exact bytes and behind no link, marks the
# profile paused (73) whether or not it has a presence or a live pid, and resume is refused (65) while the
# file stands. Without the statement a fresh presence or a live pid leaves an open profile alone (a healthy
# linked profile goes silent on purpose), and a dead pid is a crash and relaunches.
# Stop policy: stop is the owner's decision, so a stopped profile is held like a paused one (request
# exits 73) until resume; resume turns a paused or stopped profile into idle, which request launches.
#
# Shared roots: profiles of one user data dir live in one Chrome (the process singleton forwards a
# second open to it and the new process exits), so the pid of any profile is that main process after
# its ack (shared or not: the person may have the root open already), found by its command line; stop is refused (70) because a signal would close every
# profile of the root, and a dead main process is a crash that each profile's request relaunches.
#
# Environment: RECNRUN_OPEN_TIMEOUT_S (60), RECNRUN_LIFECYCLE_BACKOFF_S (5), _MAX_ATTEMPTS (5), _STOP_S (20).
# No symbolic link is followed below the state dir (profiles) or below the Downloads root (RECnRun, poc,
# the namespace, peers or acks, the profile folder, the file): such a presence or ack is ignored, such a
# state dir is refused with 65.
#
# A pause, stop, or reset that lands while a request opens Chrome wins: the open settles under the lock,
# writes its result only while startedAt and status=opening still name it, otherwise keeps the owner's
# status (the pid and token stay recorded so stop can end that Chrome) and exits 73.
#
# Exit: 0 done, 64 wrong call, 65 refused, 70 failed (retry later, max attempts, or still running),
# 73 paused, 75 busy (another launcher, or an attempt under way); open.sh's 66 and 69 pass through.

lifecycle_as_library=${RECNRUN_DISCOVERY_LIB:-}
# shellcheck source=open.sh
RECNRUN_DISCOVERY_LIB=1 . "$(dirname -- "$0")/open.sh"
RECNRUN_DISCOVERY_LIB=$lifecycle_as_library # a dot keeps its own assignment: give back what this script saw
umask 077
# shellcheck source=lifecycle-state.sh
. "$(dirname -- "$0")/lifecycle-state.sh"
# shellcheck source=lifecycle-launch.sh
. "$(dirname -- "$0")/lifecycle-launch.sh"

log() { printf 'lifecycle.sh: %s\n' "$*" >&2; }
die() {
  d_status=$1
  shift
  log "$*"
  exit "$d_status"
}
# Runs the function $3 on the state of profile $2 in state dir $1 under the profile lock.
mutate() {
  state_dir "$1"
  is_v4 "$2" || die 65 'the profile id is not a lowercase v4 uuid'
  lc_id=$2
  lc_lock=$1/profiles/$2.lock
  take_lock "$lc_lock" "$$"
  trap 'release_lock "$lc_lock" "$$"' EXIT
  read_state "$1/profiles/$2"
  "$3"
  write_state
}
do_pause() { st_status=paused; }
do_resume() {
  case $st_status in paused | stopped) ;; *) return 0 ;; esac
  if pause_stated_anywhere "$lc_id" "$st_root"; then
    die 65 "$pause_file states $pause_reason: reconnect the profile in the extension, or delete the file, then resume"
  fi
  st_status=idle
}
do_reset() { st_attempts=0 st_next=0; }
# Records an acked profile as open, with the root's main Chrome as its pid when one is found.
adopt_profile() {
  case $st_status in paused | stopped) die 73 "$lc_id is $st_status: resume it first" ;; esac
  st_pid=''
  state_set pid "$(main_pid_of "$p_user" || :)"
  state_set mode "$(mode_of_pid "$st_pid")"
  state_set status open
  state_set startedAt "$(date +%s)"
  state_set attempts 0
  state_set nextAt 0
  state_set boot "$ad_boot"
  state_set root "$ad_root"
  state_set userDataDir "$p_user"
  st_shared=0
  if root_is_shared "$p_user" "$ad_record"; then st_shared=1; fi
}
cmd_adopt() {
  [ "$#" -eq 6 ] || die 64 'usage: adopt <state-dir> <record> <namespace> <profileId> <downloadsRoot> <boot>'
  is_namespace "$3" || die 65 'the namespace is not a namespace'
  is_v4 "$4" || die 65 'the profile id is not a lowercase v4 uuid'
  is_uuid "$6" || die 65 'the boot is not a uuid'
  is_directory "$5" || die 65 'the Downloads root is not an absolute directory'
  find_profile "$2" "$3" "$4"
  ad_record=$2 ad_root=$5 ad_boot=$6
  mutate "$1" "$4" adopt_profile
}
cmd_status() {
  state_dir "$1"
  for ss_file in "$1"/profiles/*; do
    ss_name=${ss_file##*/}
    is_v4 "$ss_name" || continue
    read_state "$ss_file"
    printf '%s %s %s %s %s\n' "$ss_name" "$st_status" "${st_pid:--}" "$st_attempts" "$st_next"
  done
}

# --- Stop ------------------------------------------------------------------------------------

shared_message() { printf 'shared root %s: stopping would close every profile of it; close its window instead' "$st_user"; }
# The pid must be Chrome on this user data dir; a name or a recycled pid is never enough. Checked
# again before SIGKILL, since the pid may have been recycled during the wait.
names_user_dir() {
  [ -n "$st_user" ] || return 1
  is_chrome_of "$(ps -o command= -p "$st_pid" 2>/dev/null)" "$st_user"
}
stop_profile() {
  [ "$st_shared" = 0 ] || die 70 "$(shared_message)"
  if pid_alive "$st_pid"; then
    names_user_dir || die 65 "pid $st_pid does not name $st_user: not signalled"
    # Chrome reads one shutdown signal, so a SIGTERM after this one would change nothing.
    kill -INT "$st_pid"
    sp_ended=SIGINT
    sp_waited=0
    while pid_alive "$st_pid" && [ "$sp_waited" -lt "$stop_s" ]; do
      sleep 1
      sp_waited=$((sp_waited + 1))
    done
    if pid_alive "$st_pid"; then
      [ "$stop_force" = 1 ] || die 70 "pid $st_pid still runs after $stop_s s: stop --force kills it"
      names_user_dir || die 65 "pid $st_pid no longer names $st_user: not killed"
      kill -KILL "$st_pid"
      sp_ended=SIGKILL
    fi
    log "pid $st_pid ended by $sp_ended"
  fi
  st_status=stopped st_pid=''
}
cmd_stop() {
  stop_s=$(setting "${RECNRUN_LIFECYCLE_STOP_S:-}" 20 RECNRUN_LIFECYCLE_STOP_S) || exit $?
  stop_force=0
  case ${3:-} in '') ;; --force) stop_force=1 ;; *) die 64 'usage: stop <state-dir> <profileId> [--force]' ;; esac
  [ "$#" -le 3 ] || die 64 'usage: stop <state-dir> <profileId> [--force]'
  mutate "$1" "$2" stop_profile
}

# --- Request ---------------------------------------------------------------------------------

# A number after "key": in the presence text, else exit 1.
number_after() {
  na_rest=${1#*\""$2"\":}
  [ "$na_rest" != "$1" ] || return 1
  na_value=${na_rest%%[!0-9]*}
  is_count "$na_value" || return 1
  printf '%s\n' "$na_value"
}
# The presence a profile publishes, with catalog.sh's clock rules: unexpired, stamped at most 5 s ahead,
# living at most 60 s.
presence_fresh() {
  [ -n "$st_root" ] || return 1
  no_link_below "$st_root" "RECnRun/poc/$lc_ns/peers/$lc_id/presence.json" || return 1
  pf_file=$st_root/RECnRun/poc/$lc_ns/peers/$lc_id/presence.json
  if [ ! -f "$pf_file" ] || [ -L "$pf_file" ]; then return 1; fi
  [ "$(wc -c <"$pf_file" | tr -d ' ')" -le 2048 ] || return 1
  pf_text=$(cat -- "$pf_file")
  case $pf_text in '{"profileId":"'"$lc_id"'"'*) ;; *) return 1 ;; esac
  pf_created=$(number_after "$pf_text" createdAt) || return 1
  pf_expires=$(number_after "$pf_text" expiresAt) || return 1
  pf_now="$(date +%s)000"
  [ "$pf_expires" -gt "$pf_created" ] && [ $((pf_expires - pf_created)) -le 60000 ] || return 1
  [ "$pf_expires" -gt "$pf_now" ] && [ "$pf_created" -le $((pf_now + 5000)) ]
}
# An open profile is held when it stated the pause, else left alone while it lives or has a fresh
# presence; only a dead pid is a crash. Silence is never read as intent: a healthy linked profile
# stops publishing on purpose (P3.6).
check_open() {
  if pause_stated "$lc_ns" "$lc_id" "$st_root"; then
    st_status=paused
    write_state
    die 73 "$lc_id stated $pause_reason in $pause_file: resume it after it reconnects, or delete the file"
  fi
  if presence_fresh; then
    printf 'boot=%s\n' "$st_boot"
    exit 0
  fi
  if pid_alive "$st_pid"; then
    log "$lc_id is open but silent: left alone"
    printf 'boot=%s\n' "$st_boot"
    exit 0
  fi
}
# Exits unless a launch is allowed now.
decide() {
  case $st_status in
    paused | stopped) die 73 "$lc_id is $st_status: resume it first" ;;
    opening) [ $((lc_now - st_started)) -ge "$open_s" ] || die 75 "an open attempt of $lc_id is under way" ;;
    open) check_open ;;
  esac
  [ "$st_attempts" -lt "$max_attempts" ] || die 70 "$lc_id failed $st_attempts times: reset it first"
  [ "$st_next" -le "$lc_now" ] || die 70 "retry at $st_next"
}
cmd_request() {
  if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then die 64 'usage: request <state-dir> <record> <namespace> <profileId> [headed|headless]'; fi
  open_s=$(setting "${RECNRUN_OPEN_TIMEOUT_S:-}" 60 RECNRUN_OPEN_TIMEOUT_S) || exit $?
  backoff_s=$(setting "${RECNRUN_LIFECYCLE_BACKOFF_S:-}" 5 RECNRUN_LIFECYCLE_BACKOFF_S) || exit $?
  max_attempts=$(setting "${RECNRUN_LIFECYCLE_MAX_ATTEMPTS:-}" 5 RECNRUN_LIFECYCLE_MAX_ATTEMPTS) || exit $?
  lc_record=$2 lc_ns=$3 lc_id=$4 lc_mode=${5:-headed}
  case $lc_mode in headed | headless) ;; *) die 65 'the mode is neither headed nor headless' ;; esac
  is_namespace "$lc_ns" || die 65 'the namespace is not a namespace'
  is_v4 "$lc_id" || die 65 'the profile id is not a lowercase v4 uuid'
  find_profile "$lc_record" "$lc_ns" "$lc_id"
  validate_profile
  state_dir "$1"
  lc_lock=$1/profiles/$lc_id.lock
  take_lock "$lc_lock" "$$"
  trap 'release_lock "$lc_lock" "$$"' EXIT
  read_state "$1/profiles/$lc_id"
  [ "$st_attempts" -le "$max_attempts" ] || state_bad 'attempts (above the maximum: reset it)'
  st_shared=0
  if root_is_shared "$p_user" "$lc_record"; then st_shared=1; fi
  lc_now=$(date +%s)
  l_before=$st_status
  [ "$l_before" != none ] || l_before=idle
  decide
  launch
}
cmd_unlock() {
  state_dir "$1"
  cu_pid=
  if [ -f "$1/launcher.lock" ]; then read -r cu_pid <"$1/launcher.lock" || :; fi
  [ -z "$cu_pid" ] || [ "$cu_pid" = "$PPID" ] || die 75 "another launcher holds the lock (pid $cu_pid)"
  release_lock "$1/launcher.lock" "$PPID"
}

if [ -z "$lifecycle_as_library" ]; then
  [ "$#" -ge 2 ] || die 64 'usage: lifecycle.sh lock|unlock|request|adopt|pause|resume|reset|stop|status <state-dir> ...'
  lc_command=$1
  shift
  trap 'exit 143' TERM
  trap 'exit 130' INT
  case $lc_command in
    lock)
      state_dir "$1"
      take_lock "$1/launcher.lock" "$PPID"
      ;;
    unlock) cmd_unlock "$1" ;;
    request) cmd_request "$@" ;;
    pause) mutate "$1" "${2:-}" do_pause ;;
    resume) mutate "$1" "${2:-}" do_resume ;;
    adopt) cmd_adopt "$@" ;;
    reset) mutate "$1" "${2:-}" do_reset ;;
    stop) cmd_stop "$@" ;;
    status) cmd_status "$1" ;;
    *) die 64 "unknown command $lc_command" ;;
  esac
fi
