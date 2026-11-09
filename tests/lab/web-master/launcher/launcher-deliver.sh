#!/bin/sh
# Delivery of one offer by launcher.sh: the offer goes into roots/w1/ext/exchange and current.json names
# it; the worker's answer comes back through its downloads and is copied to
# workspace/exchange/w1/answer-<attempt>.json. Sourced by launcher.sh.

ANSWER_MAX=65536
BUSY_MS=30000

# The offer first, then current.json, each by a rename, so the worker never reads a partial file.
offer_in() {
  write_atomic "$ROOT/ext/exchange/offer-$2.json" <"$1/offer.json" || return 1
  printf '{"attempt":"%s","file":"offer-%s.json"}' "$2" "$2" | write_atomic "$ROOT/ext/exchange/current.json"
}

# A complete answer: no .crdownload beside it and the same size on two looks in a row.
# 0 copied out, 1 none within ANSWER_S, 2 larger than ANSWER_MAX.
await_answer() {
  aa_file=$ROOT/downloads/answer-$1.json
  aa_left=$((ANSWER_S * 5)) aa_last=''
  while [ "$aa_left" -gt 0 ]; do
    aa_size=''
    if plain_file "$aa_file" && [ ! -e "$aa_file.crdownload" ]; then aa_size=$(file_size "$aa_file"); fi
    if [ -n "$aa_size" ] && [ "$aa_size" -gt "$ANSWER_MAX" ]; then return 2; fi
    if [ -n "$aa_size" ] && [ "$aa_size" -gt 0 ] && [ "$aa_size" = "$aa_last" ]; then
      answer_out "$1" "$2"
      return
    fi
    aa_last=$aa_size
    sleep 0.2
    aa_left=$((aa_left - 1))
  done
  return 1
}

# The bytes are snapshotted before they are checked again and published.
answer_out() {
  cp -- "$ROOT/downloads/answer-$1.json" "$2/answer.json" || return 1
  [ "$(file_size "$2/answer.json")" -le "$ANSWER_MAX" ] || return 2
  write_atomic "$WS/exchange/w1/answer-$1.json" <"$2/answer.json"
}

# True when the worker's state.json says it is linked or connecting, written in the last 30 s.
worker_busy() {
  wb_file=$ROOT/downloads/state.json
  plain_file "$wb_file" && [ "$(file_size "$wb_file")" -le 4096 ] || return 1
  wb_state=$(sed -n 's/.*"state": *"\([a-z]*\)".*/\1/p' "$wb_file" | head -n 1)
  case $wb_state in linked | connecting) ;; *) return 1 ;; esac
  wb_at=$(sed -n 's/.*"at": *\([0-9]\{1,15\}\).*/\1/p' "$wb_file" | head -n 1)
  [ -n "$wb_at" ] || return 1
  wb_now=$(($(date +%s) * 1000))
  [ $((wb_now - wb_at)) -le "$BUSY_MS" ] && [ "$wb_at" -le $((wb_now + 5000)) ]
}

# One relaunch when the worker gave no answer; never while it is linked to a master.
# 0 answered, 1 no answer (NO_ANSWER), 2 the worker is linked or connecting (BUSY).
deliver_offer() {
  set_phase delivering
  publish_status "$1" delivering -
  offer_in "$2" "$3" || return 1
  do_relaunched=''
  while :; do
    await_answer "$3" "$2"
    case $? in
      0) return 0 ;;
      2) log "the answer to $3 is larger than $ANSWER_MAX bytes" && return 1 ;;
    esac
    ! worker_busy || return 2
    [ -z "$do_relaunched" ] || return 1
    do_relaunched=1
    log "no answer to $3 within $ANSWER_S s: relaunching the worker"
    stop_worker
    lab_holders "$ROOT/chrome"
    [ -z "$holders" ] && launch_worker || return 1
  done
}

# The worker's copies of this attempt go once it is served, whatever the outcome.
clear_delivery() {
  rm -f -- "$ROOT/ext/exchange/current.json" "$ROOT/ext/exchange/offer-$1.json" "$ROOT/downloads/answer-$1.json"
}
