#!/bin/sh
# The update of base.sh (POC PLAN.md P5.6, CL14): sourced by base.sh, which provides log, die, refuse,
# check_existing_root, is_plain_root, is_base_name, holders_of, open_setup_pages, marker_setting, and
# the helpers of profiles.sh and discovery.sh. The copy follows clone.sh's transaction (a partial
# beside the destination, diff -r, one rename) on its own, so the two scripts stay independent.

up_fail() { die 70 "$1: interrupted copy kept at $up_temp"; }
# A link in the copy is never followed: the copy is removed (rm does not follow links) and the update fails.
up_discard() {
  rm -rf -- "$up_temp"
  die 70 "$1: the copy was removed"
}
# The namespace= value of the freeze marker $1, empty when it has none.
marker_namespace() {
  mn_value=
  while IFS= read -r mn_line || [ -n "$mn_line" ]; do
    case $mn_line in namespace=*) mn_value=${mn_line#namespace=} ;; esac
  done <"$1"
  printf '%s\n' "$mn_value"
}
up_count() { grep -o -F -e "$2" "$1" | wc -l | tr -d ' '; }
# The one download.default_directory of the copy moves from the old root to the new one.
up_rewrite() {
  ur_file=$up_temp/Default/Preferences
  is_plain_file "$ur_file" || up_fail 'the copy has no Default/Preferences'
  ur_old="\"default_directory\":\"$root/downloads\""
  ur_new="\"default_directory\":\"$up_dest/downloads\""
  if [ "$(up_count "$ur_file" "$root")" != 1 ] || [ "$(up_count "$ur_file" "$ur_old")" != 1 ]; then
    up_fail 'the old root does not occur exactly once, as the Downloads root, in Preferences'
  fi
  ur_text=$(
    sed "s|$ur_old|$ur_new|" "$ur_file"
    printf x
  )
  ur_text=${ur_text%x}
  if [ -n "$(tail -c 1 "$ur_file")" ]; then ur_text=${ur_text%"$nl"}; fi # a sed that adds a final newline
  printf '%s' "$ur_text" >"$ur_file" || up_fail 'cannot rewrite Preferences'
  if [ "$(up_count "$ur_file" "$ur_new")" != 1 ] || [ "$(up_count "$ur_file" "$ur_old")" != 0 ]; then
    up_fail 'Preferences is not the old one with only its Downloads root changed'
  fi
}
up_copy() {
  up_temp=$bases/.$up_to.partial-$(lc_random)
  if [ -e "$up_temp" ] || [ -L "$up_temp" ]; then die 73 "$up_temp exists"; fi
  refuse_stray_links "$root" refuse
  up_start=$(date +%s)
  if command -v ditto >/dev/null 2>&1; then ditto "$root" "$up_temp" || up_fail 'the copy failed'; else cp -R -p "$root" "$up_temp" || up_fail 'the copy failed'; fi
  up_secs=$(($(date +%s) - up_start))
  up_diff=$(diff -r -q -x SingletonLock -x SingletonCookie -x SingletonSocket "$root" "$up_temp" 2>&1)
  [ -z "$up_diff" ] || up_fail "the copy differs from the base ($(printf '%s' "$up_diff" | head -n 1))"
  refuse_stray_links "$up_temp" up_discard
  rm -f -- "$up_temp/SingletonLock" "$up_temp/SingletonCookie" "$up_temp/SingletonSocket" "$up_temp/.recnrun-base"
  rm -rf -- "$up_temp/downloads/RECnRun"
  up_rewrite
}
update_base() {
  [ "$#" -eq 4 ] || die 64 'usage: base.sh update <bases-dir> <from> <to> <namespace>'
  check_existing_root "$1" "$2"
  bases=$1 up_to=$3 up_dest=$1/$3 up_from=$2
  is_base_name "$3" || refuse 'the new name is not base-v<number>'
  case $up_dest in *[!A-Za-z0-9._/-]*) refuse 'the new root path has a character other than letters, digits, dot, underscore, hyphen, and slash' ;; esac
  is_namespace "$4" || refuse 'the namespace is not a namespace'
  [ "$(marker_setting "$root/.recnrun-base" 2>/dev/null)" = "$up_from" ] || refuse "$root is not a frozen base of its own setting"
  [ "$(marker_namespace "$root/.recnrun-base")" = "$4" ] || refuse "the base is frozen for another namespace than $4"
  holders_of "$root"
  [ -z "$holders" ] || refuse "a process names $root: pids $holders; close it first"
  if [ -e "$up_dest" ] || [ -L "$up_dest" ]; then refuse "$up_dest exists"; fi
  finder=chrome_binary
  chrome=$("$finder") || die 66 'no Google Chrome found'
  up_copy
  if [ -e "$up_dest" ] || [ -L "$up_dest" ]; then up_fail "$up_dest appeared meanwhile"; fi
  mv -- "$up_temp" "$up_dest" || up_fail "cannot publish $up_dest"
  root=$up_dest
  open_setup_pages "$chrome"
  printf 'root=%s\ncopyS=%s\n' "$up_dest" "$up_secs"
}
