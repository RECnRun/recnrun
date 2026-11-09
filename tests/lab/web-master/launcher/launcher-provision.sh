#!/bin/sh
# Provisioning of roots/w1 by launcher.sh: a root it marks as its own, a profile seeded by base.sh, the
# bundled worker extension with policy.json and the worker identity, installed by install.sh, proven
# by the worker's self-test, and recorded in roots/w1/provisioned. Sourced by launcher.sh.

# The bundled worker extension: a plain folder with a manifest, no link, and no odd name inside.
lab_bundle() {
  BUNDLE=${RECNRUN_LAB_BUNDLE:-$HERE/../worker-extension}
  BUNDLE=$(CDPATH='' cd -- "$BUNDLE" && pwd -P) || return 1
  plain_file "$BUNDLE/manifest.json" || return 1
  [ -z "$(find "$BUNDLE" -type l | head -n 1)" ] || return 1
  [ -z "$(find "$BUNDLE" -name '*[!A-Za-z0-9._-]*' | head -n 1)" ] || return 1
  BUNDLE_DIGEST=$(bundle_digest "$BUNDLE")
  is_hex "$BUNDLE_DIGEST" 64
}

# sha256 over the sorted relative paths, each with its size and bytes; the generated files are left out.
bundle_digest() {
  (cd -- "$1" && find . -type f ! -path ./policy.json ! -path ./identity.pk8 ! -path './exchange/*' | LC_ALL=C sort) |
    while IFS= read -r bd_file; do
      printf '%s\n%s\n' "$bd_file" "$(file_size "$1/$bd_file")"
      cat -- "$1/$bd_file"
    done | "$OPENSSL" dgst -sha256 -binary | lab_hex
}

# The lines of roots/w1/provisioned that must equal this launcher, its bundle, and its pairing.
provision_head() {
  printf '%s' "$ALLOW_JSON" >"$STATE/allow.json"
  printf 'launcherVersion=%s\nextensionVersion=%s\nbundleDigest=%s\nmasterFp=%s\nallowDigest=%s\nworkspace=%s\n' \
    "$RELEASE_VERSION" "$RELEASE_EXTENSION" "$BUNDLE_DIGEST" "$(paired_fp)" \
    "$(lab_sha256 "$STATE/allow.json")" "$WORKSPACE_ID"
}
needs_provision() {
  plain_file "$ROOT/.recnrun-lab-root" && plain_file "$ROOT/provisioned" || return 0
  provision_head >"$STATE/provisioned.want"
  ! head -n 6 "$ROOT/provisioned" | cmp -s - "$STATE/provisioned.want"
}

# Only a root this launcher marked is ever deleted.
clear_root() {
  [ ! -L "$ROOT" ] || return 1
  [ -e "$ROOT" ] || return 0
  plain_file "$ROOT/.recnrun-lab-root" || return 1
  rm -rf -- "$ROOT"
}

next_generation() {
  ng_value=0
  [ ! -f "$STATE/generation" ] || read -r ng_value <"$STATE/generation" || :
  is_count "$ng_value" || ng_value=0
  generation=$((ng_value + 1))
  printf '%s\n' "$generation" | write_atomic "$STATE/generation"
}

# The worker key is kept in state/ across provisionings, so the site's pin of the worker holds.
worker_identity() {
  if plain_file "$STATE/w1.key"; then
    lab_worker_derive "$STATE/w1.key" "$ROOT/ext/identity.pk8" "$STATE/w1.spki"
  else
    lab_worker_key "$STATE/w1.key" "$ROOT/ext/identity.pk8" "$STATE/w1.spki"
  fi || return 1
  WORKER_FP=$(lab_sha256 "$STATE/w1.spki") || return 1
  WORKER_SPKI=$("$OPENSSL" base64 -A <"$STATE/w1.spki")
}

write_policy() {
  wp_master=$("$OPENSSL" base64 -A <"$STATE/master.spki") || return 1
  printf '{"v":1,"workspace":"%s","root":"w1","generation":%s,"masterSpki":"%s","allow":%s,"interactEnabled":true,"viewport":{"minWidth":320,"minHeight":240,"maxWidth":1920,"maxHeight":1080}}' \
    "$WORKSPACE_ID" "$generation" "$wp_master" "$ALLOW_JSON" >"$ROOT/ext/policy.json"
}

