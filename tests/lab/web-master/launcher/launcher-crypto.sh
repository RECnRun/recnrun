#!/bin/sh
# openssl helpers of the lab launcher; every argument is a path or a checked token, never request text to run.

SPKI_PREFIX=3059301306072a8648ce3d020106082a8648ce3d030107034200

# macOS ships LibreSSL at /usr/bin/openssl; a PATH lookup could pick another build.
lab_openssl() {
  if [ -n "${RECNRUN_LAB_OPENSSL:-}" ]; then
    OPENSSL=$RECNRUN_LAB_OPENSSL
  elif [ "$(uname -s)" = Darwin ]; then
    OPENSSL=/usr/bin/openssl
  else
    OPENSSL=$(command -v openssl) || return 1
  fi
}

lab_hex() { od -An -v -tx1 | tr -d ' \n'; }

lab_sha256() {
  digest=$("$OPENSSL" dgst -sha256 -binary <"$1" | lab_hex) || return 1
  [ ${#digest} -eq 64 ] || return 1
  printf '%s\n' "$digest"
}

lab_fp_display() {
  printf '%s\n' "$1" | cut -c1-20 | sed 's/\(....\)/\1 /g; s/ $//'
}

# A P-256 SPKI is exactly 91 bytes behind a fixed 26-byte header; openssl then checks the point.
lab_spki() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  [ "$(wc -c <"$1" | tr -d ' ')" = 91 ] || return 1
  [ "$(head -c 26 "$1" | lab_hex)" = "$SPKI_PREFIX" ] || return 1
  "$OPENSSL" pkey -pubin -inform DER -in "$1" -out "$2" 2>/dev/null
}

lab_verify() {
  sig="$2.sig"
  printf '%s\n' "$3" | "$OPENSSL" base64 -d -A >"$sig" 2>/dev/null || return 2
  "$OPENSSL" dgst -sha256 -verify "$1" -signature "$sig" "$2" >/dev/null 2>&1
  status=$?
  rm -f "$sig"
  return "$status"
}

lab_worker_key() {
  "$OPENSSL" ecparam -name prime256v1 -genkey -noout -out "$1" 2>/dev/null || return 1
  "$OPENSSL" pkcs8 -topk8 -nocrypt -outform DER -in "$1" -out "$2" 2>/dev/null || return 1
  "$OPENSSL" pkey -in "$1" -pubout -outform DER -out "$3" 2>/dev/null
}
