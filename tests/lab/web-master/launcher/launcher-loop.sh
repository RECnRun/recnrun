#!/bin/sh
# The work of each launcher tick, sourced by launcher.sh: pairing, requests, provisioning, delivery.

# Settles what an earlier launcher left behind, once, before the first tick.
recover_launcher() {
  recover_requests
  stop_records all
}

# One pass over the workspace.
lab_tick() {
  lab_pair
  lab_requests
}

# A provisioned root that matches this launcher, and its worker running; sets sr_code on a failure.
ensure_worker() {
  sr_code=INSTALL_FAILED
  lab_bundle || { log "the worker extension bundle is not a plain folder" && return 1; }
  if needs_provision; then
    ew_status=0
    provision_root "$1" || ew_status=$?
    [ "$ew_status" -ne 2 ] || sr_code=LAUNCH_FAILED
    [ "$ew_status" -eq 0 ] || return 1
  fi
  ! worker_running || return 0
  sr_code=LAUNCH_FAILED
  set_phase launching
  publish_status "$1" launching -
  stop_worker
  lab_holders "$ROOT/chrome"
  [ -z "$holders" ] || { log "pids $holders name $ROOT/chrome; not launched" && return 1; }
  launch_worker
}

# The worker answers the offer in $2/offer.json for attempt $3; sets sr_code on a failure.
serve_request() {
  ensure_worker "$1" || return 1
  sr_code=NO_ANSWER
  deliver_offer "$1" "$2" "$3" && return 0
  [ "$?" -ne 2 ] || sr_code=BUSY
  return 1
}

# A verified request $1 with its offer snapshotted in $2/offer.json for attempt $3; the answer is
# copied out before the inbox goes, and the terminal status is published last.
start_request() {
  retire_request "$1" "$3"
  if serve_request "$1" "$2" "$3"; then
    clear_delivery "$3"
    release_request "$1"
    publish_status "$1" answered -
  else
    clear_delivery "$3"
    release_request "$1"
    log "request $1: $sr_code"
    publish_status "$1" refused "$sr_code"
  fi
  set_phase idle
}