# The marked root, its seeded profile, and the bundle copied and proven unchanged.
build_root() {
  mkdir -- "$ROOT" || return 1
  : >"$ROOT/.recnrun-lab-root" || return 1
  sh "$LIB/base.sh" seed-root "$ROOT/chrome" "$ROOT/downloads" </dev/null >>"$STATE/install.log" 2>&1 || return 1
  mkdir -- "$ROOT/ext" || return 1
  cp -R -- "$BUNDLE/." "$ROOT/ext/" || return 1
  rm -rf -- "$ROOT/ext/policy.json" "$ROOT/ext/identity.pk8" "$ROOT/ext/exchange"
  [ "$(bundle_digest "$ROOT/ext")" = "$BUNDLE_DIGEST" ] && mkdir -- "$ROOT/ext/exchange"
}

# The Chrome pid install.sh logs, recorded once so a stop can verify it.
note_install_pid() {
  [ -z "${inst_chrome:-}" ] || return 0
  inst_chrome=$(sed -n 's/^install\.sh: pid=\([0-9][0-9]*\)$/\1/p' "$STATE/install.err" 2>/dev/null | head -n 1)
  [ -z "$inst_chrome" ] || record_pid install "$inst_chrome" "$(lab_chrome)" || :
}

# install.sh install-root in the background, so the launcher's traps still run while it waits.
run_install() {
  inst_chrome=''
  RECNRUN_OPEN_TIMEOUT_S=$INSTALL_S sh "$LIB/install.sh" install-root "$ROOT" "provisioned-$generation.json" \
    </dev/null >"$STATE/install.out" 2>"$STATE/install.err" &
  inst_pid=$!
  ri_left=$((INSTALL_S * 20))
  while pid_alive "$inst_pid"; do
    note_install_pid
    if [ "$ri_left" -le 0 ]; then
      log "install.sh still runs after $((INSTALL_S * 4)) s: stopped"
      kill -TERM "$inst_pid" 2>/dev/null
      break
    fi
    sleep 0.2
    ri_left=$((ri_left - 1))
  done
  wait "$inst_pid"
  ri_status=$?
  inst_pid=''
  note_install_pid
  cat -- "$STATE/install.err" >>"$STATE/install.log"
  stop_records install
  [ "$ri_status" -eq 0 ] || log "install.sh exited $ri_status (state/install.log)"
  [ "$ri_status" -eq 0 ]
}

# The worker downloads exactly these bytes once it loaded this policy with this identity.
check_selftest() {
  cs_file=$ROOT/downloads/provisioned-$generation.json
  plain_file "$cs_file" && [ "$(file_size "$cs_file")" -le 4096 ] || return 1
  printf '{"generation":%s,"extensionVersion":"%s","policyDigest":"%s","workerSpki":"%s","fileRead":false}' "$generation" \
    "$RELEASE_EXTENSION" "$(lab_sha256 "$ROOT/ext/policy.json")" "$WORKER_SPKI" | cmp -s - "$cs_file"
}

# 2 when the root is held or not ours (LAUNCH_FAILED), 1 when the install failed (INSTALL_FAILED).
provision_root() {
  set_phase installing
  publish_status "$1" installing -
  stop_worker
  lab_holders "$ROOT/chrome"
  [ -z "$holders" ] || { log "pids $holders name $ROOT/chrome; not provisioned" && return 2; }
  clear_root || { log "$ROOT is not a root this launcher made" && return 2; }
  next_generation
  build_root && worker_identity && write_policy && run_install || return 1
  check_selftest || { log "no self-test of generation $generation" && return 1; }
  { provision_head && printf 'workerFp=%s\ngeneration=%s\n' "$WORKER_FP" "$generation"; } |
    write_atomic "$ROOT/provisioned"
  write_atomic "$WS/peers/w1/worker.spki" <"$STATE/w1.spki"
  printf 'worker=%s\n' "$WORKER_FP"
  log "provisioned generation $generation, worker $(lab_fp_display "$WORKER_FP")"
}
