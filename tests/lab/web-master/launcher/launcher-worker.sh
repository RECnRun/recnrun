#!/bin/sh
# The Chromes launcher.sh starts on roots/w1/chrome: each is recorded in state/pids/<kind>.<pid> with
# its start time and executable, and only a process that still matches all three is ever signalled.
# Sourced by launcher.sh.

# Every pid whose command line names the user data dir $1, in holders.
lab_holders() {
  holders=''
  while read -r lh_pid lh_cmd; do
    if names_root "$lh_cmd" "$1"; then holders="$holders${holders:+ }$lh_pid"; fi
  done <<HOLDERS
$(ps -axo pid=,command= 2>/dev/null)
HOLDERS
}

add_survivor() {
  case " $survivors " in *" $1 "*) ;; *) survivors="$survivors${survivors:+ }$1" ;; esac
}

# Records the pid $2 of kind $1, started from the executable $3 on roots/w1/chrome.
record_pid() {
  rp_start=$(ps -o lstart= -p "$2" 2>/dev/null) || return 1
  [ -n "$rp_start" ] || return 1
  printf 'pid=%s\nlstart=%s\nexe=%s\nroot=%s\n' "$2" "$rp_start" "$3" "$ROOT/chrome" |
    write_atomic "$STATE/pids/$1.$2"
}

# Reads the record $1 into rec_*; 0 when the process still matches it, 1 when it is gone or its pid
# was reused (the record is dropped), 2 when the same process no longer looks like that Chrome.
record_check() {
  rec_pid='' rec_start='' rec_exe='' rec_root=''
  while IFS= read -r rc_line; do
    case $rc_line in
      pid=*) rec_pid=${rc_line#pid=} ;;
      lstart=*) rec_start=${rc_line#lstart=} ;;
      exe=*) rec_exe=${rc_line#exe=} ;;
      root=*) rec_root=${rc_line#root=} ;;
    esac
  done <"$1"
  rc_now=''
  ! is_pid "$rec_pid" || ! pid_alive "$rec_pid" || rc_now=$(ps -o lstart= -p "$rec_pid" 2>/dev/null)
  if [ -z "$rc_now" ] || [ "$rc_now" != "$rec_start" ] || [ -z "$rec_exe" ]; then
    rm -f -- "$1"
    return 1
  fi
  rc_args=$(ps -ww -o args= -p "$rec_pid" 2>/dev/null)
  case $rc_args in "$rec_exe "*) ;; *) return 2 ;; esac
  names_root "$rc_args" "$rec_root" || return 2
}

# Waits up to $2 seconds, in fifths, for the pid $1 to end.
await_end() {
  ae_left=$(($2 * 5))
  while pid_alive "$1"; do
    [ "$ae_left" -gt 0 ] || return 1
    sleep 0.2
    ae_left=$((ae_left - 1))
  done
}

# SIGINT is Chrome's normal shutdown; SIGKILL only after STOP_S. A changed process is never signalled.
stop_record() {
  record_check "$1"
  case $? in
    1) return 0 ;;
    2)
      log "pid $rec_pid no longer runs $rec_exe on $rec_root; not signalled"
      add_survivor "$rec_pid"
      return 0
      ;;
  esac
  kill -INT "$rec_pid" 2>/dev/null
  if ! await_end "$rec_pid" "$STOP_S"; then
    log "pid $rec_pid still runs $STOP_S s after SIGINT: SIGKILL"
    kill -KILL "$rec_pid" 2>/dev/null
    await_end "$rec_pid" 2 || add_survivor "$rec_pid"
  fi
  pid_alive "$rec_pid" || rm -f -- "$1"
}

# Stops every recorded Chrome of kind $1 (worker or install), or of both when $1 is all.
stop_records() {
  for sw_record in "$STATE/pids/"*.*; do
    [ -f "$sw_record" ] || continue
    sw_kind=${sw_record##*/}
    [ "$1" = all ] || [ "$1" = "${sw_kind%%.*}" ] || continue
    stop_record "$sw_record"
  done
}
stop_worker() { stop_records worker; }

# True when a recorded worker still runs; sets worker_pid.
worker_running() {
  worker_pid=''
  for wr_record in "$STATE/pids/worker."*; do
    [ -f "$wr_record" ] || continue
    if record_check "$wr_record"; then
      worker_pid=$rec_pid
      return 0
    fi
  done
  return 1
}

# The worker Chrome: headless, on the provisioned root, with no debugging port or pipe.
launch_worker() {
  lw_chrome=$(lab_chrome) || return 1
  set -- "--user-data-dir=$ROOT/chrome" --profile-directory=Default --no-first-run \
    --no-default-browser-check --headless=new --silent-debugger-extension-api
  # The test image runs Chrome as root, which the sandbox refuses.
  [ "${RECNRUN_TEST_CONTAINER:-}" != 1 ] || set -- "$@" --no-sandbox
  "$lw_chrome" "$@" about:blank </dev/null >>"$STATE/worker.log" 2>&1 &
  worker_pid=$!
  record_pid worker "$worker_pid" "$lw_chrome" || return 1
  sleep 0.5
  pid_alive "$worker_pid" || return 1
  log "worker pid $worker_pid on $ROOT/chrome"
}

# What cleanup stops: the install run, every recorded Chrome, then anything else naming the root.
stop_children() {
  if [ -n "${inst_pid:-}" ] && pid_alive "$inst_pid"; then
    kill -TERM "$inst_pid" 2>/dev/null
    wait "$inst_pid" 2>/dev/null
    note_install_pid
  fi
  stop_records all
  lab_holders "$ROOT/chrome"
  for sc_pid in $holders; do add_survivor "$sc_pid"; done
}
