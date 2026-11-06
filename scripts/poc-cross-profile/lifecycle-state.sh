#!/bin/sh
# Locks and state files of lifecycle.sh (POC PLAN.md P4.4): the hard-link pid lock and the
# key=value state grammar, and the process lookups of shared roots. Sourced by lifecycle.sh, which also provides log, die, and open.sh's
# is_v4, is_uuid, and is_directory.

# Canonical decimal only: a leading zero would be read as octal by the shell's arithmetic.
is_count() {
  case $1 in '' | 0?* | *[!0-9]*) [ "$1" = 0 ] || return 1 ;; esac
  [ "${#1}" -le 16 ]
}
# A pid is a positive count; kill -0 0 would signal the caller's own process group.
is_pid() {
  [ "$1" != 0 ] || return 1
  is_count "$1"
}
pid_alive() {
  is_pid "$1" || return 1
  kill -0 "$1" 2>/dev/null || return 1
  case $(ps -o stat= -p "$1" 2>/dev/null) in Z*) return 1 ;; esac
  return 0
}
# True when the user data dir $1 is shared: the record $2 names it in more than one block, or the
# folder holds more than one Chrome profile (Default, Profile <n> with a Preferences file; System
# Profile and Guest Profile are not profiles a person opens), because a signal closes them all.
root_is_shared() {
  rs_count=0
  while IFS= read -r rs_line || [ -n "$rs_line" ]; do
    [ "$rs_line" != "userDataDir=$1" ] || rs_count=$((rs_count + 1))
  done <"$2"
  [ "$rs_count" -le 1 ] || return 0
  rs_dirs=0
  for rs_dir in "$1/Default" "$1"/Profile\ [0-9]*; do
    [ ! -f "$rs_dir/Preferences" ] || rs_dirs=$((rs_dirs + 1))
  done
  [ "$rs_dirs" -gt 1 ]
}
# True when the command line $1 carries --user-data-dir=<$2> as a whole argument: a root that only
# starts with $2 (/tmp/root other) is another root, so the value must end at the next flag or the end.
names_root() {
  case $1 in *" --user-data-dir=$2 --"* | *" --user-data-dir=$2") return 0 ;; esac
  return 1
}
# True when the command line $1 is the Chrome open.sh launches (chrome_binary, the same lookup) on the
# user data dir $2. A Chrome started by hand from another path is refused rather than signalled.
is_chrome_of() {
  ic_bin=$(chrome_binary) || return 1
  case $1 in "$ic_bin "*) ;; *) return 1 ;; esac
  names_root "$1" "$2"
}
# True when the command line $1 is the Chrome of open.sh started with no --user-data-dir at all: the
# person's own Chrome (Dock, Start menu), which runs on the OS default root.
is_flagless_chrome() {
  case $1 in *" --user-data-dir="*) return 1 ;; esac
  ifc_bin=$(chrome_binary) || return 1
  case $1 in "$ifc_bin" | "$ifc_bin "*) return 0 ;; esac
  return 1
}
# The main Chrome process of the user data dir $1 (no --type= word): one that is not the pid open.sh
# started, else that pid itself, which is the main when no Chrome ran on the root before. On the OS
# default root a Chrome with no --user-data-dir flag counts too.
main_pid_of() {
  mp_self=''
  mp_default=$(default_root)
  while read -r mp_pid mp_cmd; do
    case $mp_cmd in *" --type="*) continue ;; esac
    if ! names_root "$mp_cmd" "$1"; then
      { [ "$1" = "$mp_default" ] && is_flagless_chrome "$mp_cmd"; } || continue
    fi
    if [ "$mp_pid" != "$st_pid" ]; then
      printf '%s\n' "$mp_pid"
      return 0
    fi
    mp_self=$mp_pid
  done <<MAIN_PIDS
$(ps -axo pid=,command= 2>/dev/null)
MAIN_PIDS
  [ -n "$mp_self" ] && printf '%s\n' "$mp_self"
}
lc_random() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }
setting() {
  s_value=${1:-$2}
  is_count "$s_value" || die 64 "$3 must be whole seconds"
  printf '%s\n' "$s_value"
}

