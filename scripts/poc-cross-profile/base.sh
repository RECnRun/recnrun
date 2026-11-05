#!/bin/sh
# base.sh create-base <bases-dir> <name>
# base.sh template <bases-dir> <name> <namespace>
# base.sh quit <bases-dir> <name>
# base.sh freeze <bases-dir> <name> <namespace> <extensionId>
#
# The clean base of the clones (POC PLAN.md P5.1, decisions 10 and 11): a Chrome user data root the
# owner prepares once and freezes, which create-clone copies whole. Layout: <bases-dir>/<name>/
# with `Local State` and `Default/`, <name> matching base-v<n>. POSIX sh only, no JSON parser,
# nothing read from a file is ever run or expanded; positional arguments only. Source it with
# RECNRUN_DISCOVERY_LIB=1 for the functions.
#
#   create-base   a new root (an existing path of any kind, a link included, is refused with 73);
#                 `Default/Preferences` pins the Downloads root to <root>/downloads before the first
#                 launch, so the base never writes into ~/Downloads; Chrome starts headed on the
#                 root at chrome://extensions/ and chrome://version/ (the owner loads the extension
#                 there) and is not waited for. stderr pid=<n>, stdout root=<root>.
#   template      hands chrome-extension://<id>/bootstrap.html#template=<token>&setting=<name> to the
#                 Chrome that holds the root and waits for the ack of the token that carries
#                 "template":true and "setting":"<name>"; stdout profileId=, token=, root=
#                 (the Downloads root). A frozen base is refused.
#   quit          SIGTERM to the main Chrome of the root (only the Chrome of open.sh whose command line
#                 names it), then waits until no process names it.
#   freeze        refuses while any process names the root; with the extension in Default, a
#                 template ack of <name>, and the Preferences, writes <root>/.recnrun-base:
#                 setting, extensionId, profileId, namespace, frozenAt (epoch seconds), install
#                 (packed or unpacked), one key=value per line; the same freeze again changes nothing.
#
# Environment: RECNRUN_OPEN_TIMEOUT_S (60) and RECNRUN_OPEN_POLL_S (1) bound the template wait,
# RECNRUN_LIFECYCLE_STOP_S (20) the quit; RECNRUN_DISCOVERY_PREFIX and RECNRUN_DISCOVERY_UNAME as in profiles.sh.
# Exit: 0 done, 64 wrong call, 65 refused, 66 no Chrome or extension id, 69 no template ack in time,
# 70 a process still names the root, 73 the root exists or cannot be written, 75 a process holds the root.

base_as_library=${RECNRUN_DISCOVERY_LIB:-}
# shellcheck source=open.sh
RECNRUN_DISCOVERY_LIB=1 . "$(dirname -- "$0")/open.sh"
RECNRUN_DISCOVERY_LIB=$base_as_library # a dot keeps its own assignment: give back what this script saw
# shellcheck source=lifecycle-state.sh
. "$(dirname -- "$0")/lifecycle-state.sh"
# shellcheck source=base-freeze.sh
. "$(dirname -- "$0")/base-freeze.sh"

log() { printf 'base.sh: %s\n' "$*" >&2; }
die() {
  d_status=$1
  shift
  log "$*"
  exit "$d_status"
}
refuse() { die 65 "refused: $*"; }
record_refuse() { refuse "$*"; }

# --- The root --------------------------------------------------------------------------------

# A path the Preferences JSON and a command line carry without escaping.
is_plain_root() {
  case $1 in '' | *[!A-Za-z0-9._/-]*) return 1 ;; esac
  is_directory "$1"
}
is_base_name() {
  case $1 in base-v | *[!a-z0-9-]*) return 1 ;; esac
  case ${1#base-v} in '' | *[!0-9]*) return 1 ;; esac
  case $1 in base-v*) return 0 ;; esac
  return 1
}
# Sets name and root from the two arguments, or refuses.
check_root_arguments() {
  if [ ! -d "$1" ] || [ -L "$1" ]; then refuse 'the bases directory is not a plain existing directory'; fi
  is_plain_root "$1" || refuse 'the bases directory is not an absolute path of letters, digits, dot, underscore, hyphen, and slash'
  is_base_name "$2" || refuse 'the name is not base-v<number>'
  name=$2 root=$1/$2
  is_plain_root "$root" || refuse 'the root path has a character other than letters, digits, dot, underscore, hyphen, and slash'
}
# An existing base root: a plain directory, as create-base made it.
check_existing_root() {
  check_root_arguments "$@"
  if [ ! -d "$root" ] || [ -L "$root" ]; then refuse "$root is not a plain existing directory: create-base makes it"; fi
}
refuse_frozen() {
  if [ -e "$root/.recnrun-base" ] || [ -L "$root/.recnrun-base" ]; then refuse "$root is a frozen base"; fi
}
# Every pid whose command line names the root, in holders; empty when none does.
holders_of() {
  holders=
  while read -r h_pid h_cmd; do
    names_root "$h_cmd" "$1" && holders="$holders${holders:+ }$h_pid"
  done <<HOLDERS
$(ps -axo pid=,command= 2>/dev/null)
HOLDERS
  return 0
}

