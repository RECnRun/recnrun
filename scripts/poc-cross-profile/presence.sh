#!/bin/sh
# presence.sh: the exact bytes of one presence file (POC PLAN.md P2.3), sourced by catalog.sh.
#
# A presence counts only in the exact bytes the extension writes, JSON.stringify of a
# RegistrationSchema value with no spaces and keys in order:
#   {"profileId":"<uuid>","displayName":"<name>","fingerprint":"<hex:>",
#    "identity":{"key":"<87 base64url>","signedAt":<ms>,"signature":"<86 base64url>"},
#    "createdAt":<ms>,"expiresAt":<ms>,"namespace":"<namespace>","boot":"<v4 uuid>"}
# where the profile id is a lowercase v4 uuid naming its folder, the boot a lowercase v4 uuid,
# the namespace the one asked for, the name 1 to 64 bytes with no backslash, quote, control
# character, or edge space, the identity statement in form only (the extension verifies its
# signature, and the registry does not carry it), the times whole numbers up to 2^53 - 1, createdAt
# at most 5000 ms ahead of this clock, and expiresAt after now, after createdAt, and at most
# 60000 ms after createdAt. read_presence <folder> <name> <namespace> <now-ms> prints the tab-separated
# row id, name, fingerprint, createdAt, expiresAt, boot and returns 0, or prints the reason and returns 1.

# No import from sh: CLOCK_SKEW_MS (downloads-rendezvous.ts) and PRESENCE_TTL_MS (folder-rendezvous.ts).
clock_skew_ms=5000
presence_ttl_ms=60000

# RegistrySchema's TimeSchema: a safe integer, so at most Number.MAX_SAFE_INTEGER.
is_time() {
  case $1 in '' | *[!0-9]* | 0?*) return 1 ;; esac
  [ "${#1}" -le 16 ] && [ "$1" -le 9007199254740991 ]
}
# An unpadded base64url string of exactly $2 characters.
is_base64url() {
  case $1 in *[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -eq "$2" ]
}
is_display_name() {
  case $1 in '' | ' '* | *' ' | *\\* | *[[:cntrl:]]*) return 1 ;; esac
  [ "${#1}" -le 64 ]
}

# Consumes the literal $1 from $rest, then the value up to the literal $2.
take() {
  case $rest in "$1"*) rest=${rest#"$1"} ;; *) reason="expected $1"; return 1 ;; esac
  case $rest in *"$2"*) ;; *) reason="nothing ends the value after $1"; return 1 ;; esac
  value=${rest%%"$2"*}
  rest=${rest#"$value"}
}
# Reads the fields in the one order and form JSON.stringify gives them, checking each.
parse_presence() {
  file=$1/presence.json
  if [ -L "$file" ] || [ ! -f "$file" ]; then reason='no presence.json file'; return 1; fi
  size=$(wc -c <"$file" | tr -d ' ')
  if [ "$size" -gt 2048 ]; then reason="$size bytes, more than a presence"; return 1; fi
  rest=$(cat -- "$file")
  if [ "${#rest}" -ne "$size" ]; then reason='not the exact bytes of one presence'; return 1; fi
  take '{"profileId":"' '"' || return 1
  if [ "$value" != "$2" ]; then reason='its profileId is not its folder'; return 1; fi
  pr_id=$value
  take '","displayName":"' '"' || return 1
  is_display_name "$value" || { reason='invalid displayName'; return 1; }
  pr_name=$value
  take '","fingerprint":"' '"' || return 1
  is_fingerprint "$value" || { reason='invalid fingerprint'; return 1; }
  pr_fingerprint=$value
  take '","identity":{"key":"' '"' || return 1
  is_base64url "$value" 87 || { reason='invalid identity key'; return 1; }
  take '","signedAt":' ',' || return 1
  is_time "$value" || { reason='invalid identity signedAt'; return 1; }
  take ',"signature":"' '"' || return 1
  is_base64url "$value" 86 || { reason='invalid identity signature'; return 1; }
  take '"},"createdAt":' ',' || return 1
  is_time "$value" || { reason='invalid createdAt'; return 1; }
  pr_created=$value
  case $rest in ',"expiresAt":'*) rest=${rest#',"expiresAt":'} ;; *) reason='expected ,"expiresAt":'; return 1 ;; esac
  value=${rest%%[!0-9]*}
  rest=${rest#"$value"}
  is_time "$value" || { reason='invalid expiresAt'; return 1; }
  pr_expires=$value
  take ',"namespace":"' '"' || return 1
  if [ "$value" != "$3" ]; then reason='another namespace'; return 1; fi
  take '","boot":"' '"' || return 1
  is_v4 "$value" || { reason='invalid boot'; return 1; }
  pr_boot=$value
  if [ "$rest" != '"}' ]; then reason='extra keys or text after boot'; return 1; fi
  fresh "$4"
}
# A closed profile drops out within one TTL: no stamp ahead of the skew, no longer lifetime.
# The two checks that need no clock come first, so their reasons do not depend on when this runs.
fresh() {
  if [ "$pr_expires" -le "$pr_created" ]; then reason='expiresAt is not after createdAt'; return 1; fi
  if [ $((pr_expires - pr_created)) -gt "$presence_ttl_ms" ]; then
    reason="it lives longer than $presence_ttl_ms ms"
    return 1
  fi
  if [ "$pr_expires" -le "$1" ]; then reason='expired'; return 1; fi
  if [ "$pr_created" -gt $(($1 + clock_skew_ms)) ]; then reason='createdAt is ahead of this clock'; return 1; fi
}
read_presence() {
  if parse_presence "$@"; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$pr_id" "$pr_name" "$pr_fingerprint" "$pr_created" "$pr_expires" "$pr_boot"
  else
    printf '%s\n' "$reason"
    return 1
  fi
}