# A dead holder's lock is replaced by one reclaimer at a time: the holder of <lock>.reclaim, taken
# with the same hard link, re-reads the stale lock, removes it only while it still names the dead pid,
# and links its own. The one window left is two reclaimers of a reclaimer that died mid-takeover.
reclaim_lock() {
  rc_lock=$1.reclaim
  rc_tries=0
  while [ "$rc_tries" -lt 3 ]; do
    rc_tries=$((rc_tries + 1))
    if ln -- "$lk_mine" "$rc_lock" 2>/dev/null; then return 0; fi
    rc_pid=
    if [ -f "$rc_lock" ] && [ ! -L "$rc_lock" ]; then read -r rc_pid <"$rc_lock" || rc_pid=gone; fi
    [ "$rc_pid" != gone ] || continue
    is_pid "$rc_pid" || { rm -f -- "$lk_mine"; die 65 "$rc_lock does not name a pid"; }
    if pid_alive "$rc_pid"; then
      rm -f -- "$lk_mine"
      die 75 "another launcher is taking over $1 (pid $rc_pid)"
    fi
    rm -f -- "$rc_lock"
  done
  rm -f -- "$lk_mine"
  die 75 "cannot take over $1"
}
take_lock() {
  lk_mine=$1.mine.$$
  printf '%s\n' "$2" >"$lk_mine"
  lk_tries=0
  while [ "$lk_tries" -lt 3 ]; do
    lk_tries=$((lk_tries + 1))
    if [ ! -d "$1" ] && ln -- "$lk_mine" "$1" 2>/dev/null; then
      rm -f -- "$lk_mine"
      return 0
    fi
    lk_pid=
    if [ -f "$1" ] && [ ! -L "$1" ]; then read -r lk_pid <"$1" || lk_pid=gone; fi
    [ "$lk_pid" != gone ] || continue
    is_pid "$lk_pid" || { rm -f -- "$lk_mine"; die 65 "$1 does not name a pid"; }
    if pid_alive "$lk_pid"; then
      rm -f -- "$lk_mine"
      die 75 "another launcher holds $1 (pid $lk_pid)"
    fi
    reclaim_lock "$1"
    lk_again=
    read -r lk_again <"$1" 2>/dev/null || :
    if [ "$lk_again" = "$lk_pid" ]; then rm -f -- "$1"; fi
    if ln -- "$lk_mine" "$1" 2>/dev/null; then lk_won=1; else lk_won=0; fi
    rm -f -- "$1.reclaim"
    [ "$lk_won" = 0 ] || { rm -f -- "$lk_mine"; return 0; }
  done
  rm -f -- "$lk_mine"
  die 75 "cannot take $1"
}
release_lock() {
  [ -f "$1" ] || return 0
  rl_pid=
  read -r rl_pid <"$1" || :
  if [ "$rl_pid" = "$2" ]; then rm -f -- "$1"; fi
}
# Succeeds when no component of the relative path $2 below $1 is a symbolic link (a missing one is fine).
no_link_below() {
  nl_path=$1
  nl_rest=$2
  while [ -n "$nl_rest" ]; do
    nl_path=$nl_path/${nl_rest%%/*}
    [ ! -L "$nl_path" ] || return 1
    case $nl_rest in */*) nl_rest=${nl_rest#*/} ;; *) nl_rest='' ;; esac
  done
}
state_dir() {
  if ! is_directory "$1" || [ ! -d "$1" ]; then die 64 'the state directory is not an existing absolute directory'; fi
  no_link_below "$1" profiles || die 65 "$1/profiles is a symbolic link"
  mkdir -p -- "$1/profiles"
}

state_defaults() {
  st_token='' st_pid='' st_started=0 st_attempts=0 st_next=0 st_status=none st_boot='' st_root='' st_user='' st_shared=0
}
state_bad() { die 65 "state file $st_file: invalid $1"; }
# Each key has its own grammar; a free value is refused before the shell uses it.
state_set() {
  case $1 in
    token) [ -z "$2" ] || is_v4 "$2" || state_bad "$1"; st_token=$2 ;;
    pid) [ -z "$2" ] || is_pid "$2" || state_bad "$1"; st_pid=$2 ;;
    startedAt) is_count "$2" || state_bad "$1"; st_started=$2 ;;
    attempts) is_count "$2" || state_bad "$1"; [ "${#2}" -le 6 ] || state_bad "$1"; st_attempts=$2 ;;
    nextAt) is_count "$2" || state_bad "$1"; st_next=$2 ;;
    status) case $2 in idle | opening | open | failed | paused | stopped) st_status=$2 ;; *) state_bad "$1" ;; esac ;;
    boot) [ -z "$2" ] || is_uuid "$2" || state_bad "$1"; st_boot=$2 ;;
    root) [ -z "$2" ] || is_directory "$2" || state_bad "$1"; st_root=$2 ;;
    userDataDir) [ -z "$2" ] || is_directory "$2" || state_bad "$1"; st_user=$2 ;;
    shared) case $2 in 0 | 1) st_shared=$2 ;; *) state_bad "$1" ;; esac ;;
    *) state_bad key ;;
  esac
}
read_state() {
  st_file=$1
  state_defaults
  [ -e "$st_file" ] || [ -L "$st_file" ] || return 0
  if [ ! -f "$st_file" ] || [ -L "$st_file" ]; then die 65 "$st_file is not a regular file"; fi
  [ "$(wc -c <"$st_file" | tr -d ' ')" -le 2048 ] || die 65 "$st_file is over 2 KiB"
  st_seen=' '
  while IFS= read -r st_line || [ -n "$st_line" ]; do
    case $st_line in *=*) ;; *) state_bad line ;; esac
    case $st_seen in *" ${st_line%%=*} "*) state_bad "repeated ${st_line%%=*}" ;; esac
    st_seen="$st_seen${st_line%%=*} "
    state_set "${st_line%%=*}" "${st_line#*=}"
  done <"$st_file"
}
write_state() {
  ws_tmp=$st_file.$(lc_random).tmp
  (
    set -C
    printf 'token=%s\npid=%s\nstartedAt=%s\nattempts=%s\nnextAt=%s\nstatus=%s\nboot=%s\nroot=%s\nuserDataDir=%s\nshared=%s\n' \
      "$st_token" "$st_pid" "$st_started" "$st_attempts" "$st_next" "$st_status" "$st_boot" "$st_root" "$st_user" "$st_shared" >"$ws_tmp"
  ) || die 73 'cannot write the state'
  mv -f -- "$ws_tmp" "$st_file" || die 73 'cannot replace the state'
}

