#!/bin/sh
# open.sh open <record> <namespace> <profileId> [headed|headless]
# open.sh bind <userDataDir> <profileDirectory> <namespace> [headed|headless]
#
# One open attempt of the launcher (POC PLAN.md P4.3): starts Chrome on a registered profile with
# a fresh token in the bootstrap URL, then waits for the ack that carries the token. The request
# is these positional arguments and one enumerated mode, nothing else; the profile must be a block
# of the record and its Preferences must exist, so a typo never creates a profile. A pid, an exit
# code, or a window is no proof: only the ack file counts. POSIX sh only, no JSON parser, nothing
# read from a file is ever run or expanded. Source it with RECNRUN_DISCOVERY_LIB=1 for the functions.
#
# `bind` is the same request for a profile the record does not hold yet (the first run of a root
# shared by several profiles): it takes the paths from its arguments, checked with the record
# grammar, and the profile id from the ack that carries its token, in any profile folder of the
# namespace under a candidate Downloads root. It prints profileId= first.
#
# Output: pid=<n> on stderr at once; on stdout root=<downloadsRoot>, boot=<uuid>, token=<uuid>.
# The extension id is the first line of the file `extension-id` next to this script (the id the
# POC builds pin). Environment: RECNRUN_OPEN_TIMEOUT_S (60) and RECNRUN_OPEN_POLL_S (1) bound the wait; RECNRUN_DISCOVERY_PREFIX and RECNRUN_DISCOVERY_UNAME as in profiles.sh.
# A main Chrome already running on the root in the other mode (headed vs --headless) is refused at once
# (65), never handed a second launch: the process singleton would forward it and no ack would come.
# A bootstrap that cannot produce its ack writes a failure ack for the same token instead (the closed
# grammar of read_failure_ack: failedStep and a short error, no identity); it is logged, never ignored.
# Exit: 0 acked, 64 wrong call, 65 refused request (the other mode already runs on the root), 66 no
# Chrome or extension id or the unpacked build's folder is gone, 69 no ack in time, 71 the profile
# answered with a failure ack (Chrome ran; its bootstrap page failed at the step and error logged).

# profiles.sh reuses the name as_library, so this one stays apart.
open_as_library=${RECNRUN_DISCOVERY_LIB:-}
# shellcheck source=profiles.sh
RECNRUN_DISCOVERY_LIB=1 . "$(dirname -- "$0")/profiles.sh"
RECNRUN_DISCOVERY_LIB=$open_as_library # a dot keeps its own assignment: give back what this script saw
here=$(dirname -- "$0")
# shellcheck source=record.sh
. "$here/record.sh"
# shellcheck source=lifecycle-state.sh
. "$here/lifecycle-state.sh"

log() { printf 'open.sh: %s\n' "$*" >&2; }
refuse() {
  log "refused: $*"
  exit 65
}
record_refuse() { refuse "$*"; }

# --- The token -------------------------------------------------------------------------------

slice() { printf '%s' "$hex" | cut -c"$1"; }
# A fresh lowercase v4 uuid from the kernel's random bytes.
new_token() {
  hex=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  case $(slice 17) in [0-3]) variant=8 ;; [4-7]) variant=9 ;; [89ab]) variant=$(slice 17) ;; *) variant=a ;; esac
  printf '%s-%s-4%s-%s%s-%s\n' "$(slice 1-8)" "$(slice 9-12)" "$(slice 14-16)" "$variant" \
    "$(slice 18-20)" "$(slice 21-32)"
}
# --- The registered profile ------------------------------------------------------------------

