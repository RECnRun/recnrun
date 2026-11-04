#!/bin/sh
# catalog.sh <record-file> <namespace> <out-dir>
#
# The launcher's catalog writer (POC PLAN.md P2.3, decision 11), the single writer of
# <out-dir>/registry.json. POSIX sh only: macOS /bin/sh and Debian dash, no JSON parser.
#
# Record file: the launcher's own key=value lines, one record per block, blocks separated by a
# blank line; keys userDataDir, profileDirectory, profileId, namespace, role (master, worker,
# template), masterFingerprint, downloadsRoot, root. Directories are absolute, use only
# [A-Za-z0-9._:/ -], and have no .. segment; root is r plus 1 to 3 digits. Every
# downloadsRoot is scanned; one without a root id gets the next free r<n>, written back.
#
# Scan: <downloadsRoot>/RECnRun/poc/<namespace>/peers/<uuid>/presence.json, nothing else, no
# symbolic link followed. A presence counts only in the exact bytes the extension writes,
# JSON.stringify of a RegistrationSchema value with no spaces and keys in order:
#   {"profileId":"<uuid>","displayName":"<name>","fingerprint":"<hex:>","createdAt":<ms>,
#    "expiresAt":<ms>,"namespace":"<namespace>","boot":"<v4 uuid>"}
# where the profile id names its folder, the namespace is the one asked for, the name is 1 to
# 64 bytes with no backslash, quote, control character, or edge space, and the times are whole
# numbers; anything else is skipped with a reason on stderr. The boot goes into the registry.
# No value read from a file is ever run or expanded.
#
# Exit: 0 written, 64 wrong call, 65 invalid record, 66 no record, 73 cannot write,
# 75 another run holds <out-dir>/.catalog.lock (nothing written).
set -eu
LC_ALL=C
export LC_ALL
umask 077

nl='
'
tab=$(printf '\t')
max_peers=32

log() { printf 'catalog.sh: %s\n' "$*" >&2; }
fail() {
  status=$1
  shift
  log "$*"
  exit "$status"
}

# --- Value checks ---------------------------------------------------------------------------

