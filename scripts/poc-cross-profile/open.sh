#!/bin/sh
# open.sh open <record> <namespace> <profileId> [headed|headless]
#
# One open attempt of the launcher (POC PLAN.md P4.3): starts Chrome on a registered profile with
# a fresh token in the bootstrap URL, then waits for the ack that carries the token. The request
# is these positional arguments and one enumerated mode, nothing else; the profile must be a block
# of the record and its Preferences must exist, so a typo never creates a profile. A pid, an exit
# code, or a window is no proof: only the ack file counts. POSIX sh only, no JSON parser, nothing
# read from a file is ever run or expanded. Source it with RECNRUN_DISCOVERY_LIB=1 for the functions.
#
# Output: pid=<n> on stderr at once; on stdout root=<downloadsRoot>, boot=<uuid>, token=<uuid>.
# The extension id is the first line of the file `extension-id` next to this script (the id the
# POC builds pin). Environment: RECNRUN_OPEN_TIMEOUT_S (60) and RECNRUN_OPEN_POLL_S (1) bound the wait; RECNRUN_DISCOVERY_PREFIX and RECNRUN_DISCOVERY_UNAME as in profiles.sh.
# Exit: 0 acked, 64 wrong call, 65 refused request, 66 no Chrome or extension id, 69 no ack in time.

# profiles.sh reuses the name as_library, so this one stays apart.
open_as_library=${RECNRUN_DISCOVERY_LIB:-}
# shellcheck source=profiles.sh
RECNRUN_DISCOVERY_LIB=1 . "$(dirname -- "$0")/profiles.sh"
here=$(dirname -- "$0")

log() { printf 'open.sh: %s\n' "$*" >&2; }
refuse() {
  log "refused: $*"
  exit 65
}

# --- The token -------------------------------------------------------------------------------

slice() { printf '%s' "$hex" | cut -c"$1"; }
# A fresh lowercase v4 uuid from the kernel's random bytes.
new_token() {
  hex=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  case $(slice 17) in [0-3]) variant=8 ;; [4-7]) variant=9 ;; [89ab]) variant=$(slice 17) ;; *) variant=a ;; esac
  printf '%s-%s-4%s-%s%s-%s\n' "$(slice 1-8)" "$(slice 9-12)" "$(slice 14-16)" "$variant" \
    "$(slice 18-20)" "$(slice 21-32)"
}
# Lowercase hex, version 4, variant 8 to b.
is_v4() {
  is_uuid "$1" || return 1
  case $1 in ????????-????-4???-[89ab]???-????????????) return 0 ;; esac
  return 1
}

# --- The registered profile ------------------------------------------------------------------

# Fields of the record block being read; a block is closed by a blank line or the end of the file.
block_reset() {
  b_user=''
  b_dir=''
  b_id=''
  b_namespace=''
}
# True when the closed block registers the profile; only the first block that names the id counts.
settle() {
  [ "$b_id" = "$1" ] || return 1
  [ "$b_namespace" = "$2" ] || refuse 'the profile is registered in another namespace'
  p_user=$b_user p_dir=$b_dir
}
# Sets p_user and p_dir from the record, or refuses.
find_profile() {
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then refuse 'the record is not a readable file'; fi
  [ "$(wc -c <"$1" | tr -d ' ')" -le 65536 ] || refuse 'the record is over 64 KiB'
  block_reset
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      '')
        settle "$3" "$2" && return 0
        block_reset
        ;;
      userDataDir=*) b_user=${line#*=} ;;
      profileDirectory=*) b_dir=${line#*=} ;;
      profileId=*) b_id=${line#*=} ;;
      namespace=*) b_namespace=${line#*=} ;;
    esac
  done <"$1"
  settle "$3" "$2" && return 0
  refuse 'the profile is not registered in the record'
}
# The registered values reach a command line only after these checks.
validate_profile() {
  if ! is_directory "$p_user" || [ ! -d "$p_user" ]; then refuse 'userDataDir is not an existing absolute directory'; fi
  is_profile_directory "$p_dir" || refuse 'profileDirectory is not a profile directory name'
  is_plain_file "$p_user/$p_dir/Preferences" || refuse 'the profile has no Preferences: open never creates one'
  p_ext=
  if [ -f "$here/extension-id" ]; then p_ext=$(head -n 1 "$here/extension-id"); fi
  is_extension_id "$p_ext" || { log 'no valid extension id'; exit 66; }
}

