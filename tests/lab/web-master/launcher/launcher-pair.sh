#!/bin/sh
# Pairing of launcher.sh: the site offers its master key in workspace/pairing/master.spki, and one
# terminal "y" or --pair with the same fingerprint pins it in state/. Sourced by launcher.sh.

# Succeeds only on --pair with the same fingerprint or a typed y; no terminal is a refusal.
pair_confirm() {
  if [ -n "$PAIR" ]; then
    [ "$PAIR" = "$1" ] && return 0
    pair_reason='it does not match --pair'
    return 1
  fi
  if ! (: </dev/tty) 2>/dev/null; then
    pair_reason='no terminal to confirm on; start the launcher with --pair <fingerprint>'
    return 1
  fi
  set_phase pairing
  printf 'Site shows master %s? [y/N] ' "$(lab_fp_display "$1")" >/dev/tty
  pc_answer=''
  read -r pc_answer </dev/tty || pc_answer=''
  set_phase idle
  case $pc_answer in y | Y | yes) return 0 ;; esac
  pair_reason='not confirmed'
  return 1
}

pair_accept() {
  mv -f -- "$1" "$STATE/master.spki"
  mv -f -- "$1.pem" "$STATE/master.pem"
  printf '%s\n' "$2" | write_atomic "$STATE/paired"
  printf 'paired=%s\n' "$2"
  log "paired with master $(lab_fp_display "$2")"
}

# The fingerprint in state/paired when a master is pinned; empty otherwise.
paired_fp() {
  pf_value=''
  [ ! -f "$STATE/paired" ] || read -r pf_value <"$STATE/paired" || :
  is_hex "$pf_value" 64 && printf '%s\n' "$pf_value"
}

# One look at pairing/master.spki: the bytes are snapshotted, the workspace file always deleted.
lab_pair() {
  lp_src=$WS/pairing/master.spki
  [ -e "$lp_src" ] || [ -L "$lp_src" ] || return 0
  # Chrome creates the file empty before it renames the written swap file onto it.
  ! plain_file "$lp_src" || [ -s "$lp_src" ] || return 0
  lp_snap=$STATE/inbox/master.spki
  rm -f -- "$lp_snap" "$lp_snap.pem"
  if ! plain_file "$lp_src" || [ "$(file_size "$lp_src")" -gt 91 ] || ! cp -- "$lp_src" "$lp_snap"; then
    rm -f -- "$lp_src"
    log 'pairing/master.spki is not a plain 91-byte file; deleted'
    return 0
  fi
  rm -f -- "$lp_src"
  if ! lab_spki "$lp_snap" "$lp_snap.pem"; then
    rm -f -- "$lp_snap" "$lp_snap.pem"
    log 'pairing/master.spki is not a P-256 public key; deleted'
    return 0
  fi
  lp_fp=$(lab_sha256 "$lp_snap") || die 70 'cannot hash the master key'
  lp_old=$(paired_fp)
  if [ -n "$lp_old" ]; then
    [ "$lp_fp" = "$lp_old" ] ||
      log "master key changed to $(lab_fp_display "$lp_fp"); refused, still paired with $(lab_fp_display "$lp_old"). To pair the new key, stop the launcher, run in $LAB: rm state/master.spki state/master.pem state/paired, and start it again"
    rm -f -- "$lp_snap" "$lp_snap.pem"
  elif pair_confirm "$lp_fp"; then
    pair_accept "$lp_snap" "$lp_fp"
  else
    rm -f -- "$lp_snap" "$lp_snap.pem"
    printf 'rejected\n' | write_atomic "$STATE/paired"
    log "master $(lab_fp_display "$lp_fp") refused: $pair_reason"
  fi
}
