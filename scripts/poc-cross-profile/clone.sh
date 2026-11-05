#!/bin/sh
# clone.sh create-clone <bases-dir> <name> <clones-dir> <clone> <namespace>
# clone.sh list-clones <clones-dir>
# clone.sh discard-partial <clones-dir> <path>
#
# The transactional copy of a frozen base (POC PLAN.md P5.2, decisions 10 and 11), over base.sh. POSIX
# sh only, no JSON parser, nothing read from a file is ever run or expanded; positional arguments only.
# <name> is base-v<n>, <clone> is [A-Za-z0-9][A-Za-z0-9-]{0,31}. Source it with RECNRUN_DISCOVERY_LIB=1.
#
#   create-clone     copies the whole root of a frozen base to <clones-dir>/.<clone>.partial-<16 hex>
#                    (same file system), verifies it with diff -r, and then, in that closed copy only:
#                    removes SingletonLock, SingletonCookie, and SingletonSocket at its root (never a
#                    LOCK or lockfile below it), deletes downloads/RECnRun (the base's own rendezvous
#                    files), rewrites the one download.default_directory in Default/Preferences to
#                    <clones-dir>/<clone>/downloads, removes .recnrun-base, writes .recnrun-clone, and
#                    publishes with one rename to <clones-dir>/<clone>. A base that is not frozen, is
#                    named by a process command line, or holds a symbolic or hard link outside the
#                    Singleton markers is refused. A failed copy leaves the partial where it is: nothing
#                    here deletes it. The clone is created closed; this script never opens it.
#                    stdout clone=, instanceId=, copyS=, physicalKiB=, logicalBytes=.
#   list-clones      <clone> <instanceId> <base> <createdAt> per published clone, then `partial <path>`
#                    per interrupted copy.
#   discard-partial  deletes <path> only when it is <clones-dir>/.<clone>.partial-<16 hex>, a plain
#                    directory without .recnrun-clone: the owner's cleanup of an interrupted copy.
#
# .recnrun-clone, one key=value per line in this order: base, clone, instanceId (lowercase v4 uuid
# from uuidgen or /proc), namespace, extensionId, role=worker, createdAt (epoch seconds), copyS,
# physicalKiB (du -sk), logicalBytes (the files of the copy without this marker). clone-open.sh appends
# provisionedAt, operationId, and masterProfileId once the clone acked its first opening.
#
# Exit: 0 done, 64 wrong call, 65 refused, 70 the copy failed or is not what the base was, 73 the
# destination exists, 75 a process names the base root.

clone_as_library=${RECNRUN_DISCOVERY_LIB:-}
# shellcheck source=base.sh
RECNRUN_DISCOVERY_LIB=1 . "$(dirname -- "$0")/base.sh"
RECNRUN_DISCOVERY_LIB=$clone_as_library
LC_ALL=C
export LC_ALL

log() { printf 'clone.sh: %s\n' "$*" >&2; }
nl='
'

# --- Names and the base's marker -------------------------------------------------------------

is_clone_name() {
  case $1 in '' | [!A-Za-z0-9]* | *[!A-Za-z0-9-]*) return 1 ;; esac
  [ "${#1}" -le 32 ]
}
is_count() {
  case $1 in '' | *[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 15 ]
}
# One line of a marker file in the grammar of decision 10: $1 its number, $2 the line.
base_line() {
  bl_value=${2#*=}
  case $1:$2 in
    1:setting=*) [ "$bl_value" = "$name" ] ;;
    2:extensionId=*) mk_extension=$bl_value && is_extension_id "$bl_value" ;;
    3:profileId=*) is_v4 "$bl_value" ;;
    4:namespace=*) mk_namespace=$bl_value && is_namespace "$bl_value" ;;
    5:frozenAt=*) is_count "$bl_value" ;;
    6:install=*) mk_install=$bl_value && { [ "$bl_value" = packed ] || [ "$bl_value" = unpacked ]; } ;;
    7:unpackedPath=*) [ "$mk_install" = unpacked ] && is_plain_root "$bl_value" ;;
    *) return 1 ;;
  esac
}
# Sets mk_extension and mk_namespace from the marker of the base, or refuses.
read_base_marker() {
  rb_file=$root/.recnrun-base
  is_plain_file "$rb_file" || refuse "$root is not a frozen base: no .recnrun-base"
  [ "$(wc -c <"$rb_file" | tr -d ' ')" -le 2048 ] || refuse "$rb_file is over 2 KiB"
  mk_extension='' mk_namespace='' mk_install=''
  rb_index=0
  while IFS= read -r rb_line || [ -n "$rb_line" ]; do
    rb_index=$((rb_index + 1))
    base_line "$rb_index" "$rb_line" || refuse "$rb_file line $rb_index is not in the freeze grammar"
  done <"$rb_file"
  # An unpacked base may carry its build folder as a seventh line (CL13); open-clone checks it.
  [ "$rb_index" -eq 6 ] || [ "$rb_index" -eq 7 ] || refuse "$rb_file does not have the six lines of a freeze, or seven with unpackedPath"
}
# Up to three paths below $1 that are a symbolic link or a multiply linked file, Singleton markers aside.
stray_links() {
  find "$1" \( -type l -o -type f -links +1 \) ! -path "$1/SingletonLock" ! -path "$1/SingletonCookie" \
    ! -path "$1/SingletonSocket" | head -n 3
}
refuse_stray_links() {
  rs_found=$(stray_links "$1")
  [ -z "$rs_found" ] || "$2" "a symbolic or hard link outside the Singleton markers in $1: $(printf '%s' "$rs_found" | tr '\n' ' ')"
}
check_clones_dir() {
  if [ ! -d "$1" ] || [ -L "$1" ]; then refuse 'the clones directory is not a plain existing directory'; fi
  is_plain_root "$1" || refuse 'the clones directory is not an absolute path of letters, digits, dot, underscore, hyphen, and slash'
}