# --- The ack ---------------------------------------------------------------------------------

# Prints the boot of the ack $1 when it is a regular small file of token $2 and profile $3.
read_ack() {
  if [ ! -f "$1" ] || [ -L "$1" ]; then return 1; fi
  [ "$(wc -c <"$1" | tr -d ' ')" -le 4096 ] || return 1
  text=$(cat -- "$1")
  case $text in
    '{"token":"'"$2"'","profileId":"'"$3"'","identity":{'*) ;;
    *) return 1 ;;
  esac
  rest=${text#*'"boot":"'}
  [ "$rest" != "$text" ] || return 1
  ack_boot=${rest%%'"'*}
  is_uuid "$ack_boot" || return 1
  printf '%s\n' "$ack_boot"
}
# One look under every candidate Downloads root for the ack of token $4 of profile $3 in namespace
# $2 (record $1); sets acked_root and acked_boot, else leaves the roots tried in $tried.
look_for_ack() {
  candidates=$(downloads_root_candidates "$p_user" "$p_dir" "$1" "$2")
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    folder=$candidate/RECnRun/poc/$2/acks/$3
    if [ ! -L "$folder" ] && found_boot=$(read_ack "$folder/$4.json" "$4" "$3"); then
      acked_root=$candidate acked_boot=$found_boot
      return 0
    fi
    tried="$tried${tried:+, }$candidate"
  done <<EOF
$candidates
EOF
  return 1
}
# Whole seconds, the poll at least 1; sets limit and step.
check_timing() {
  limit=${RECNRUN_OPEN_TIMEOUT_S:-60}
  step=${RECNRUN_OPEN_POLL_S:-1}
  case $limit in *[!0-9]*) log 'RECNRUN_OPEN_TIMEOUT_S must be whole seconds'; exit 64 ;; esac
  case $step in *[!0-9]* | 0) log 'RECNRUN_OPEN_POLL_S must be whole seconds, at least 1'; exit 64 ;; esac
}
# Waits up to $limit seconds for the ack; the Preferences read repeats on every look, since Chrome
# flushes it late.
wait_for_ack() {
  waited=0
  while :; do
    tried=
    if look_for_ack "$@"; then return 0; fi
    [ "$waited" -lt "$limit" ] || return 1
    sleep "$step"
    waited=$((waited + step))
  done
}

# --- The request -----------------------------------------------------------------------------

# Chrome runs in the background with separate words, never through a shell string.
start_chrome() {
  finder=chrome_binary # by name: ShellCheck would read a bare call as a forgotten "$@"
  chrome=$("$finder") || { log 'no Google Chrome found'; exit 66; }
  url=chrome-extension://$p_ext/bootstrap.html#token=$1
  set -- "--user-data-dir=$p_user" "--profile-directory=$p_dir" --no-first-run --no-default-browser-check "$url"
  [ "$mode" != headless ] || set -- --headless=new "$@"
  "$chrome" "$@" >/dev/null 2>&1 &
  log "pid=$!"
}
open_profile() {
  [ "$#" -ge 3 ] || { log 'usage: open.sh open <record> <namespace> <profileId> [headed|headless]'; exit 64; }
  [ "$#" -le 4 ] || refuse 'a free argument: the request is the record, namespace, profile id, and mode'
  mode=headed
  [ "$#" -lt 4 ] || mode=$4
  case $mode in headed | headless) ;; *) refuse 'the mode is neither headed nor headless' ;; esac
  check_timing
  is_namespace "$2" || refuse 'the namespace is not a namespace'
  is_v4 "$3" || refuse 'the profile id is not a lowercase v4 uuid'
  find_profile "$1" "$2" "$3"
  validate_profile
  token=$(new_token)
  start_chrome "$token"
  if ! wait_for_ack "$1" "$2" "$3" "$token"; then
    log "no ack for $token within $limit s: tried ${tried:-no candidate}"
    exit 69
  fi
  printf 'root=%s\nboot=%s\ntoken=%s\n' "$acked_root" "$acked_boot" "$token"
}

if [ -z "$open_as_library" ]; then
  [ "$#" -ge 1 ] || { log 'usage: open.sh open <record> <namespace> <profileId> [headed|headless]'; exit 64; }
  entry=$1
  shift
  case $entry in
    open) open_profile "$@" ;;
    *) log "unknown command $entry"; exit 64 ;;
  esac
fi
