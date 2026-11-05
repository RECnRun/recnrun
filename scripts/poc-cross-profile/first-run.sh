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
# A profile with a distinct binding (profiles.sh bind_profiles) is registered from its presence: the
# extension is installed and exactly one presence sits in a Downloads root no other profile reaches.
# A shared profile (several profiles download to one folder, the usual layout) and an unbound one
# (no presence yet) are bound by a token ack instead: `open.sh bind` starts Chrome on the profile and
# takes the profileId and the Downloads root from the ack that carries its token. That Chrome is
# left running. A profile that does not ack is left out and the run exits 70 naming it; the record
# never gets a profile the extension did not ack.
#
# Output: one line per profile, `<profileId> <status>`, then the autostart command to run next.
# Exit: 0 every registered profile is open, 64 wrong call, 65 refused path, 66 no profile to
# register and none registered, 70 a profile did not open or did not ack its binding.

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
# Prints the profileId of the block that holds this root and profile directory, if the record has one.
registered_id() {
  [ -f "$fr_record" ] || return 1
  rg_user='' rg_dir='' rg_id=''
  while IFS= read -r rg_line || [ -n "$rg_line" ]; do
    case $rg_line in
      '') rg_user='' rg_dir='' rg_id='' ;;
      userDataDir=*) rg_user=${rg_line#userDataDir=} ;;
      profileDirectory=*) rg_dir=${rg_line#profileDirectory=} ;;
      profileId=*) rg_id=${rg_line#profileId=} ;;
    esac
    if [ "$rg_user" = "$1" ] && [ "$rg_dir" = "$2" ] && [ -n "$rg_id" ]; then
      printf '%s\n' "$rg_id"
      return 0
    fi
  done <"$fr_record"
  return 1
}
# Binds a profile with no distinct binding through its token ack and registers it with the acked
# id and root; a profile that does not ack goes to fr_left and a registered one is left alone.
bind_row() {
  br_root=$1 br_name=$2
  if br_id=$(registered_id "$br_root" "$br_name"); then
    log "$br_id: already registered ($br_name of $br_root)"
    fr_ids=$fr_ids$br_id$nl
    return 0
  fi
  br_out=$(RECNRUN_DISCOVERY_LIB='' /bin/sh "$fr_dir/open.sh" bind "$br_root" "$br_name" "$fr_ns") || br_out=''
  br_id='' br_downloads=''
  while IFS= read -r br_line; do
    case $br_line in
      profileId=*) br_id=${br_line#profileId=} ;;
      root=*) br_downloads=${br_line#root=} ;;
    esac
  done <<EOF
$br_out
EOF
  if [ -z "$br_id" ] || [ -z "$br_downloads" ]; then
    log "$br_name of $br_root: did not ack the bootstrap token, left out"
    fr_left=$fr_left$br_name$nl
    return 0
  fi
  register_profile "$br_id" "$br_root" "$br_name" "$br_downloads"
  fr_ids=$fr_ids$br_id$nl
}
# Registers each distinct profile and binds the others; sets fr_ids to the ids of those, one per line.
register_all() {
  fr_ids='' fr_left=''
  fr_rows=$(bind_profiles "$fr_record" "$fr_ns" "$fr_ext") || die 70 'cannot read the profiles'
  while IFS="$tab" read -r ra_id ra_root ra_name ra_downloads ra_kind; do
    case $ra_kind in
      distinct)
        register_profile "$ra_id" "$ra_root" "$ra_name" "$ra_downloads"
        fr_ids=$fr_ids$ra_id$nl
        ;;
      shared | unbound) bind_row "$ra_root" "$ra_name" ;;
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
if [ -z "$fr_ids" ]; then
  [ -z "$fr_left" ] || die 70 "no profile acked: $(printf '%s' "$fr_left" | tr "$nl" ' ')"
  die 66 'no profile with the extension: load the extension in a profile and try again'
fi
open_registered
report
if [ "$fr_failed" -ne 0 ]; then die 70 'a profile did not open; see the lines above'; fi
[ -z "$fr_left" ] || die 70 "a profile did not ack and is not registered: $(printf '%s' "$fr_left" | tr "$nl" ' ')"
printf 'next: sh recnrun-launcher autostart on %s %s %s\n' "$fr_state" "$fr_record" "$fr_ns"