# The first block that names the profile counts, but the whole record is valid before any is used.
record_hook_block() {
  [ "$b_id" = "$want_id" ] && [ -z "$sel_found" ] || return 0
  sel_found=1 sel_ns=$b_ns sel_user=$b_user sel_dir=$b_profile
}
# Sets p_user and p_dir from the record, or refuses.
find_profile() {
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then refuse 'the record is not a readable file'; fi
  want_id=$3 sel_found='' sel_ns='' sel_user='' sel_dir=''
  record_load "$1"
  record_parse 1
  [ -n "$sel_found" ] || refuse 'the profile is not registered in the record'
  [ "$sel_ns" = "$2" ] || refuse 'the profile is registered in another namespace'
  p_user=$sel_user p_dir=$sel_dir
}
# The registered values reach a command line only after these checks.
validate_profile() {
  [ -d "$p_user" ] || refuse 'userDataDir is not an existing directory'
  ! is_base_root "$p_user" || refuse 'a frozen base is not an executor'
  ! is_partial_root "$p_user" || refuse 'an unpublished clone copy is not an executor'
  is_plain_file "$p_user/$p_dir/Preferences" || refuse 'the profile has no Preferences: open never creates one'
  p_ext=
  if [ -f "$here/extension-id" ]; then p_ext=$(head -n 1 "$here/extension-id"); fi
  is_extension_id "$p_ext" || { log 'no valid extension id'; exit 66; }
  unpacked_code_present "$p_user" "$p_dir" "$p_ext" || exit $? # CL13: Chrome disables an unpacked build whose folder is gone
}

# --- The ack ---------------------------------------------------------------------------------

