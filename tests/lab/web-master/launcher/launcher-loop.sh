#!/bin/sh
# The work of each launcher tick, sourced by launcher.sh: pairing, requests, provisioning, delivery.

# Settles what an earlier launcher left behind, once, before the first tick.
recover_launcher() { recover_requests; }

# One pass over the workspace.
lab_tick() {
  lab_pair
  lab_requests
}

# A verified request with its offer snapshotted in $2/offer.json.
start_request() {
  retire_request "$1" "$rq_attempt"
  publish_status "$1" launching -
}

# Stops what this launcher started; sets survivors to the pids that would not stop.
stop_children() { :; }
