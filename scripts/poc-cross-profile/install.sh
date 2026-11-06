#!/bin/sh
# install.sh install-base <bases-dir> <name> <namespace> <build-dir>
#
# The automatic installation of the extension in a clean base (POC PLAN.md P6.2, CL17, E10): Chrome
# starts on the base root with the DevTools pipe, the build is loaded with Extensions.loadUnpacked,
# Developer mode is turned on and the build reloaded through chrome://extensions, and Chrome is
# closed through the same pipe. The reload drops the creation flag of a CDP install, which Chrome
# deletes at the next profile load; Developer mode, written by Chrome itself, keeps the reloaded
# unpacked build enabled (CHROMIUM.md groups 9 and 16). Every later launch of the base has no
# debugging flag. POSIX sh only, no JSON parser, nothing read from a file or the pipe is ever run
# or expanded: a reply is only matched against a closed grammar. Source it with
# RECNRUN_DISCOVERY_LIB=1 for the functions.
#
#   install-base  <bases-dir>/<name> is a root base.sh create-base made (Default/Preferences pins its
#                 Downloads root to <root>/downloads), not frozen, and no process names it; <build-dir>
#                 is a plain absolute directory with a manifest.json whose key gives the id of the file
#                 extension-id. Chrome runs with separate words: --user-data-dir=<root>
#                 --profile-directory=Default --no-first-run --no-default-browser-check
#                 --remote-debugging-pipe --enable-unsafe-extension-debugging, the pipe on fds 3 and 4
#                 (NUL-terminated JSON). stderr pid=<n>; stdout extensionId=, installS=.
#
# Environment: RECNRUN_OPEN_TIMEOUT_S (60) bounds each reply and the exit of Chrome, RECNRUN_OPEN_POLL_S
# (1) the poll; TMPDIR holds the two fifos; RECNRUN_DISCOVERY_PREFIX and RECNRUN_DISCOVERY_UNAME as in
# profiles.sh.
# Exit: 0 installed, 64 wrong call, 65 refused, 66 no Chrome or extension id, 69 no reply in time (Chrome
# is left running for lifecycle.sh stop), 70 another id was loaded, a step failed, Chrome kept no
# settings entry, or Chrome did not exit, 73 the fifos cannot be made, 75 a process holds the root.

install_as_library=${RECNRUN_DISCOVERY_LIB:-}
# shellcheck source=base.sh
RECNRUN_DISCOVERY_LIB=1 . "$(dirname -- "$0")/base.sh"
RECNRUN_DISCOVERY_LIB=$install_as_library # a dot keeps its own assignment: give back what this script saw

log() { printf 'install.sh: %s\n' "$*" >&2; }

# --- The request -----------------------------------------------------------------------------

# Sets root, build, and want from the four arguments, or refuses before anything starts.
check_install_request() {
  check_existing_root "$1" "$2"
  is_partial_root "$root" && refuse 'an unpublished copy is not a base'
  refuse_frozen
  is_namespace "$3" || refuse 'the namespace is not a namespace'
  is_plain_root "$4" || refuse 'the build is not an absolute directory of letters, digits, dot, underscore, hyphen, and slash'
  [ ! -L "$4" ] || refuse 'the build is a symbolic link'
  is_plain_file "$4/manifest.json" || refuse 'the build has no manifest.json'
  build=$4
  # Without the pin the extension's first presence would land in the OS Downloads folder.
  is_plain_file "$root/Default/Preferences" || refuse "$root/Default/Preferences is missing: create-base writes it"
  grep -q -F -e "\"default_directory\":\"$root/downloads\"" "$root/Default/Preferences" ||
    refuse "$root/Default/Preferences does not pin the Downloads root to $root/downloads"
  want=
  if [ -f "$here/extension-id" ]; then want=$(head -n 1 "$here/extension-id"); fi
  is_extension_id "$want" || die 66 'no valid extension id next to this script'
  holders_of "$root"
  [ -z "$holders" ] || die 75 "a process holds the root: pids $holders"
}