is_uuid() {
  case $1 in *[!0-9a-f-]*) return 1 ;; esac
  case $1 in ????????-????-????-????-????????????) return 0 ;; esac
  return 1
}
is_namespace() {
  case $1 in '' | *[!a-z0-9-]*) return 1 ;; esac
  [ "${#1}" -le 40 ]
}
is_directory() {
  case $1 in /*) ;; *) return 1 ;; esac
  case $1 in *[!A-Za-z0-9._:/\ -]*) return 1 ;; esac
  case /$1/ in */../*) return 1 ;; esac
  [ "${#1}" -le 1024 ]
}
is_profile_directory() {
  case $1 in '' | . | .. | *[!A-Za-z0-9._:\ -]*) return 1 ;; esac
  [ "${#1}" -le 255 ]
}
is_fingerprint() {
  case $1 in '' | *[!0-9A-F:]*) return 1 ;; esac
  [ "${#1}" -le 200 ]
}
is_boot() {
  is_uuid "$1" || return 1
  case $1 in ????????-????-4???-[89ab]???-????????????) return 0 ;; esac
  return 1
}
is_root_id() {
  case $1 in r[0-9] | r[0-9][0-9] | r[0-9][0-9][0-9]) return 0 ;; esac
  return 1
}
is_time() {
  case $1 in '' | *[!0-9]* | 0?*) return 1 ;; esac
  [ "${#1}" -le 16 ]
}
is_display_name() {
  case $1 in '' | ' '* | *' ' | *\\* | *[[:cntrl:]]*) return 1 ;; esac
  [ "${#1}" -le 64 ]
}
# Folder names come from other profiles; only safe characters reach the log.
shown() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '?'; }

# --- Arguments and lock ---------------------------------------------------------------------

[ "$#" -eq 3 ] || fail 64 'usage: catalog.sh <record-file> <namespace> <out-dir>'
record=$1
namespace=$2
out=$3
is_namespace "$namespace" || fail 64 'the namespace must be [a-z0-9-]{1,40}'
boot=${RECNRUN_LAUNCHER_BOOT:-}
if [ -n "$boot" ]; then is_uuid "$boot" || fail 64 'RECNRUN_LAUNCHER_BOOT must be a uuid'; fi
if [ ! -r "$record" ] || [ -d "$record" ]; then fail 66 'no readable record file'; fi
[ -d "$out" ] || fail 73 'no output directory'

lock=$out/.catalog.lock
held=0
tmp=
record_tmp=
cleanup() {
  if [ -n "$tmp" ]; then rm -f -- "$tmp"; fi
  if [ -n "$record_tmp" ]; then rm -f -- "$record_tmp"; fi
  if [ "$held" = 1 ]; then rmdir -- "$lock" 2>/dev/null || :; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# mkdir is atomic: exactly one run creates the lock; the others leave it alone.
if mkdir -- "$lock" 2>/dev/null; then held=1; else fail 75 "another run holds $lock"; fi

# Read once, so both passes see the same record.
if [ -f "$record" ] && [ "$(wc -c <"$record" | tr -d ' ')" -gt 65536 ]; then
  fail 65 'the record file is over 64 KiB'
fi
record_text=$(cat -- "$record")
[ "${#record_text}" -le 65536 ] || fail 65 'the record file is over 64 KiB'

# --- Record ---------------------------------------------------------------------------------

# Root ids and their Downloads roots, one "id|path" line each ("|" is outside both sets).
map=
found=
id_of() {
  found=
  while IFS='|' read -r m_id m_path; do
    if [ -n "$m_id" ] && [ "$m_path" = "$1" ]; then found=$m_id; fi
  done <<EOF
$map
EOF
}
path_of() {
  found=
  while IFS='|' read -r m_id m_path; do
    if [ "$m_id" = "$1" ]; then found=$m_path; fi
  done <<EOF
$map
EOF
}
next_free_id() {
  n=1
  while :; do
    [ "$n" -le 999 ] || fail 65 'more than 999 Downloads roots'
    path_of "r$n"
    if [ -z "$found" ]; then return 0; fi
    n=$((n + 1))
  done
}

block_reset() {
  b_user= b_profile= b_downloads= b_root= b_seen=' ' b_start=0
}
bad_value() { fail 65 "record line $lineno: invalid $1"; }
set_key() {
  case $b_seen in *" $1 "*) fail 65 "record line $lineno: repeated key $1" ;; esac
  b_seen="$b_seen$1 "
  [ -n "$2" ] || fail 65 "record line $lineno: empty value for $1"
  case $1 in
    userDataDir) is_directory "$2" || bad_value "$1"; b_user=$2 ;;
    profileDirectory) is_profile_directory "$2" || bad_value "$1"; b_profile=$2 ;;
    profileId) is_uuid "$2" || bad_value "$1" ;;
    namespace) is_namespace "$2" || bad_value "$1" ;;
    role) case $2 in master | worker | template) ;; *) bad_value "$1" ;; esac ;;
    masterFingerprint) is_fingerprint "$2" || bad_value "$1" ;;
    downloadsRoot) is_directory "$2" || bad_value "$1"; b_downloads=$2 ;;
    root) is_root_id "$2" || bad_value "$1"; b_root=$2 ;;
    *) fail 65 "record line $lineno: unknown key" ;;
  esac
}
# Pass 1 learns the ids the record names; pass 2 numbers the other roots and rewrites.
end_block() {
  [ "$b_start" -ne 0 ] || return 0
  where="record block at line $b_start"
  if { [ -z "$b_user" ] && [ -n "$b_profile" ]; } || { [ -n "$b_user" ] && [ -z "$b_profile" ]; }; then
    fail 65 "$where: userDataDir and profileDirectory go together"
  fi
  if [ -z "$b_user" ] && [ -z "$b_downloads" ]; then fail 65 "$where: names no profile or root"; fi
  if [ -n "$b_root" ] && [ -z "$b_downloads" ]; then fail 65 "$where: root without downloadsRoot"; fi
  [ -n "$b_downloads" ] || return 0
  if [ "$1" = 1 ]; then
    [ -n "$b_root" ] || return 0
    id_of "$b_downloads"
    if [ -n "$found" ] && [ "$found" != "$b_root" ]; then fail 65 "$where: one root under two ids"; fi
    path_of "$b_root"
    if [ -n "$found" ] && [ "$found" != "$b_downloads" ]; then fail 65 "$where: $b_root names two roots"; fi
    if [ -z "$found" ]; then map="$map$b_root|$b_downloads$nl"; fi
  elif [ -z "$b_root" ]; then
    id_of "$b_downloads"
    if [ -z "$found" ]; then
      next_free_id
      found=r$n
      map="$map$found|$b_downloads$nl"
    fi
    rewritten="${rewritten}root=$found$nl"
    changed=1
  fi
}
read_record() {
  block_reset
  lineno=0
  while IFS= read -r line; do
    lineno=$((lineno + 1))
    if [ -z "$line" ]; then
      end_block "$1"
      block_reset
      rewritten="$rewritten$nl"
      continue
    fi
    [ "$b_start" -ne 0 ] || b_start=$lineno
    case $line in *=*) ;; *) fail 65 "record line $lineno: expected key=value" ;; esac
    set_key "${line%%=*}" "${line#*=}"
    rewritten="$rewritten$line$nl"
  done <<EOF
$record_text
EOF
  end_block "$1"
}

rewritten=
changed=0
read_record 1
rewritten=
read_record 2

# --- Presences ------------------------------------------------------------------------------

# Consumes the literal $1 from $rest, then the value up to the literal $2.
take() {
  case $rest in "$1"*) rest=${rest#"$1"} ;; *) reason="expected $1"; return 1 ;; esac
  case $rest in *"$2"*) ;; *) reason="nothing ends the value after $1"; return 1 ;; esac
  value=${rest%%"$2"*}
  rest=${rest#"$value"}
}
# Reads the fields in the one order and form JSON.stringify gives them, checking each.
read_presence() {
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
  take '","createdAt":' ',' || return 1
  is_time "$value" || { reason='invalid createdAt'; return 1; }
  pr_created=$value
  case $rest in ',"expiresAt":'*) rest=${rest#',"expiresAt":'} ;; *) reason='expected ,"expiresAt":'; return 1 ;; esac
  value=${rest%%[!0-9]*}
  rest=${rest#"$value"}
  is_time "$value" || { reason='invalid expiresAt'; return 1; }
  pr_expires=$value
  take ',"namespace":"' '"' || return 1
  if [ "$value" != "$namespace" ]; then reason='another namespace'; return 1; fi
  take '","boot":"' '"' || return 1
  is_boot "$value" || { reason='invalid boot'; return 1; }
  pr_boot=$value
  if [ "$rest" != '"}' ]; then reason='extra keys or text after boot'; return 1; fi
  if [ "$pr_expires" -le "$now" ]; then reason='expired'; return 1; fi
}

# Accepted presences, one "id<TAB>root<TAB>name<TAB>fingerprint<TAB>createdAt<TAB>expiresAt<TAB>boot" line each.
peers=
count=0
drop_peer() {
  kept=
  while IFS="$tab" read -r p_id p_rest; do
    if [ -n "$p_id" ] && [ "$p_id" != "$1" ]; then kept="$kept$p_id$tab$p_rest$nl"; fi
  done <<EOF
$peers
EOF
  peers=$kept
}
add_peer() {
  existing=
  while IFS="$tab" read -r p_id p_root p_name p_fingerprint p_created p_expires p_boot; do
    if [ "$p_id" = "$pr_id" ]; then existing=$p_created; fi
  done <<EOF
$peers
EOF
  if [ -n "$existing" ]; then
    if [ "$pr_created" -le "$existing" ]; then
      log "skipped $1/$pr_id: a newer or equal presence is in another root"
      return 0
    fi
    drop_peer "$pr_id"
  elif [ "$count" -ge "$max_peers" ]; then
    log "skipped $1/$pr_id: the registry holds at most $max_peers peers"
    return 0
  else
    count=$((count + 1))
  fi
  peers="$peers$pr_id$tab$1$tab$pr_name$tab$pr_fingerprint$tab$pr_created$tab$pr_expires$tab$pr_boot$nl"
}
scan_root() {
  folder=$2/RECnRun/poc/$namespace/peers
  if [ -L "$folder" ] || [ ! -d "$folder" ]; then return 0; fi
  for entry in "$folder"/*; do
    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi
    name=${entry##*/}
    if ! is_uuid "$name"; then
      log "skipped $1/$(shown "$name"): not a profile id folder"
    elif [ -L "$entry" ] || [ ! -d "$entry" ]; then
      log "skipped $1/$name: not a folder"
    elif read_presence "$entry" "$name"; then
      add_peer "$1"
    else
      log "skipped $1/$name: $reason"
    fi
  done
}