# --- create-clone ----------------------------------------------------------------------------

new_instance_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    ni_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    read -r ni_id </proc/sys/kernel/random/uuid
  else
    return 1
  fi
  is_v4 "$ni_id" || return 1
  printf '%s\n' "$ni_id"
}
copy_root() {
  if command -v ditto >/dev/null 2>&1; then ditto "$root" "$temp"; else cp -R -p "$root" "$temp"; fi
}
fail_copy() { die 70 "$1: interrupted copy kept at $temp"; }
make_copy() {
  temp=$clones/.$clone.partial-$(lc_random)
  if [ -e "$temp" ] || [ -L "$temp" ]; then die 73 "$temp exists"; fi
  copy_start=$(date +%s)
  copy_root || fail_copy 'the copy failed'
  copy_s=$(($(date +%s) - copy_start))
  diff_out=$(diff -r -q -x SingletonLock -x SingletonCookie -x SingletonSocket "$root" "$temp" 2>&1)
  [ -z "$diff_out" ] || fail_copy "the copy differs from the base ($(printf '%s' "$diff_out" | head -n 1))"
  refuse_stray_links "$temp" fail_copy
}
# Counts $2 in the file $1 (an occurrence, not a line).
occurrences() { grep -o -F -e "$2" "$1" | wc -l | tr -d ' '; }
rewrite_preferences() {
  rp_file=$temp/Default/Preferences
  is_plain_file "$rp_file" || fail_copy 'the copy has no Default/Preferences'
  rp_old="\"default_directory\":\"$root/downloads\""
  rp_new="\"default_directory\":\"$dest/downloads\""
  if [ "$(occurrences "$rp_file" "$root")" != 1 ] || [ "$(occurrences "$rp_file" "$rp_old")" != 1 ]; then
    fail_copy 'the base path does not occur exactly once, as the Downloads root, in Preferences'
  fi
  rp_size=$(wc -c <"$rp_file" | tr -d ' ')
  rp_out=$(
    sed "s|$rp_old|$rp_new|" "$rp_file"
    printf x
  )
  rp_out=${rp_out%x}
  if [ -n "$(tail -c 1 "$rp_file")" ]; then rp_out=${rp_out%"$nl"}; fi # a sed that adds a final newline
  printf '%s' "$rp_out" >"$rp_file" || fail_copy 'cannot rewrite Preferences'
  rp_grown=$(($(wc -c <"$rp_file" | tr -d ' ') - rp_size))
  if [ "$rp_grown" -ne $((${#rp_new} - ${#rp_old})) ] || [ "$(occurrences "$rp_file" "$rp_new")" != 1 ] || [ "$(occurrences "$rp_file" "$rp_old")" != 0 ]; then
    fail_copy 'Preferences is not the base with only its Downloads root changed'
  fi
}
# The closed copy becomes a clone: no lock, no rendezvous file, its own Downloads root and identity.
prepare_copy() {
  rm -f -- "$temp/SingletonLock" "$temp/SingletonCookie" "$temp/SingletonSocket"
  rm -rf -- "$temp/downloads/RECnRun"
  rewrite_preferences
  rm -f -- "$temp/.recnrun-base"
  instance=$(new_instance_id) || fail_copy 'no native source of a v4 uuid (uuidgen or /proc)'
  physical=$(du -sk "$temp")
  physical=${physical%%[!0-9]*}
  logical=$(find "$temp" -type f -exec cat {} + | wc -c | tr -d ' ')
  (
    set -C
    printf 'base=%s\nclone=%s\ninstanceId=%s\nnamespace=%s\nextensionId=%s\nrole=worker\ncreatedAt=%s\ncopyS=%s\nphysicalKiB=%s\nlogicalBytes=%s\n' \
      "$name" "$clone" "$instance" "$ns" "$mk_extension" "$(date +%s)" "$copy_s" "$physical" "$logical" >"$temp/.recnrun-clone"
  ) || fail_copy 'cannot write .recnrun-clone'
}
create_clone() {
  [ "$#" -eq 5 ] || die 64 'usage: clone.sh create-clone <bases-dir> <name> <clones-dir> <clone> <namespace>'
  check_existing_root "$1" "$2"
  clones=$3 clone=$4 ns=$5
  check_clones_dir "$clones"
  is_clone_name "$clone" || refuse 'the clone name is not [A-Za-z0-9][A-Za-z0-9-]{0,31}'
  is_namespace "$ns" || refuse 'the namespace is not a namespace'
  case $clones/ in "$root"/*) refuse 'the clones directory is inside the base' ;; esac
  dest=$clones/$clone
  read_base_marker
  [ "$mk_namespace" = "$ns" ] || refuse "the base is frozen for namespace $mk_namespace, not $ns"
  holders_of "$root"
  [ -z "$holders" ] || die 75 "a process names the base root: pids $holders; close it first"
  if [ -e "$dest" ] || [ -L "$dest" ]; then die 73 "$dest exists"; fi
  refuse_stray_links "$root" refuse
  make_copy
  prepare_copy
  if [ -e "$dest" ] || [ -L "$dest" ]; then fail_copy "$dest appeared meanwhile"; fi
  mv -- "$temp" "$dest" || fail_copy "cannot publish $dest"
  printf 'clone=%s\ninstanceId=%s\ncopyS=%s\nphysicalKiB=%s\nlogicalBytes=%s\n' "$dest" "$instance" "$copy_s" "$physical" "$logical"
}

# --- list-clones and discard-partial ---------------------------------------------------------

# Sets lc_base, lc_id, and lc_created when $1 is a published clone whose marker parses, else returns 1;
# the three provisioning lines clone-open.sh appends (11 to 13) are part of the grammar.
read_clone_marker() {
  rc_index=0 lc_base='' lc_id='' lc_created=''
  while IFS= read -r rc_line || [ -n "$rc_line" ]; do
    rc_index=$((rc_index + 1))
    rc_value=${rc_line#*=}
    case $rc_index:$rc_line in
      1:base=*) is_base_name "$rc_value" && lc_base=$rc_value ;;
      2:clone=*) [ "$rc_value" = "$2" ] ;;
      3:instanceId=*) is_v4 "$rc_value" && lc_id=$rc_value ;;
      4:namespace=*) is_namespace "$rc_value" ;;
      5:extensionId=*) is_extension_id "$rc_value" ;;
      6:role=worker) true ;;
      7:createdAt=*) is_count "$rc_value" && lc_created=$rc_value ;;
      8:copyS=* | 9:physicalKiB=* | 10:logicalBytes=* | 11:provisionedAt=*) is_count "$rc_value" ;;
      12:operationId=*) is_v4 "$rc_value" ;;
      13:masterProfileId=*) is_v4 "$rc_value" ;;
      *) false ;;
    esac || return 1
  done <"$1"
  [ "$rc_index" -eq 10 ] || [ "$rc_index" -eq 13 ]
}
list_clones() {
  [ "$#" -eq 1 ] || die 64 'usage: clone.sh list-clones <clones-dir>'
  check_clones_dir "$1"
  for lk_dir in "$1"/*; do
    if [ ! -d "$lk_dir" ] || [ -L "$lk_dir" ] || ! is_plain_file "$lk_dir/.recnrun-clone"; then continue; fi
    read_clone_marker "$lk_dir/.recnrun-clone" "${lk_dir##*/}" || continue
    printf '%s %s %s %s\n' "${lk_dir##*/}" "$lc_id" "$lc_base" "$lc_created"
  done
  for lk_dir in "$1"/.*.partial-*; do
    if [ -e "$lk_dir" ] || [ -L "$lk_dir" ]; then printf 'partial %s\n' "$lk_dir"; fi
  done
  return 0
}
# True when the base name $1 is .<clone>.partial-<16 lowercase hex>.
is_partial_name() {
  case $1 in .?*.partial-*) ;; *) return 1 ;; esac
  ip_rest=${1#.}
  ip_hex=${ip_rest##*.partial-}
  is_clone_name "${ip_rest%.partial-*}" || return 1
  case $ip_hex in '' | *[!0-9a-f]*) return 1 ;; esac
  [ "${#ip_hex}" -eq 16 ]
}
discard_partial() {
  [ "$#" -eq 2 ] || die 64 'usage: clone.sh discard-partial <clones-dir> <path>'
  check_clones_dir "$1"
  if ! is_partial_name "${2##*/}" || [ "$2" != "$1/${2##*/}" ]; then refuse "$2 is not $1/.<clone>.partial-<16 hex>"; fi
  if [ ! -d "$2" ] || [ -L "$2" ]; then refuse "$2 is not a plain directory"; fi
  if [ -e "$2/.recnrun-clone" ] || [ -L "$2/.recnrun-clone" ]; then refuse "$2 holds .recnrun-clone: it is a clone, not an interrupted copy"; fi
  rm -rf -- "$2" || die 70 "cannot delete $2"
  log "deleted $2"
}

if [ -z "$clone_as_library" ]; then
  [ "$#" -ge 1 ] || die 64 'usage: clone.sh create-clone|list-clones|discard-partial [argument ...]'
  entry=$1
  shift
  case $entry in
    create-clone) create_clone "$@" ;;
    list-clones) list_clones "$@" ;;
    discard-partial) discard_partial "$@" ;;
    *) die 64 "unknown command $entry" ;;
  esac
fi
