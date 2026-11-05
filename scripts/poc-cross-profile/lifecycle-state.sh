#!/bin/sh
# Locks and state files of lifecycle.sh (POC PLAN.md P4.4): the hard-link pid lock and the
# key=value state grammar. Sourced by lifecycle.sh, which also provides log, die, and open.sh's
# is_v4, is_uuid, and is_directory.

is_count() {
  case $1 in '' | *[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 16 ]
}
pid_alive() {
  is_count "$1" || return 1
  kill -0 "$1" 2>/dev/null || return 1
  case $(ps -o stat= -p "$1" 2>/dev/null) in Z*) return 1 ;; esac
  return 0
}
lc_random() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }
setting() {
  s_value=${1:-$2}
  is_count "$s_value" || die 64 "$3 must be whole seconds"
  printf '%s\n' "$s_value"
}

# Hard link of a file naming the holder: atomic, and a signal cannot orphan a lock that names no one.
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
    is_count "$lk_pid" || { rm -f -- "$lk_mine"; die 65 "$1 does not name a pid"; }
    if pid_alive "$lk_pid"; then
      rm -f -- "$lk_mine"
      die 75 "another launcher holds $1 (pid $lk_pid)"
    fi
    # A rival that took over in between would lose its lock to this rm; the window is two commands wide.
    lk_again=
    read -r lk_again <"$1" 2>/dev/null || :
    if [ "$lk_again" = "$lk_pid" ]; then rm -f -- "$1"; fi
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
state_dir() {
  if ! is_directory "$1" || [ ! -d "$1" ]; then die 64 'the state directory is not an existing absolute directory'; fi
  mkdir -p -- "$1/profiles"
}

state_defaults() {
  st_token='' st_pid='' st_started=0 st_attempts=0 st_next=0 st_status=none st_boot='' st_root='' st_user=''
}
state_bad() { die 65 "state file $st_file: invalid $1"; }
# Each key has its own grammar; a free value is refused before the shell uses it.
state_set() {
  case $1 in
    token) [ -z "$2" ] || is_v4 "$2" || state_bad "$1"; st_token=$2 ;;
    pid) [ -z "$2" ] || is_count "$2" || state_bad "$1"; st_pid=$2 ;;
    startedAt) is_count "$2" || state_bad "$1"; st_started=$2 ;;
    attempts) is_count "$2" || state_bad "$1"; st_attempts=$2 ;;
    nextAt) is_count "$2" || state_bad "$1"; st_next=$2 ;;
    status) case $2 in idle | opening | open | failed | paused | stopped) st_status=$2 ;; *) state_bad "$1" ;; esac ;;
    boot) [ -z "$2" ] || is_uuid "$2" || state_bad "$1"; st_boot=$2 ;;
    root) [ -z "$2" ] || is_directory "$2" || state_bad "$1"; st_root=$2 ;;
    userDataDir) [ -z "$2" ] || is_directory "$2" || state_bad "$1"; st_user=$2 ;;
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
    printf 'token=%s\npid=%s\nstartedAt=%s\nattempts=%s\nnextAt=%s\nstatus=%s\nboot=%s\nroot=%s\nuserDataDir=%s\n' \
      "$st_token" "$st_pid" "$st_started" "$st_attempts" "$st_next" "$st_status" "$st_boot" "$st_root" "$st_user" >"$ws_tmp"
  ) || die 73 'cannot write the state'
  mv -f -- "$ws_tmp" "$st_file" || die 73 'cannot replace the state'
}
