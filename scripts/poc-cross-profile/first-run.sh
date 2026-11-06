#!/bin/sh
# first-run.sh [--autostart] [<state-dir> <record> <namespace>]
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
# left running, or is the Chrome already running on the root, and the ack counts as the open: the state is
# written open (lifecycle.sh adopt) so the launcher's pass does not open the profile again. A profile that does not ack is left out and the run exits 70 naming it; the record
# never gets a profile the extension did not ack.
#
# The Default of the OS default user data root becomes the master (PLAN.md P3.4) when the namespace has
# none: its token bind carries `master` (open.sh), and master-role.sh writes `role=master` into the
# record only after that ack. A failed claim exits 70; the next run asks again.
#
# Output: one line per profile, `<profileId> <status>`, then the autostart command to run next.
# With --autostart (the entry's `install`) the run ends by running `autostart on` with the same state
# dir, record, and namespace, only when every profile is open and the Default is the master, and
# prints `autostart on` instead of the next line.
# Exit: 0 every registered profile is open (and autostart is on with --autostart), 64 wrong call,
# 65 refused path, 66 no profile to register and none registered, 70 a profile did not open or did
# not ack its binding, the Default did not become the master, or autostart on failed (the profiles
# stay open and the next run only repeats the autostart).

fr_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
# shellcheck source=profiles.sh
RECNRUN_DISCOVERY_LIB=1 . "$fr_dir/profiles.sh"
# shellcheck source=master-role.sh
. "$fr_dir/master-role.sh"

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
    *) die 64 'usage: first-run.sh [--autostart] [<state-dir> <record> <namespace>]' ;;
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
# Succeeds for the Default of the OS default user data root while the namespace has no master.
wants_master() {
  [ "$2" = Default ] && [ "$1" = "$(default_root)" ] && ! namespace_has_master "$fr_record" "$fr_ns"
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
  br_mode=''
  if wants_master "$br_root" "$br_name"; then br_mode='headed master'; fi
  # shellcheck disable=SC2086 # br_mode is two fixed words or empty
  br_out=$(RECNRUN_DISCOVERY_LIB='' /bin/sh "$fr_dir/open.sh" bind "$br_root" "$br_name" "$fr_ns" $br_mode) || br_out=''
  br_id='' br_downloads='' br_boot=''
  while IFS= read -r br_line; do
    case $br_line in
      profileId=*) br_id=${br_line#profileId=} ;;
      root=*) br_downloads=${br_line#root=} ;;
      boot=*) br_boot=${br_line#boot=} ;;
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
  if [ -n "$br_mode" ]; then set_master_role "$fr_record" "$br_root" "$br_name" "$fr_ns" || true; fi
  fr_ids=$fr_ids$br_id$nl
  adopt_open "$br_id" "$br_downloads" "$br_boot"
}
# The ack is the proof that Chrome opened the profile, also when it was the Chrome already running:
# the state says so, and the launcher's pass does not open it again.
adopt_open() {
  RECNRUN_DISCOVERY_LIB='' /bin/sh "$fr_dir/lifecycle.sh" adopt "$fr_state" "$fr_record" "$fr_ns" "$1" "$2" "$3" >&2 ||
    log "$1: could not record the open; the launcher's pass opens it"
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

# --- The master ------------------------------------------------------------------------------

# The Default of the OS default user data root is the master (PLAN.md P3.4), asked once through a
# token: its bootstrap page records the role before it acks, and only that ack lets the record say
# it. A namespace that has a master and a Default that is not registered are left alone. Sets
# fr_master_failed to 1 when the Default does not confirm.
claim_default_master() {
  fr_master_failed=0
  cm_root=$(default_root)
  [ -n "$cm_root" ] || return 0
  cm_id=$(registered_id "$cm_root" Default) || return 0
  if namespace_has_master "$fr_record" "$fr_ns"; then return 0; fi
  cm_out=$(RECNRUN_DISCOVERY_LIB='' /bin/sh "$fr_dir/open.sh" bind "$cm_root" Default "$fr_ns" headed master) || cm_out=''
  cm_acked='' cm_downloads='' cm_boot=''
  while IFS= read -r cm_line; do
    case $cm_line in
      profileId=*) cm_acked=${cm_line#profileId=} ;;
      root=*) cm_downloads=${cm_line#root=} ;;
      boot=*) cm_boot=${cm_line#boot=} ;;
    esac
  done <<EOF
$cm_out
EOF
  if [ "$cm_acked" != "$cm_id" ] || ! set_master_role "$fr_record" "$cm_root" Default "$fr_ns"; then
    log "$cm_id: the Default did not become the master"
    fr_master_failed=1
    return 0
  fi
  log "$cm_id: the master (Default of $cm_root)"
  adopt_open "$cm_id" "$cm_downloads" "$cm_boot"
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

fr_autostart=0
if [ "${1:-}" = --autostart ]; then
  fr_autostart=1
  shift
fi
fr_arguments "$@"
umask 077
mkdir -p -- "$fr_state" "$(dirname -- "$fr_record")" || die 70 'cannot create the state directory'
register_all
claim_default_master
if [ -z "$fr_ids" ]; then
  [ -z "$fr_left" ] || die 70 "no profile acked: $(printf '%s' "$fr_left" | tr "$nl" ' ')"
  die 66 'no profile with the extension: load the extension in a profile and try again'
fi
open_registered
report
if [ "$fr_failed" -ne 0 ]; then die 70 'a profile did not open; see the lines above'; fi
[ "$fr_master_failed" -eq 0 ] || die 70 'the Default did not become the master; see the lines above'
[ -z "$fr_left" ] || die 70 "a profile did not ack and is not registered: $(printf '%s' "$fr_left" | tr "$nl" ' ')"
if [ "$fr_autostart" -eq 0 ]; then
  printf 'next: sh recnrun-launcher autostart on %s %s %s\n' "$fr_state" "$fr_record" "$fr_ns"
  exit 0
fi
RECNRUN_DISCOVERY_LIB='' /bin/sh "$fr_dir/recnrun-launcher.sh" autostart on "$fr_state" "$fr_record" "$fr_ns" >&2 ||
  die 70 'autostart on failed; the profiles stay open, run install again after fixing it'
printf 'autostart on\n'