# --- The pipe --------------------------------------------------------------------------------

pipe_cleanup() {
  exec 5>&-
  [ -z "${pp_reader:-}" ] || kill "$pp_reader" 2>/dev/null
  [ -z "${pp_dir:-}" ] || rm -rf -- "$pp_dir"
}
# Two fifos in a fresh private folder; Chrome reads commands on fd 3 and writes replies on fd 4, and
# cat copies every reply byte to a file at once (tr would hold them in its buffer).
pipe_open() {
  pp_dir=${TMPDIR:-/tmp}
  pp_dir=${pp_dir%/}/recnrun-install-$(lc_random)
  (umask 077 && mkdir -- "$pp_dir") || die 73 "cannot create $pp_dir"
  trap pipe_cleanup EXIT
  mkfifo -- "$pp_dir/in" "$pp_dir/out" || die 73 "cannot make the fifos in $pp_dir"
  : >"$pp_dir/replies"
  exec 5<>"$pp_dir/in"
  cat <"$pp_dir/out" >"$pp_dir/replies" &
  pp_reader=$!
  pp_id=0
}
start_pipe_chrome() {
  finder=chrome_binary # by name: ShellCheck would read a bare call as a forgotten "$@"
  chrome=$("$finder") || die 66 'no Google Chrome found'
  "$chrome" "--user-data-dir=$root" --profile-directory=Default --no-first-run --no-default-browser-check \
    --remote-debugging-pipe --enable-unsafe-extension-debugging \
    3<"$pp_dir/in" 4>"$pp_dir/out" 5<&- >/dev/null 2>&1 &
  chrome_pid=$!
  log "pid=$chrome_pid"
}
# Sends one command with the next id; $1 is the method, $2 its params object, $3 a sessionId or empty.
send() {
  pp_id=$((pp_id + 1))
  pp_session=
  [ -z "${3:-}" ] || pp_session=",\"sessionId\":\"$3\""
  printf '{"id":%s%s,"method":"%s","params":%s}\0' "$pp_id" "$pp_session" "$1" "$2" >&5
  sent="$sent${sent:+, }$1"
}
# The reply to the last id among the complete (NUL-terminated) messages so far, in reply; else empty.
read_reply() {
  rr_count=$(tr -cd '\000' <"$pp_dir/replies" | wc -c | tr -d ' ')
  reply=
  [ "$rr_count" -gt 0 ] || return 1
  reply=$(tr '\000' '\n' <"$pp_dir/replies" | head -n "$rr_count" | sed -n "/^{\"id\":$pp_id,/{p;q;}")
  [ -n "$reply" ]
}
# Waits up to $limit seconds for the reply to the last command; 69 when none came, Chrome left running.
await_reply() {
  ar_waited=0
  while ! read_reply; do
    pid_alive "$chrome_pid" || die 69 "Chrome (pid $chrome_pid) exited with no reply to $1: sent $sent"
    [ "$ar_waited" -lt "$limit" ] || die 69 "no reply to $1 within $limit s: sent $sent; Chrome pid $chrome_pid left for lifecycle.sh stop"
    sleep "$step"
    ar_waited=$((ar_waited + step))
  done
}
# The value of "$1":"<value>" in the reply, when the value matches the grammar $2 (a case pattern).
reply_field() {
  rf_value=${reply#*\""$1"\":\"}
  [ "$rf_value" != "$reply" ] || return 1
  rf_value=${rf_value%%\"*}
  # shellcheck disable=SC2254 # the grammar is the caller's pattern, never text from the reply
  case $rf_value in '' | $2) return 1 ;; esac
  printf '%s\n' "$rf_value"
}
printable() { printf '%s' "$reply" | tr -cd '[:print:]' | cut -c1-300; }

# --- The steps -------------------------------------------------------------------------------

load_build() {
  send Extensions.loadUnpacked "{\"path\":\"$build\"}"
  await_reply Extensions.loadUnpacked
  loaded=$(reply_field id '*[!a-p]*') || close_and_die "Extensions.loadUnpacked answered $(printable)"
  [ "$loaded" = "$want" ] || close_and_die "Extensions.loadUnpacked loaded $loaded, not $want: the build's key gives another id"
}
# Evaluates the expression $1 on chrome://extensions until it gives true; the page may still be loading.
until_true() {
  ut_started=$(date +%s)
  while :; do
    send Runtime.evaluate "{\"expression\":\"$1\",\"awaitPromise\":true,\"returnByValue\":true}" "$session"
    await_reply "$2"
    case $reply in *'"result":{"result":{"type":"boolean","value":true}}'*) return 0 ;; esac
    [ $(($(date +%s) - ut_started)) -lt "$limit" ] || close_and_die "$2 did not give true within $limit s: $(printable)"
    sleep "$step"
  done
}
# Developer mode through Chrome's own setting (Chrome writes it with its MAC), then the reload.
keep_build() {
  send Target.createTarget '{"url":"chrome://extensions/"}'
  await_reply Target.createTarget
  target=$(reply_field targetId '*[!0-9A-F]*') || close_and_die "Target.createTarget answered $(printable)"
  send Target.attachToTarget "{\"targetId\":\"$target\",\"flatten\":true}"
  await_reply Target.attachToTarget
  session=$(reply_field sessionId '*[!0-9A-F]*') || close_and_die "Target.attachToTarget answered $(printable)"
  until_true 'chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}).then(()=>chrome.developerPrivate.getProfileConfiguration()).then((c)=>c.inDeveloperMode===true)' 'Developer mode'
  until_true "chrome.developerPrivate.reload('$want',{failQuietly:true}).then(()=>true)" 'the reload'
  until_true "chrome.developerPrivate.getExtensionInfo('$want').then((i)=>i.state==='ENABLED')" 'the reloaded build'
}
# Browser.close over the pipe, then the pid Chrome started under is waited for, and only after a full
# wait gets SIGINT, Chrome's normal shutdown (SIGTERM would skip it); returns 1 when it still runs.
close_chrome() {
  send Browser.close '{}'
  cc_waited=0
  cc_ended=Browser.close
  while pid_alive "$chrome_pid"; do
    if [ "$cc_waited" -eq "$limit" ]; then
      log "Chrome pid $chrome_pid still runs $limit s after Browser.close: SIGINT"
      kill -INT "$chrome_pid" 2>/dev/null
      cc_ended=SIGINT
    fi
    [ "$cc_waited" -lt $((limit * 2)) ] || return 1
    sleep "$step"
    cc_waited=$((cc_waited + step))
  done
  log "Chrome pid $chrome_pid ended by $cc_ended"
  # Helper processes of the root can outlive the main one by a moment.
  while holders_of "$root" && [ -n "$holders" ]; do
    [ "$cc_waited" -lt $((limit * 2)) ] || return 1
    sleep "$step"
    cc_waited=$((cc_waited + step))
  done
}
close_and_die() {
  close_chrome || log "pids ${holders:-$chrome_pid} still name $root"
  die 70 "$1"
}

install_base() {
  [ "$#" -eq 4 ] || die 64 'usage: install.sh install-base <bases-dir> <name> <namespace> <build-dir>'
  check_install_request "$@"
  check_timing
  started=$(date +%s)
  sent=
  pipe_open
  start_pipe_chrome
  load_build
  keep_build
  close_chrome || die 70 "Chrome still names $root after Browser.close and SIGINT: pids ${holders:-$chrome_pid}"
  extension_in_profile "$root" Default "$want" >/dev/null || die 70 "Chrome kept no settings entry of $want in $root/Default"
  printf 'extensionId=%s\ninstallS=%s\n' "$want" $(($(date +%s) - started))
}

if [ -z "$install_as_library" ]; then
  [ "$#" -ge 1 ] || die 64 'usage: install.sh install-base <bases-dir> <name> <namespace> <build-dir>'
  entry=$1
  shift
  case $entry in
    install-base) install_base "$@" ;;
    *) die 64 "unknown command $entry" ;;
  esac
fi
