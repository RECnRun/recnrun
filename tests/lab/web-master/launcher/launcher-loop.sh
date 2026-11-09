#!/bin/sh
# The work of each launcher tick, sourced by launcher.sh: pairing, requests, provisioning, delivery.

# Settles what an earlier launcher left behind, once, before the first tick.
recover_launcher() { :; }

# One pass over the workspace.
lab_tick() { :; }

# Stops what this launcher started; sets survivors to the pids that would not stop.
stop_children() { :; }