# --- The pause statement ---------------------------------------------------------------------

# Succeeds, with the reason in pause_reason, when file $1 is exactly the paused.json of profile $2 that
# the extension writes (launcher-pause.ts): a small regular file, keys profileId, reason (disconnect,
# forget, or resumed), identity (form only, as in the ack), createdAt, in that order, no other byte.
read_pause_statement() {
  if [ ! -f "$1" ] || [ -L "$1" ]; then return 1; fi
  rp_size=$(wc -c <"$1" | tr -d ' ')
  [ "$rp_size" -le 4096 ] || return 1
  ack_value=
  ack_rest=$(cat -- "$1")
  [ "${#ack_rest}" -eq "$rp_size" ] || return 1
  ack_take '{"profileId":"' '"' || return 1
  [ "$ack_value" = "$2" ] || return 1
  ack_take '","reason":"' '"' || return 1
  case $ack_value in disconnect | forget | resumed) pause_reason=$ack_value ;; *) return 1 ;; esac
  ack_take '","identity":{"key":"' '"' || return 1
  is_base64url "$ack_value" 87 || return 1
  ack_take '","signedAt":' ',' || return 1
  is_time "$ack_value" || return 1
  ack_take ',"signature":"' '"' || return 1
  is_base64url "$ack_value" 86 || return 1
  ack_take '"},"createdAt":' '}' || return 1
  is_time "$ack_value" || return 1
  [ "$ack_rest" = '}' ]
}
# Succeeds, with pause_file and pause_reason set, when profile $2 states in namespace $1 below the
# Downloads root $3 that it left its peers on purpose. A resumed statement is not a pause.
pause_stated() {
  [ -n "$3" ] || return 1
  no_link_below "$3" "RECnRun/poc/$1/peers/$2/paused.json" || return 1
  pause_file=$3/RECnRun/poc/$1/peers/$2/paused.json
  read_pause_statement "$pause_file" "$2" || return 1
  [ "$pause_reason" != resumed ]
}
# The same in any namespace of the root, since resume is not given one.
pause_stated_anywhere() {
  for psa_dir in "$2"/RECnRun/poc/*; do
    psa_ns=${psa_dir##*/}
    is_namespace "$psa_ns" || continue
    pause_stated "$psa_ns" "$1" "$2" && return 0
  done
  return 1
}