# Consumes the literal $1 from $ack_rest, then the value up to the literal $2 into $ack_value.
ack_take() {
  case $ack_rest in "$1"*) ack_rest=${ack_rest#"$1"} ;; *) return 1 ;; esac
  case $ack_rest in *"$2"*) ;; *) return 1 ;; esac
  ack_value=${ack_rest%%"$2"*}
  ack_rest=${ack_rest#"$ack_value"}
}
# Consumes the identity statement of an ack, in form only: sh has no crypto, and the extension
# verifies identities (PLAN decision 13).
read_ack_identity() {
  ack_take '","identity":{"key":"' '"' || return 1
  is_base64url "$ack_value" 87 || return 1
  ack_take '","signedAt":' ',' || return 1
  is_time "$ack_value" || return 1
  ack_take ',"signature":"' '"' || return 1
  is_base64url "$ack_value" 86
}
# Prints the boot of the ack $1 when the whole file is the closed grammar launcher-requests.ts writes
# for token $2 and profile $3; with a setting $4 (base.sh template) it must also end with
# `,"template":true,"setting":"$4"` and may omit the identity, which a token ack never may.
read_ack() {
  if [ ! -f "$1" ] || [ -L "$1" ]; then return 1; fi
  size=$(wc -c <"$1" | tr -d ' ')
  [ "$size" -le 4096 ] || return 1
  ack_rest=$(cat -- "$1")
  [ "${#ack_rest}" -eq "$size" ] || return 1
  ack_take '{"token":"' '"' || return 1
  [ "$ack_value" = "$2" ] || return 1
  ack_take '","profileId":"' '"' || return 1
  [ "$ack_value" = "$3" ] || return 1
  ack_boot_at='"},"boot":"'
  case ${4:-}:$ack_rest in
    ?*:'","boot":"'*) ack_boot_at='","boot":"' ;;
    *) read_ack_identity || return 1 ;;
  esac
  ack_take "$ack_boot_at" '"' || return 1
  is_uuid "$ack_value" || return 1
  ack_boot=$ack_value
  ack_end='}'
  [ -z "${4:-}" ] || ack_end=,
  ack_take '","createdAt":' "$ack_end" || return 1
  is_time "$ack_value" || return 1
  if [ -n "${4:-}" ]; then
    ack_take ',"template":true,"setting":"' '"' || return 1
    [ "$ack_value" = "$4" ] || return 1
    ack_rest=${ack_rest#\"}
  fi
  [ "$ack_rest" = '}' ] || return 1
  printf '%s\n' "$ack_boot"
}
# Sets fail_step and fail_error when the whole file $1 is the closed grammar of the failure ack that
# the extension writes for token $2 and profile $3 when its bootstrap cannot produce the ack:
# {"token":T,"profileId":P,"failedStep":S,"error":E,"createdAt":N}. S is adopt, publish, or ack; E is
# 1 to 200 characters of letters, digits, space, and . , : ; ( ) _ / = - only, so it is safe to log.
read_failure_ack() {
  if [ ! -f "$1" ] || [ -L "$1" ]; then return 1; fi
  size=$(wc -c <"$1" | tr -d ' ')
  [ "$size" -le 4096 ] || return 1
  ack_rest=$(cat -- "$1")
  [ "${#ack_rest}" -eq "$size" ] || return 1
  ack_take '{"token":"' '"' || return 1
  [ "$ack_value" = "$2" ] || return 1
  ack_take '","profileId":"' '"' || return 1
  [ "$ack_value" = "$3" ] || return 1
  ack_take '","failedStep":"' '"' || return 1
  case $ack_value in adopt | publish | ack) fe_step=$ack_value ;; *) return 1 ;; esac
  ack_take '","error":"' '"' || return 1
  [ -n "$ack_value" ] && [ "${#ack_value}" -le 200 ] || return 1
  [ -z "$(printf '%s' "$ack_value" | LC_ALL=C tr -d 'A-Za-z0-9 .,:;()_/=-')" ] || return 1
  fe_error=$ack_value
  ack_take '","createdAt":' '}' || return 1
  is_time "$ack_value" || return 1
  [ "$ack_rest" = '}' ] || return 1
  fail_step=$fe_step fail_error=$fe_error
}
# One look under every candidate Downloads root for the ack of token $4 of profile $3 in namespace
# $2 (record $1); sets acked_root and acked_boot, else leaves the roots tried in $tried.
look_for_ack() {
  candidates=$(downloads_root_candidates "$p_user" "$p_dir" "$1" "$2")
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    folder=$candidate/RECnRun/poc/$2/acks/$3
    if plain_path "$candidate" RECnRun poc "$2" acks "$3" && found_boot=$(read_ack "$folder/$4.json" "$4" "$3"); then
      acked_root=$candidate acked_boot=$found_boot
      return 0
    fi
    if plain_path "$candidate" RECnRun poc "$2" acks "$3" && read_failure_ack "$folder/$4.json" "$4" "$3"; then
      acked_root=$candidate
      return 0
    fi
    tried="$tried${tried:+, }$candidate"
  done <<EOF
$candidates
EOF
  return 1
}
# One look under every candidate Downloads root for the ack of token $2 of any profile in namespace
# $1 (a template ack of setting $3, when given); sets acked_id, acked_root, and acked_boot. The record is not read: no block holds the profile.
look_for_bound() {
  candidates=$(downloads_root_candidates "$p_user" "$p_dir" /nonexistent "$1")
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if plain_path "$candidate" RECnRun poc "$1" acks; then
      for folder in "$candidate/RECnRun/poc/$1/acks"/*/; do
        folder=${folder%/}
        id=${folder##*/}
        is_v4 "$id" || continue
        plain_path "$candidate" RECnRun poc "$1" acks "$id" || continue
        if read_failure_ack "$folder/$2.json" "$2" "$id"; then
          acked_id=$id acked_root=$candidate
          return 0
        fi
        found_boot=$(read_ack "$folder/$2.json" "$2" "$id" "${3:-}") || continue
        acked_id=$id acked_root=$candidate acked_boot=$found_boot
        return 0
      done
    fi
    tried="$tried${tried:+, }$candidate"
  done <<EOF
$candidates
EOF
  return 1
}
# Exits 71 when the ack found is a failure ack: the bootstrap page failed and said where.
exit_on_failure_ack() {
  [ -z "$fail_step" ] || { log "bootstrap failed at $fail_step: $fail_error"; exit 71; }
}
# Whole seconds, the poll at least 1; sets limit and step.
check_timing() {
  limit=${RECNRUN_OPEN_TIMEOUT_S:-60}
  step=${RECNRUN_OPEN_POLL_S:-1}
  case $limit in *[!0-9]*) log 'RECNRUN_OPEN_TIMEOUT_S must be whole seconds'; exit 64 ;; esac
  case $step in *[!0-9]* | 0) log 'RECNRUN_OPEN_POLL_S must be whole seconds, at least 1'; exit 64 ;; esac
}
# Waits up to $limit seconds for the ack with the look named in $looker; the Preferences read repeats
# on every look, since Chrome flushes it late.
wait_for_ack() {
  waited=0
  fail_step='' fail_error=''
  while :; do
    tried=
    if "$looker" "$@"; then return 0; fi
    [ "$waited" -lt "$limit" ] || return 1
    sleep "$step"
    waited=$((waited + step))
  done
}

