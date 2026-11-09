#!/bin/sh
# Launch requests of launcher.sh: workspace/requests/<rid>.req, master-signed, checked only on a
# snapshot in state/inbox/<rid>/; every outcome is published in workspace/status/<rid>.status.
# Sourced by launcher.sh.

REQUEST_MAX=8
REQUEST_HEADER='recnrun-lab-request v1'
status_seq=0

# state is verifying, installing, launching, delivering, answered, or refused; code is one of the ten status codes, or -.
publish_status() {
  status_seq=$((status_seq + 1))
  printf 'recnrun-lab-status v1\nrequest=%s\nsession=%s\nstate=%s\ncode=%s\nat=%s\nseq=%s\n' \
    "$1" "$SESSION" "$2" "$3" "$(date +%s)" "$status_seq" | write_atomic "$WS/status/$1.status"
}

# The offer is named only once a verified signature vouches for its attempt.
retire_request() {
  printf '%s\n' "$1" >>"$STATE/consumed"
  rm -f -- "$WS/requests/$1.req"
  [ -z "${2:-}" ] || rm -f -- "$WS/exchange/w1/offer-$2.json"
}
# The snapshot and the claim go only once the request is served.
release_request() {
  rm -rf -- "$STATE/inbox/$1"
  rmdir -- "$STATE/claims/$1" 2>/dev/null || :
}

# The status comes last, so a site that sees it finds the request already retired.
fail_request() {
  retire_request "$1" "${3:-}"
  release_request "$1"
  log "request $1: $2"
  publish_status "$1" refused "$2"
}

# The workspace id the site wrote into recnrun-workspace.json; empty when there is none.
workspace_id() {
  wi_file=$WS/recnrun-workspace.json
  plain_file "$wi_file" && [ "$(file_size "$wi_file")" -le 4096 ] || return 0
  wi_id=$(sed -n 's/.*"workspaceId": *"\([0-9a-f-]*\)".*/\1/p' "$wi_file" | head -n 1)
  ! lab_is_uuid "$wi_id" || printf '%s\n' "$wi_id"
}

# Sets pv_out to the value of a "<name>=" line; fails on any other line.
pv() {
  case $2 in "$1="*) pv_out=${2#"$1="} ;; *) return 1 ;; esac
}

# The exact ten lines, printable ASCII, each ending in a newline, at most 1024 bytes.
request_shape() {
  [ "$(file_size "$1")" -le 1024 ] || return 1
  [ "$(LC_ALL=C tr -d '\n -~' <"$1" | wc -c | tr -d ' ')" = 0 ] || return 1
  [ "$(tail -c 1 "$1" | lab_hex)" = 0a ] || return 1
  [ "$(wc -l <"$1" | tr -d ' ')" = 10 ]
}

# Reads a snapshotted request into rq_*; any value outside its grammar fails.
parse_request() {
  request_shape "$1" || return 1
  {
    IFS= read -r p1 && IFS= read -r p2 && IFS= read -r p3 && IFS= read -r p4 && IFS= read -r p5 &&
      IFS= read -r p6 && IFS= read -r p7 && IFS= read -r p8 && IFS= read -r p9 && IFS= read -r p10
  } <"$1" || return 1
  [ "$p1" = "$REQUEST_HEADER" ] && [ "$p5" = action=start ] && [ "$p6" = root=w1 ] || return 1
  pv workspace "$p2" && rq_workspace=$pv_out && lab_is_uuid "$rq_workspace" || return 1
  pv session "$p3" && rq_session=$pv_out && is_hex "$rq_session" 16 || return 1
  pv request "$p4" && [ "$pv_out" = "$2" ] || return 1
  pv offer "$p7" && rq_offer=$pv_out && is_hex "$rq_offer" 64 || return 1
  pv attempt "$p8" && rq_attempt=$pv_out && lab_is_uuid "$rq_attempt" || return 1
  pv expires "$p9" && rq_expires=$pv_out || return 1
  case $rq_expires in [1-9] | [1-9]*[0-9]) ;; *) return 1 ;; esac
  case $rq_expires in *[!0-9]* | ???????????*) return 1 ;; esac
  pv sig "$p10" && rq_sig=$pv_out || return 1
  case $rq_sig in '' | *[!A-Za-z0-9+/=]*) return 1 ;; esac
}

# Copies the offer the request names and proves its sha256.
snapshot_offer() {
  so_src=$WS/exchange/w1/offer-$rq_attempt.json
  plain_file "$so_src" && [ "$(file_size "$so_src")" -le 65536 ] && cp -- "$so_src" "$1/offer.json" || return 1
  [ "$(lab_sha256 "$1/offer.json")" = "$rq_offer" ]
}

# Sets rq_code to the first failed check, in the plan's order, or to empty; rq_signed after the signature.
check_request() {
  rq_code=BAD_FORMAT rq_signed=''
  parse_request "$1/request" "$2" || return 0
  [ "$rq_workspace" = "$WORKSPACE_ID" ] || return 0
  rq_code=LAUNCHER_RESTARTED
  [ "$rq_session" = "$SESSION" ] || return 0
  cr_now=$(date +%s)
  rq_code=EXPIRED
  [ "$rq_expires" -gt "$cr_now" ] && [ "$rq_expires" -le $((cr_now + 120)) ] || return 0
  rq_code=REPLAY
  ! grep -Fqx -- "$2" "$STATE/consumed" 2>/dev/null || return 0
  rq_code=NOT_PAIRED
  [ -f "$STATE/master.pem" ] || return 0
  head -n 9 "$1/request" >"$1/body"
  rq_code=BAD_SIGNATURE
  lab_verify "$STATE/master.pem" "$1/body" "$rq_sig" || return 0
  rq_signed=$rq_attempt rq_code=BAD_FORMAT
  snapshot_offer "$1" || return 0
  rq_code=''
}

handle_request() {
  hr_name=${1##*/}
  hr_rid=${hr_name%.req}
  if ! lab_is_uuid "$hr_rid"; then
    rm -f -- "$1"
    log "requests/$hr_name is not named <uuid>.req; deleted"
    return 0
  fi
  mkdir -- "$STATE/claims/$hr_rid" 2>/dev/null || return 0
  hr_box=$STATE/inbox/$hr_rid
  rm -rf -- "$hr_box"
  mkdir -- "$hr_box" || die 73 "cannot create $hr_box"
  if ! plain_file "$1" || [ "$(file_size "$1")" -gt 1024 ] || ! cp -- "$1" "$hr_box/request"; then
    fail_request "$hr_rid" BAD_FORMAT
    return 0
  fi
  check_request "$hr_box" "$hr_rid"
  if [ -n "$rq_code" ]; then
    fail_request "$hr_rid" "$rq_code" "$rq_signed"
  else
    start_request "$hr_rid" "$hr_box"
  fi
}

lab_requests() {
  WORKSPACE_ID=$(workspace_id)
  lr_count=0
  for lr_path in "$WS/requests/"*.req; do
    [ -e "$lr_path" ] || [ -L "$lr_path" ] || continue
    [ "$lr_count" -lt "$REQUEST_MAX" ] || break
    lr_count=$((lr_count + 1))
    handle_request "$lr_path"
  done
}

# A claim still held at start belongs to a launcher that died while serving it.
recover_requests() {
  for rr_claim in "$STATE/claims/"*; do
    [ -d "$rr_claim" ] || continue
    rr_rid=${rr_claim##*/}
    if lab_is_uuid "$rr_rid"; then
      fail_request "$rr_rid" LAUNCHER_RESTARTED
    else
      rm -rf -- "$rr_claim"
    fi
  done
}
