#!/bin/sh
# The work of each launcher tick, sourced by launcher.sh: pairing, requests, provisioning, delivery.

# Settles what an earlier launcher left behind, once, before the first tick.
recover_launcher() {
  recover_requests
  stop_records '*'
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
    provision_root "$1" || { sr_code=$pr_code && return 1; }
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

# A verified request with its offer snapshotted in $2/offer.json.
start_request() {
  retire_request "$1" "$rq_attempt"
  if ensure_worker "$1"; then
    release_request "$1"
    publish_status "$1" delivering -
  else
    release_request "$1"
    log "request $1: $sr_code"
    publish_status "$1" refused "$sr_code"
  fi
  set_phase idle
}