now="$(date +%s)000"
while IFS='|' read -r m_id m_path; do
  if [ -n "$m_id" ]; then scan_root "$m_id" "$m_path"; fi
done <<EOF
$map
EOF

# --- Output ---------------------------------------------------------------------------------

new_boot() {
  read -r b1 b2 b3 b4 b5 b6 b7 b8 b9 b10 b11 b12 b13 b14 b15 b16 <<EOF
$(od -An -N16 -tx1 /dev/urandom)
EOF
  case ${b9%?} in 0 | 4 | 8 | c) variant=8 ;; 1 | 5 | 9 | d) variant=9 ;; 2 | 6 | a | e) variant=a ;; *) variant=b ;; esac
  boot="$b1$b2$b3$b4-$b5$b6-4${b7#?}$b8-$variant${b9#?}$b10-$b11$b12$b13$b14$b15$b16"
}
[ -n "$boot" ] || new_boot

json="{\"version\":1,\"namespace\":\"$namespace\",\"writtenAt\":$now,\"launcher\":{\"boot\":\"$boot\"},\"peers\":{"
separator=
while IFS="$tab" read -r p_id p_root p_name p_fingerprint p_created p_expires p_boot; do
  [ -n "$p_id" ] || continue
  json="$json$separator\"$p_id\":{\"profileId\":\"$p_id\",\"displayName\":\"$p_name\",\"fingerprint\":\"$p_fingerprint\",\"root\":\"$p_root\",\"lastSeenAt\":$now,\"expiresAt\":$p_expires,\"boot\":\"$p_boot\"}"
  separator=,
done <<EOF
$peers
EOF
json="$json}}"

if [ "$changed" = 1 ]; then
  [ -f "$record" ] || fail 73 'cannot write root ids back to a record that is not a regular file'
  record_tmp=$record.tmp.$$
  printf '%s' "$rewritten" >"$record_tmp" || fail 73 'cannot write the record'
  mv -f -- "$record_tmp" "$record" || fail 73 'cannot replace the record'
  record_tmp=
fi
tmp=$out/registry.json.tmp.$$
printf '%s' "$json" >"$tmp" || fail 73 'cannot write the registry'
# A rename within one folder is atomic: readers see the old catalog or the new one.
mv -f -- "$tmp" "$out/registry.json" || fail 73 'cannot replace the registry'
tmp=
