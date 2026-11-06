#!/bin/sh
# The launch of lifecycle.sh request (POC PLAN.md P4.4, decision 11): the attempt, its pid hook, and
# the settling of its result. Sourced by lifecycle.sh, which also provides log, die, the st_* state,
# and open.sh's open_profile. The state is only assigned through state_set, so this file stands alone
# for ShellCheck.

# Set by cmd_request and find_profile before a launch runs; named here so ShellCheck sees them.
backoff_s='' lc_lock='' lc_id='' lc_now='' lc_record='' lc_ns='' lc_mode='' l_before='' p_user='' st_file=''
st_user='' st_attempts='' st_status='' st_started='' st_boot=''

# After every ack the pid of record is the root's main process, never a forwarder's: a root already
# running Chrome hands the open to it and the new process exits, shared or not.
adopt_main_pid() {
  am_pid=$(main_pid_of "$st_user") || return 0
  state_set pid "$am_pid"
}

# min(2^attempts, 64) times the base, from the clock at the failure.
schedule_retry() {
  sr_factor=1
  sr_i=0
  while [ "$sr_i" -lt "$st_attempts" ] && [ "$sr_factor" -lt 64 ]; do
    sr_factor=$((sr_factor * 2))
    sr_i=$((sr_i + 1))
  done
  state_set nextAt "$(($(date +%s) + sr_factor * backoff_s))"
}
# Reads root=, boot=, and token= from the lines open.sh printed.
take_result() {
  while IFS= read -r tr_line; do
    case $tr_line in
      root=*) if is_directory "${tr_line#*=}"; then state_set root "${tr_line#*=}"; fi ;;
      boot=*) if is_uuid "${tr_line#*=}"; then state_set boot "${tr_line#*=}"; fi ;;
      token=*) if is_v4 "${tr_line#*=}"; then state_set token "${tr_line#*=}"; fi ;;
    esac
  done <<EOF
$1
EOF
}
# The profile lock, waited for: a pause or stop holds it for a moment (a stop for as long as its wait).
lock_wait() {
  lw_tries=0
  while ! (take_lock "$lc_lock" "$$") 2>/dev/null; do
    lw_tries=$((lw_tries + 1))
    [ "$lw_tries" -le 60 ] || return 1
    sleep 1
  done
}
# open.sh calls this inside the command substitution right before it starts Chrome: the profile lock is
# taken and kept until launched records the pid, so a close cannot fall between the check of the attempt
# and the spawn, and an opener that was held up never starts Chrome for a clone that was stopped meanwhile.
before_spawn() {
  lock_wait || die 75 "cannot take the lock of $lc_id to start Chrome"
  read_state "$st_file"
  { [ "$st_status" = opening ] && [ "$st_started" = "$lc_attempt" ]; } && return 0
  release_lock "$lc_lock" "$$"
  die 73 "$lc_id is $st_status, not opening: Chrome is not started"
}
# The pid reaches the state before the ack wait, under the lock before_spawn took.
launched() {
  if is_pid "$1"; then
    state_set pid "$1"
    write_state
  fi
  release_lock "$lc_lock" "$$"
}
# The result of the open arrives after a pause, a stop, or a newer attempt: that decision stays.
abandon() {
  case $st_status in
    paused | stopped | idle)
      if [ "$l_rc" = 0 ]; then
        take_result "$l_out"
        write_state
      fi
      die 73 "$lc_id was $st_status while it was opening: the state is kept"
      ;;
  esac
  die 73 "the open of $lc_id was replaced by a newer attempt: its result is dropped"
}
settle_open() {
  case $l_rc in
    0)
      take_result "$l_out"
      adopt_main_pid
      state_set status open
      state_set attempts 0
      state_set nextAt 0
      write_state
      printf 'boot=%s\n' "$st_boot"
      ;;
    69)
      state_set status failed
      state_set attempts "$((st_attempts + 1))"
      schedule_retry
      write_state
      exit 69
      ;;
    *)
      state_set status "$l_before"
      write_state
      exit "$l_rc"
      ;;
  esac
}
# The attempt is identified by startedAt with status=opening; the profile lock is dropped while Chrome
# opens and taken again to settle, and only the attempt still current may write its result.
launch() {
  state_set status opening
  state_set startedAt "$lc_now"
  state_set pid ''
  state_set userDataDir "$p_user"
  state_set mode "$lc_mode"
  lc_attempt=$lc_now
  write_state
  release_lock "$lc_lock" "$$"
  l_err=$st_file.$(lc_random).err
  l_out=$(open_profile "$lc_record" "$lc_ns" "$lc_id" "$lc_mode" 2>"$l_err")
  l_rc=$?
  cat -- "$l_err" >&2
  rm -f -- "$l_err"
  lock_wait || die 75 "cannot take the lock of $lc_id to record the open"
  read_state "$st_file"
  { [ "$st_status" = opening ] && [ "$st_started" = "$lc_attempt" ]; } || abandon
  settle_open
}
