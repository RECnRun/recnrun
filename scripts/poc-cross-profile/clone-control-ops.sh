#!/bin/sh
# The answers and actions of clone-control.sh (POC PLAN.md P7.5): the state of a request and its
# status.json, the run of lifecycle.sh, and the close, open, and reopen of a clone. Sourced by
# clone-control.sh, which provides the roster (cc_*), the request (rq_*), and log.

# shellcheck disable=SC2034 # the settings and results are read by clone-control.sh
# Set by clone-control.sh before these run; named here so ShellCheck sees them.
cc_state='' cc_control='' cc_dir='' cc_root='' cc_name='' record='' ns='' rq_id='' rq_action='' rq_instance='' rq_created='' rq_why=''

# --- The request's state -----------------------------------------------------------------------

# A message the status carries: printable ASCII without quote or backslash, at most 256 bytes.
clean_message() { printf '%s' "$1" | LC_ALL=C tr -cd ' -~' | LC_ALL=C tr -d '\042\134' | cut -c1-256; }
# Sets op_* from the state of request $1; fails when it is unreadable (the request is then left alone).
read_op() {
  op_action='' op_instance='' op_state='' op_message=''
  ro_file=$cc_state/control/$1
  [ -e "$ro_file" ] || return 0
  [ -f "$ro_file" ] && [ ! -L "$ro_file" ] && [ "$(wc -c <"$ro_file" | tr -d ' ')" -le 2048 ] || return 1
  while IFS= read -r ro_line || [ -n "$ro_line" ]; do
    ro_value=${ro_line#*=}
    case $ro_line in
      action=*) op_action=$ro_value ;;
      instanceId=*) op_instance=$ro_value ;;
      state=*) op_state=$ro_value ;;
      message=*) op_message=$ro_value ;;
      *) return 1 ;;
    esac
  done <"$ro_file"
  case $op_state in running | done | refused | error) ;; *) return 1 ;; esac
}
# Replaces the state of request $rq_id and its status.json with state $1 and message $2.
put_op() {
  op_state=$1 op_message=$(clean_message "$2")
  po_tmp=$cc_state/control/.$rq_id.$(lc_random).tmp
  (
    set -C
    printf 'action=%s\ninstanceId=%s\nstate=%s\nmessage=%s\n' "$op_action" "$op_instance" "$op_state" "$op_message" >"$po_tmp"
  ) || die 73 "cannot write $po_tmp"
  mv -f -- "$po_tmp" "$cc_state/control/$rq_id" || die 73 'cannot replace the state'
  po_tmp=$cc_control/$rq_id/.status.json.$(lc_random).tmp
  (
    set -C
    printf '{"requestId":"%s","action":"%s","instanceId":"%s","state":"%s","message":"%s","updatedAt":%s000}' \
      "$rq_id" "$op_action" "$op_instance" "$op_state" "$op_message" "$(date +%s)" >"$po_tmp"
  ) || die 73 "cannot write $po_tmp"
  mv -f -- "$po_tmp" "$cc_control/$rq_id/status.json" || die 73 'cannot replace status.json'
}

# Fails when a request newer than the one in hand was already handled for the clone, else records this
# one as the newest: a late old click, delivered in a later pass, can never undo a newer one.
accept_request() {
  ar_file=$cc_state/control/newest-$rq_instance
  ar_newest=0
  if [ -f "$ar_file" ] && [ ! -L "$ar_file" ]; then read -r ar_newest <"$ar_file" || :; fi
  case $ar_newest in '' | *[!0-9]*) ar_newest=0 ;; esac
  if [ "$rq_created" -lt "$ar_newest" ]; then
    rq_why='the request is older than a request already handled for the clone'
    return 1
  fi
  ar_tmp=$cc_state/control/.newest.$(lc_random).tmp
  (
    set -C
    printf '%s\n' "$rq_created" >"$ar_tmp"
  ) || die 73 "cannot write $ar_tmp"
  mv -f -- "$ar_tmp" "$ar_file" || die 73 'cannot record the newest request'
}

# --- Running lifecycle.sh ----------------------------------------------------------------------

cc_child='' cc_run=''
drop_run() {
  [ -z "$cc_run" ] || rm -rf -- "$cc_run"
  cc_run=''
}
# Runs `sh lifecycle.sh $@` in the background, so a SIGTERM ends the wait; rl_code is its exit code and
# its stderr is kept in a private folder made for this call.
run_life() {
  drop_run
  cc_run=$cc_state/control/.run.$(lc_random)
  mkdir -m 700 -- "$cc_run" || die 73 "cannot make a private folder in $cc_state/control"
  RECNRUN_DISCOVERY_LIB='' RECNRUN_CONTROL_ROOT=$cc_root /bin/sh "$cc_dir/lifecycle.sh" "$@" >"$cc_run/out" 2>"$cc_run/err" &
  cc_child=$!
  wait "$cc_child"
  rl_code=$?
  cc_child=''
}
last_error_line() { clean_message "$(grep -v '^[[:space:]]*$' "$cc_run/err" 2>/dev/null | tail -n 1)"; }

# --- The actions -------------------------------------------------------------------------------

# Closes the clone through lifecycle.sh close (SIGINT only, checked against the record, held closed);
# sets cc_was to 1 when a Chrome ended. On failure it has answered and fails.
close_clone() {
  run_life close "$cc_state" "$record" "$ns" "$rq_instance"
  case $rl_code in
    0)
      cc_was=0
      if grep -q '^was=1$' "$cc_run/out"; then cc_was=1; fi
      return 0
      ;;
    65 | 70 | 75) put_op refused "$(last_error_line)" ;;
    74) put_op error "$(last_error_line)" ;;
    *) put_op error "close exit $rl_code: $(last_error_line)" ;;
  esac
  return 1
}
act_close() {
  close_clone || return 0
  if [ "$cc_was" = 1 ]; then put_op 'done' "closed $cc_name"; else put_op 'done' 'already closed'; fi
}
# Opens the clone in mode $1 (headed or headless) through lifecycle.sh open-clone and answers.
launch_clone() {
  run_life open-clone "$cc_state" "$record" "$ns" "$rq_instance" "$1"
  case $rl_code in
    0)
      printf '%s\n' "$rq_instance" >>"$cc_state/control/opened"
      put_op 'done' "opened $cc_name $1"
      ;;
    65 | 66 | 73 | 75) put_op refused "$(last_error_line)" ;;
    69) put_op error "no ack within ${RECNRUN_OPEN_TIMEOUT_S:-60} s" ;;
    *) put_op error "open exit $rl_code: $(last_error_line)" ;;
  esac
}
act_open() { launch_clone "$1"; }
act_reopen() {
  close_clone || return 0
  launch_clone "$1"
}
perform() {
  case $rq_action in
    close) act_close ;;
    open-headless) act_open headless ;;
    open-visible) act_open headed ;;
    reopen-headless) act_reopen headless ;;
    reopen-visible) act_reopen headed ;;
  esac
}