# --- The request -----------------------------------------------------------------------------

# One visible and one headless Chrome never share a root: refuses when the main process on $p_user runs the other mode.
refuse_other_mode() {
  st_pid=''
  rm_pid=$(main_pid_of "$p_user") || return 0
  [ -n "$rm_pid" ] || return 0
  rm_cmd=$(ps -o command= -p "$rm_pid" 2>/dev/null)
  case $rm_cmd in
    *" --headless"*) rm_running=headless ;;
    *) rm_running=headed ;;
  esac
  [ "$rm_running" = "$mode" ] || refuse "$p_user already runs $rm_running; quit it before opening it $mode"
}
# Chrome runs in the background with separate words, never through a shell string.
start_chrome() {
  refuse_other_mode
  finder=chrome_binary # by name: ShellCheck would read a bare call as a forgotten "$@"
  chrome=$("$finder") || { log 'no Google Chrome found'; exit 66; }
  url=chrome-extension://$p_ext/bootstrap.html#token=$1
  set -- "--user-data-dir=$p_user" "--profile-directory=$p_dir" --no-first-run --no-default-browser-check "$url"
  [ "$mode" != headless ] || set -- --headless=new "$@"
  "$chrome" "$@" >/dev/null 2>&1 &
  log "pid=$!"
  launched "$!"
}
# Called with the pid right after the launch; a script that sources this one redefines it.
launched() { :; }
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
  looker=look_for_ack
  if ! wait_for_ack "$1" "$2" "$3" "$token"; then
    log "no ack for $token within $limit s: tried ${tried:-no candidate}"
    exit 69
  fi
  exit_on_failure_ack
  printf 'root=%s\nboot=%s\ntoken=%s\n' "$acked_root" "$acked_boot" "$token"
}

# The same request for a profile the record does not hold yet: the ack names the profile id.
bind_profile() {
  [ "$#" -ge 3 ] || { log 'usage: open.sh bind <userDataDir> <profileDirectory> <namespace> [headed|headless]'; exit 64; }
  [ "$#" -le 4 ] || refuse 'a free argument: the request is the user data directory, profile directory, namespace, and mode'
  mode=headed
  [ "$#" -lt 4 ] || mode=$4
  case $mode in headed | headless) ;; *) refuse 'the mode is neither headed nor headless' ;; esac
  check_timing
  is_record_directory "$1" || refuse 'the user data directory is not a plain absolute directory'
  is_profile_directory "$2" || refuse 'the profile directory is not a profile directory name'
  is_namespace "$3" || refuse 'the namespace is not a namespace'
  p_user=$1 p_dir=$2
  validate_profile
  token=$(new_token)
  start_chrome "$token"
  looker=look_for_bound
  if ! wait_for_ack "$3" "$token"; then
    log "no ack for $token within $limit s: tried ${tried:-no candidate}"
    exit 69
  fi
  exit_on_failure_ack
  printf 'profileId=%s\nroot=%s\nboot=%s\ntoken=%s\n' "$acked_id" "$acked_root" "$acked_boot" "$token"
}

if [ -z "$open_as_library" ]; then
  [ "$#" -ge 1 ] || { log 'usage: open.sh open <record> <namespace> <profileId> [headed|headless]'; exit 64; }
  entry=$1
  shift
  case $entry in
    open) open_profile "$@" ;;
    bind) bind_profile "$@" ;;
    *) log "unknown command $entry"; exit 64 ;;
  esac
fi