# --- create-base -----------------------------------------------------------------------------

create_base() {
  [ "$#" -eq 2 ] || die 64 'usage: base.sh create-base <bases-dir> <name>'
  check_root_arguments "$@"
  if [ -e "$root" ] || [ -L "$root" ]; then die 73 "$root exists"; fi
  finder=chrome_binary # by name: ShellCheck would read a bare call as a forgotten "$@"
  chrome=$("$finder") || die 66 'no Google Chrome found'
  mkdir -- "$root" || die 73 "cannot create $root"
  mkdir -- "$root/Default" || die 73 "cannot create $root/Default"
  # The pin is written before the first launch; directory_upgrade keeps Chrome from resetting it.
  (
    set -C
    printf '{"download":{"default_directory":"%s/downloads","directory_upgrade":true,"prompt_for_download":false}}' "$root" >"$root/Default/Preferences"
  ) || die 73 'cannot write Default/Preferences'
  "$chrome" "--user-data-dir=$root" --profile-directory=Default --no-first-run --no-default-browser-check \
    chrome://extensions/ chrome://version/ >/dev/null 2>&1 &
  log "pid=$!"
  printf 'root=%s\n' "$root"
}

# --- template --------------------------------------------------------------------------------

template_base() {
  [ "$#" -eq 3 ] || die 64 'usage: base.sh template <bases-dir> <name> <namespace>'
  check_existing_root "$1" "$2"
  refuse_frozen
  is_namespace "$3" || refuse 'the namespace is not a namespace'
  finder=chrome_binary
  chrome=$("$finder") || die 66 'no Google Chrome found'
  base_ext=
  if [ -f "$here/extension-id" ]; then base_ext=$(head -n 1 "$here/extension-id"); fi
  is_extension_id "$base_ext" || die 66 'no valid extension id next to this script'
  check_timing
  p_user=$root p_dir=Default
  token=$(new_token)
  # Chrome gives the URL to the instance that holds the root, or starts one on it.
  "$chrome" "--user-data-dir=$root" --profile-directory=Default \
    "chrome-extension://$base_ext/bootstrap.html#template=$token&setting=$name" >/dev/null 2>&1 &
  log "pid=$!"
  looker=look_for_bound
  if ! wait_for_ack "$3" "$token" "$name"; then
    log "no template ack for $token within $limit s: tried ${tried:-no candidate}"
    exit 69
  fi
  printf 'profileId=%s\ntoken=%s\nroot=%s\n' "$acked_id" "$token" "$acked_root"
}

# --- quit ------------------------------------------------------------------------------------

quit_base() {
  [ "$#" -eq 2 ] || die 64 'usage: base.sh quit <bases-dir> <name>'
  check_existing_root "$@"
  stop_s=$(setting "${RECNRUN_LIFECYCLE_STOP_S:-}" 20 RECNRUN_LIFECYCLE_STOP_S) || exit $?
  st_pid=''
  main=$(main_pid_of "$root") || main=''
  if [ -z "$main" ]; then
    holders_of "$root"
    [ -z "$holders" ] || die 70 "no main Chrome names $root, but pids $holders do"
    log "not running: no process names $root"
    return 0
  fi
  is_chrome_of "$(ps -o command= -p "$main" 2>/dev/null)" "$root" || refuse "pid $main is not the Chrome of this machine on $root: not signalled"
  kill -TERM "$main"
  waited=0
  while :; do
    holders_of "$root"
    [ -n "$holders" ] || break
    [ "$waited" -lt "$stop_s" ] || die 70 "pids $holders still name $root after $stop_s s"
    sleep 1
    waited=$((waited + 1))
  done
  log "stopped pid $main"
}

if [ -z "$base_as_library" ]; then
  [ "$#" -ge 1 ] || die 64 'usage: base.sh create-base|template|quit|freeze [argument ...]'
  entry=$1
  shift
  case $entry in
    create-base) create_base "$@" ;;
    template) template_base "$@" ;;
    quit) quit_base "$@" ;;
    freeze) freeze_base "$@" ;;
    *) die 64 "unknown command $entry" ;;
  esac
fi
