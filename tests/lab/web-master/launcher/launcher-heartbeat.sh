#!/bin/sh
# launcher-heartbeat.sh <lab> <session> <launcher-pid> <seconds> <version> <extensionVersion>
#
# The heartbeat writer launcher.sh starts in the background. Each tick it first proves that the
# launcher pid lives and that state/session is still its own session, else it exits without writing,
# so a killed launcher's heartbeat freezes and an old writer never speaks for a new launcher.
# Lines: recnrun-lab-heartbeat v1, session, seq, at, state, paired, launcher, extension.

lab=$1 session=$2 owner=$3 tick=$4 version=$5 extension=$6
beat=$lab/workspace/launcher/heartbeat
tmp=$lab/workspace/launcher/.heartbeat.$$.tmp
seq=0
while :; do
  kill -0 "$owner" 2>/dev/null || exit 0
  current=
  read -r current <"$lab/state/session" 2>/dev/null || exit 0
  [ "$current" = "$session" ] || exit 0
  phase=idle
  read -r phase <"$lab/state/phase" 2>/dev/null || :
  paired=none
  read -r paired <"$lab/state/paired" 2>/dev/null || :
  seq=$((seq + 1))
  printf 'recnrun-lab-heartbeat v1\nsession=%s\nseq=%s\nat=%s\nstate=%s\npaired=%s\nlauncher=%s\nextension=%s\n' \
    "$session" "$seq" "$(date +%s)" "$phase" "$paired" "$version" "$extension" >"$tmp" || exit 0
  mv -f -- "$tmp" "$beat" || exit 0
  sleep "$tick"
done
