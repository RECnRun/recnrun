#!/bin/sh
# first-run.sh [<state-dir> <record> <namespace>]
#
# The launcher's first run (POC PLAN.md P4.6): registers each profile that has the extension and a
# presence of its own, then opens every registered profile of the namespace once and checks that
# each acked. POSIX sh only, no JSON parser; positional arguments only, nothing read from a file is
# ever run or expanded. Run it again after loading the extension in another profile: a profile that
# is already registered is left alone, and an open one is not opened twice.
#
# Defaults (no argument): state dir $HOME/.recnrun/launcher, record $HOME/.recnrun/launcher.record,
# namespace lab (the POC extension's own). Both paths are made of letters, digits, dot, underscore,
# hyphen, and slash only, which is what `autostart on` accepts.
#
# A profile is registered only when its binding is distinct (profiles.sh bind_profiles): the
# extension is installed and exactly one presence sits in a Downloads root no other profile
# reaches. An unbound profile has not run the extension yet; a shared one waits for its token ack.
#
# Output: one line per profile, `<profileId> <status>`, then the autostart command to run next.
# Exit: 0 every registered profile is open, 64 wrong call, 65 refused path, 66 no profile to
# register and none registered, 70 a profile did not open.

fr_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
# shellcheck source=profiles.sh
RECNRUN_DISCOVERY_LIB=1 . "$fr_dir/profiles.sh"

log() { printf 'first-run.sh: %s\n' "$*" >&2; }
die() {
  d_status=$1
  shift
  log "$*"
  exit "$d_status"
}

# The record grammar's characters (decision 11): a value outside them is never written.
is_plain() {
  case $1 in '' | *[!A-Za-z0-9._:/\ -]*) return 1 ;; esac
  return 0
}
# Letters, digits, dot, underscore, hyphen, and slash: what the autostart writer accepts.
is_unit_path() {
  case $1 in '' | *[!A-Za-z0-9._/-]*) return 1 ;; esac
  is_directory "$1"
}

# --- Arguments -------------------------------------------------------------------------------

fr_arguments() {
  case $# in
    0)
      is_unit_path "${HOME:-}" || die 65 'HOME must be an absolute path of letters, digits, dot, underscore, hyphen, and slash'
      fr_state=$HOME/.recnrun/launcher
      fr_record=$HOME/.recnrun/launcher.record
      fr_ns=lab
      ;;
    3)
      fr_state=$1 fr_record=$2 fr_ns=$3
      ;;
    *) die 64 'usage: first-run.sh [<state-dir> <record> <namespace>]' ;;
  esac
  is_unit_path "$fr_state" || die 65 'the state directory is not an absolute path of plain characters'
  is_unit_path "$fr_record" || die 65 'the record is not an absolute path of plain characters'
  is_namespace "$fr_ns" || die 65 'the namespace is not a namespace'
  if [ -e "$fr_record" ] && [ ! -f "$fr_record" ]; then die 65 'the record is not a file'; fi
  fr_ext=''
  if [ -f "$fr_dir/extension-id" ]; then fr_ext=$(head -n 1 "$fr_dir/extension-id"); fi
  is_extension_id "$fr_ext" || die 66 'no valid extension id next to this script'
}

# --- Registration ----------------------------------------------------------------------------

# Appends the block of one distinct profile unless the record names its id already.
register_profile() {
  rp_id=$1 rp_root=$2 rp_name=$3 rp_downloads=$4
  if [ -f "$fr_record" ] && grep -Fxq -- "profileId=$rp_id" "$fr_record"; then
    log "$rp_id: already registered"
    return 0
  fi
  if ! is_plain "$rp_root" || ! is_plain "$rp_name" || ! is_plain "$rp_downloads"; then
    log "$rp_id: skipped, a path of the profile has characters the record cannot hold"
    return 0
  fi
  rp_gap=''
  if [ -s "$fr_record" ]; then rp_gap=$nl; fi
  {
    printf '%s' "$rp_gap"
    printf 'userDataDir=%s\nprofileDirectory=%s\nprofileId=%s\nnamespace=%s\ndownloadsRoot=%s\n' \
      "$rp_root" "$rp_name" "$rp_id" "$fr_ns" "$rp_downloads"
  } >>"$fr_record" || die 70 "cannot write $fr_record"
  log "$rp_id: registered ($rp_name of $rp_root)"
}
# Registers each distinct profile; sets fr_ids to the ids of those, one per line.
register_all() {
  fr_ids=''
  fr_rows=$(bind_profiles "$fr_record" "$fr_ns" "$fr_ext") || die 70 'cannot read the profiles'
  while IFS="$tab" read -r ra_id ra_root ra_name ra_downloads ra_kind; do
    case $ra_kind in
      distinct)
        register_profile "$ra_id" "$ra_root" "$ra_name" "$ra_downloads"
        fr_ids=$fr_ids$ra_id$nl
        ;;
      shared) log "$ra_name of $ra_root: shares its Downloads root with another profile, skipped" ;;
      unbound) log "$ra_name of $ra_root: has the extension but no presence yet, open this profile once and run first-run again" ;;
    esac
  done <<EOF
$fr_rows
EOF
}

# --- Opening ---------------------------------------------------------------------------------

# The library flag stays out of the children: some shells keep it set after the dot above.
open_registered() {
  RECNRUN_DISCOVERY_LIB='' /bin/sh "$fr_dir/recnrun-launcher.sh" start "$fr_state" "$fr_record" "$fr_ns" --once >&2
  or_code=$?
  case $or_code in
    0) ;;
    75) log 'a launcher already runs: its next pass opens a profile that is not open yet' ;;
    *) log "start --once exited $or_code" ;;
  esac
}
# Prints "<id> <status>" for each id of fr_ids and sets fr_failed to 1 when one is not open.
report() {
  fr_failed=0
  fr_status=$(RECNRUN_DISCOVERY_LIB='' /bin/sh "$fr_dir/lifecycle.sh" status "$fr_state") || fr_status=''
  while IFS= read -r rp_wanted; do
    [ -n "$rp_wanted" ] || continue
    rp_found=none
    while read -r rp_id rp_state _; do
      [ "$rp_id" != "$rp_wanted" ] || rp_found=$rp_state
    done <<EOF
$fr_status
EOF
    printf '%s %s\n' "$rp_wanted" "$rp_found"
    [ "$rp_found" = open ] || fr_failed=1
  done <<EOF
$fr_ids
EOF
}

fr_arguments "$@"
umask 077
mkdir -p -- "$fr_state" "$(dirname -- "$fr_record")" || die 70 'cannot create the state directory'
register_all
[ -n "$fr_ids" ] || die 66 'no profile with the extension and a presence of its own: load the extension in a profile, let Chrome run, and try again'
open_registered
report
if [ "$fr_failed" -ne 0 ]; then die 70 'a profile did not open; see the lines above'; fi
printf 'next: sh recnrun-launcher autostart on %s %s %s\n' "$fr_state" "$fr_record" "$fr_ns"
