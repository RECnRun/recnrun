#!/bin/sh
# catalog.sh <record-file> <namespace> <out-dir>
#
# The launcher's catalog writer (POC PLAN.md P2.3, decision 11), the single writer of
# <out-dir>/registry.json. POSIX sh only: macOS /bin/sh and Debian dash, no JSON parser.
#
# Record file: key=value blocks, grammar in record.sh. Every downloadsRoot is scanned; one without
# a root id gets the next free r<n>, written back; "roots" maps each id to its path (roots.sh).
#
# Scan: <downloadsRoot>/RECnRun/poc/<namespace>/peers/<uuid>/presence.json, nothing else, no
# symbolic link followed at any folder below the root or at the file. Temporary files get a
# random name and are created exclusively; a registry.json that is a folder or a link exits 73.
# A presence counts only in the exact bytes the extension writes (grammar in presence.sh);
# anything else is skipped with a reason on stderr. No value read from a file is ever run or
# expanded. The boot goes into the registry.
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
here=$(dirname -- "$0")
# shellcheck source=record.sh
. "$here/record.sh"
# shellcheck source=presence.sh
. "$here/presence.sh"
# shellcheck source=roots.sh
. "$here/roots.sh"
record_refuse() { fail 65 "$*"; }

# --- Value checks ---------------------------------------------------------------------------

# A fresh name for a temporary file: no other process can plant a link at it in advance.
random_hex() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }
# Noclobber alone would still open a link to a fifo or a device, so a taken name is refused first.
taken() { [ -e "$1" ] || [ -L "$1" ]; }
write_new() {
  (
    set -C
    printf '%s' "$2" >"$1"
  )
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
mine=$lock.$$
tmp=
record_tmp=
# The lock is a hard link of a file that already names this run's pid, so a signal that lands between
# taking the lock and noting it cannot orphan it: cleanup removes the lock whenever it names this run.
owns_lock() {
  [ -f "$lock" ] || return 1
  read -r holder < "$lock" || return 1
  [ "$holder" = "$$" ]
}
cleanup() {
  if [ -n "$tmp" ]; then rm -f -- "$tmp"; fi
  if [ -n "$record_tmp" ]; then rm -f -- "$record_tmp"; fi
  if owns_lock; then rm -f -- "$lock"; fi
  rm -f -- "$mine"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$$" > "$mine"
# link is atomic: exactly one run links its pid file to the lock; the others leave it alone. A directory
# at the lock path (ln would link inside it) counts as held too.
if [ -d "$lock" ] || ! ln -- "$mine" "$lock" 2>/dev/null; then fail 75 "another run holds $lock"; fi
# A rename onto a folder, or a link to one, would land inside it.
destination=$out/registry.json
if [ -L "$destination" ] || { [ -e "$destination" ] && [ ! -f "$destination" ]; }; then
  fail 73 'registry.json in the output directory is not a regular file'
fi

# Read once, so both passes see the same record.
record_load "$record"

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

# Pass 1 learns the ids the record names; pass 2 numbers the other roots and rewrites.
record_hook_block() {
  [ -n "$b_downloads" ] || return 0
  is_root_path "$b_downloads" || fail 65 "$where: downloadsRoot has an empty or . segment"
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
record_hook_line() { rewritten="$rewritten$line$nl"; }
record_hook_blank() { rewritten="$rewritten$nl"; }

rewritten=
changed=0
record_parse 1
rewritten=
record_parse 2

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
# Every folder from below the Downloads root down to peers is a real folder, never a link.
rendezvous_folder() {
  folder=$1
  reason=
  for part in RECnRun poc "$namespace" peers; do
    folder=$folder/$part
    if [ -L "$folder" ]; then reason="$part is a symbolic link"; return 1; fi
    if [ ! -e "$folder" ]; then return 1; fi
    if [ ! -d "$folder" ]; then reason="$part is not a folder"; return 1; fi
  done
}
# True when $1 is the Downloads root a frozen base pins (<root>/downloads next to .recnrun-base).
frozen_downloads_root() {
  case $1 in */downloads) ;; *) return 1 ;; esac
  [ -e "${1%/downloads}/.recnrun-base" ] || [ -L "${1%/downloads}/.recnrun-base" ]
}
# True when $1 is the Downloads root of a clone.sh copy that is not published yet.
partial_downloads_root() {
  case $1 in */downloads) ;; *) return 1 ;; esac
  pd_root=${1%/downloads}
  case ${pd_root##*/} in .?*.partial-*) return 0 ;; esac
  return 1
}
scan_root() {
  if partial_downloads_root "$2"; then
    log "skipped $1: the Downloads root of an unpublished clone copy"
    return 0
  fi
  if frozen_downloads_root "$2"; then
    log "skipped $1: the Downloads root of a frozen base"
    return 0
  fi
  if ! rendezvous_folder "$2"; then
    if [ -n "$reason" ]; then log "skipped $1: $reason"; fi
    return 0
  fi
  for entry in "$folder"/*; do
    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi
    name=${entry##*/}
    if ! is_v4 "$name"; then
      log "skipped $1/$(shown "$name"): not a profile id folder"
    elif [ -L "$entry" ] || [ ! -d "$entry" ]; then
      log "skipped $1/$name: not a folder"
    elif row=$(read_presence "$entry" "$name" "$namespace" "$now"); then
      IFS=$tab read -r pr_id pr_name pr_fingerprint pr_created pr_expires pr_boot <<ROW
$row
ROW
      add_peer "$1"
    else
      log "skipped $1/$name: $row"
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

json="{\"version\":1,\"namespace\":\"$namespace\",\"writtenAt\":$now,\"launcher\":{\"boot\":\"$boot\"},$(roots_json "$map"),\"peers\":{"
separator=
while IFS="$tab" read -r p_id p_root p_name p_fingerprint p_created p_expires p_boot; do
  [ -n "$p_id" ] || continue
  json="$json$separator\"$p_id\":{\"profileId\":\"$p_id\",\"displayName\":\"$p_name\",\"fingerprint\":\"$p_fingerprint\",\"root\":\"$p_root\",\"lastSeenAt\":$now,\"expiresAt\":$p_expires,\"boot\":\"$p_boot\"}"
  separator=,
done <<EOF
$peers
EOF
json="$json}}"

# Both names are checked before either file is written, so a refusal changes nothing.
registry_name=$out/registry.json.$(random_hex).tmp
record_name=$record.$(random_hex).tmp
if taken "$registry_name"; then fail 73 'the temporary name of the registry is taken'; fi
if [ "$changed" = 1 ]; then
  [ -f "$record" ] || fail 73 'cannot write root ids back to a record that is not a regular file'
  if taken "$record_name"; then fail 73 'the temporary name of the record is taken'; fi
  record_tmp=$record_name
  write_new "$record_tmp" "$rewritten" || fail 73 'cannot write the record'
  mv -f -- "$record_tmp" "$record" || fail 73 'cannot replace the record'
  record_tmp=
fi
tmp=$registry_name
write_new "$tmp" "$json" || fail 73 'cannot write the registry'
# A rename within one folder is atomic: readers see the old catalog or the new one.
mv -f -- "$tmp" "$destination" || fail 73 'cannot replace the registry'
tmp=
