#!/bin/sh
# profiles.sh <command> [argument ...]
#
# The launcher's Chrome, user data roots, and profiles (POC PLAN.md P4.2), in POSIX sh with no
# JSON parser; nothing read from a file is ever run or expanded. Source it with
# RECNRUN_DISCOVERY_LIB=1 to get the functions without the command entry.
#
# Commands (also functions):
#   chrome_binary                                       the first Google Chrome that is executable
#   chrome_roots <record>                               the OS default user data root, then the record's
#   profiles_in_root <root>                             profile directory names, Default first, then sorted
#   extension_in_profile <root> <profileDirectory> <id> prints packed or unpacked, else exits 1
#   bind_profiles <record> <namespace> <id>             one line per profile that has the extension:
#                                                       <profileId> TAB <root> TAB <profileDirectory> TAB
#                                                       <downloadsRoot> TAB distinct|shared|unbound
#
# A directory name is never a display name. A binding names a Downloads root only when a presence
# sits there; a root two profiles reach (or that holds several presences) is shared, and its
# binding waits for the token ack. The bounded find of discovery.sh is not used here: without a
# token it would attribute any presence under $HOME to a profile.
#
# Environment: RECNRUN_DISCOVERY_PREFIX goes before every absolute path probed for Chrome and
# before each PATH entry (a fixture root for the checks); RECNRUN_DISCOVERY_UNAME overrides `uname -s`.
# Exit: 0 done, 1 extension_in_profile found nothing, 64 wrong call, 66 chrome_binary found none.

# Read before sourcing: `.` keeps the variable assignment of its own command line in some shells.
as_library=${RECNRUN_DISCOVERY_LIB:-}
# shellcheck source=discovery.sh
RECNRUN_DISCOVERY_LIB=1 . "$(dirname -- "$0")/discovery.sh"
RECNRUN_DISCOVERY_LIB=$as_library # a dot keeps its own assignment: give back what this script saw
nl='
'
tab=$(printf '\t')

log() { printf 'profiles.sh: %s\n' "$*" >&2; }

# Lowercase hex in every group: a fifth hyphen means a group holds one.
is_uuid() {
  case $1 in *[!0-9a-f-]* | *-*-*-*-*-*) return 1 ;; esac
  case $1 in ????????-????-????-????-????????????) return 0 ;; esac
  return 1
}
is_extension_id() {
  case $1 in *[!a-p]*) return 1 ;; esac
  [ "${#1}" -eq 32 ]
}
is_plain_file() { [ -f "$1" ] && [ ! -L "$1" ]; }
# An existing directory the tab-separated rows can carry.
is_listable() {
  is_directory "$1" || return 1
  case $1 in *"$tab"*) return 1 ;; esac
  [ -d "$1" ]
}
system_name() { printf '%s' "${RECNRUN_DISCOVERY_UNAME:-$(uname -s)}"; }
is_runnable() { [ -f "$1" ] && [ -x "$1" ]; }

# --- Chrome ----------------------------------------------------------------------------------

chrome_binary() {
  [ "$#" -eq 0 ] || return 64
  prefix=${RECNRUN_DISCOVERY_PREFIX:-}
  if [ "$(system_name)" = Darwin ]; then
    app='Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    for candidate in "$prefix/$app" "${HOME:-/nonexistent}/$app"; do
      if is_runnable "$candidate"; then printf '%s\n' "$candidate"; return 0; fi
    done
    return 66
  fi
  for name in google-chrome-stable google-chrome; do
    old_ifs=$IFS
    IFS=:
    for dir in $PATH; do
      case $dir in /*) ;; *) continue ;; esac
      if is_runnable "$prefix$dir/$name"; then
        printf '%s\n' "$prefix$dir/$name"
        IFS=$old_ifs
        return 0
      fi
    done
    IFS=$old_ifs
  done
  if is_runnable "$prefix/opt/google/chrome/chrome"; then
    printf '%s\n' "$prefix/opt/google/chrome/chrome"
    return 0
  fi
  return 66
}

# --- Roots -----------------------------------------------------------------------------------

default_root() {
  [ -n "${HOME:-}" ] || return 0
  if [ "$(system_name)" = Darwin ]; then
    printf '%s\n' "$HOME/Library/Application Support/Google/Chrome"
  else
    printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome"
  fi
}
record_user_data_dirs() {
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then return 0; fi
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in userDataDir=*) printf '%s\n' "${line#userDataDir=}" ;; esac
  done <"$1"
  return 0
}
chrome_roots() {
  [ "$#" -eq 1 ] || return 64
  seen=
  {
    default_root
    record_user_data_dirs "$1"
  } | while IFS= read -r root; do
    is_listable "$root" || continue
    case "$nl$seen" in *"$nl$root$nl"*) continue ;; esac
    seen=$seen$root$nl
    printf '%s\n' "$root"
  done
}

# --- Profiles --------------------------------------------------------------------------------

profiles_in_root() {
  [ "$#" -eq 1 ] || return 64
  is_listable "$1" || return 0
  names=
  for dir in "$1"/*/; do
    dir=${dir%/}
    name=${dir##*/}
    if [ ! -d "$dir" ] || [ -L "$dir" ]; then continue; fi
    is_profile_directory "$name" || continue
    case $name in 'System Profile' | 'Guest Profile') continue ;; esac
    is_plain_file "$dir/Preferences" || continue
    names=$names$name$nl
  done
  case $names in "Default$nl"* | *"$nl""Default$nl"*) printf 'Default\n' ;; esac
  printf '%s' "$names" | LC_ALL=C sort | while IFS= read -r name; do
    [ "$name" = Default ] || printf '%s\n' "$name"
  done
}
# Packed: a version folder with a manifest. Unpacked: the id is a key of a preferences file with
# content; Chrome leaves an empty entry (`"id":{}`) behind when the extension is uninstalled.
extension_in_profile() {
  [ "$#" -eq 3 ] || return 64
  is_directory "$1" && is_profile_directory "$2" && is_extension_id "$3" || return 64
  for manifest in "$1/$2/Extensions/$3"/*/manifest.json; do
    if is_plain_file "$manifest"; then printf 'packed\n'; return 0; fi
  done
  for file in "$1/$2/Preferences" "$1/$2/Secure Preferences"; do
    if is_plain_file "$file" && grep -q -e "\"$3\":{[^}]" "$file"; then
      printf 'unpacked\n'
      return 0
    fi
  done
  return 1
}

# --- Bindings --------------------------------------------------------------------------------

# Prints "<count> <first profileId>" of the presences below Downloads root $1.
presences_at() {
  count=0
  first=-
  if plain_path "$1" RECnRun poc "$2" peers; then
    for file in "$1/RECnRun/poc/$2/peers"/*/presence.json; do
      id=${file%/presence.json}
      if ! is_plain_file "$file" || [ -L "$id" ]; then continue; fi
      id=${id##*/}
      is_uuid "$id" || continue
      count=$((count + 1))
      [ "$first" != - ] || first=$id
    done
  fi
  printf '%s %s\n' "$count" "$first"
}
# "<count> <profileId> <downloadsRoot>" of the first Downloads root of the profile that holds a
# presence: its Preferences, the OS default, then the record's roots.
presence_root() {
  candidates=$(
    pref_download_dir "$1" "$2"
    os_default_download_dir
    record_roots "$3"
  )
  while IFS= read -r candidate; do
    is_listable "$candidate" || continue
    result=$(presences_at "$candidate" "$4")
    [ "${result%% *}" -gt 0 ] || continue
    printf '%s %s\n' "$result" "$candidate"
    return 0
  done <<ROOTS
$candidates
ROOTS
  return 1
}
# Rows "<root> TAB <profile> TAB <count> TAB <id> TAB <downloadsRoot>", "-" where nothing was found.
collect_rows() {
  rows=
  roots=$(chrome_roots "$1")
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    names=$(profiles_in_root "$root")
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      extension_in_profile "$root" "$name" "$3" >/dev/null || continue
      if found=$(presence_root "$root" "$name" "$1" "$2"); then
        count=${found%% *}
        rest=${found#* }
        found_id=${rest%% *}
        found_root=${rest#* }
      else
        count=0 found_id=- found_root=-
      fi
      rows=$rows$root$tab$name$tab$count$tab$found_id$tab$found_root$nl
    done <<PROFILES
$names
PROFILES
  done <<ROOTS
$roots
ROOTS
}
# How many rows end in Downloads root $1.
rows_reaching() {
  reached=0
  while IFS="$tab" read -r _ _ _ _ last; do
    [ "$last" != "$1" ] || reached=$((reached + 1))
  done <<ROWS
$rows
ROWS
  printf '%s\n' "$reached"
}
bind_profiles() {
  [ "$#" -eq 3 ] || return 64
  is_namespace "$2" && is_extension_id "$3" || return 64
  collect_rows "$1" "$2" "$3"
  while IFS="$tab" read -r root name count found_id found_root; do
    [ -n "$root" ] || continue
    if [ "$found_root" = - ]; then
      printf -- '-\t%s\t%s\t-\tunbound\n' "$root" "$name"
    elif [ "$count" -gt 1 ] || [ "$(rows_reaching "$found_root")" -gt 1 ]; then
      printf -- '-\t%s\t%s\t%s\tshared\n' "$root" "$name" "$found_root"
    else
      printf '%s\t%s\t%s\t%s\tdistinct\n' "$found_id" "$root" "$name" "$found_root"
    fi
  done <<ROWS
$rows
ROWS
}

if [ -z "$as_library" ]; then
  [ "$#" -ge 1 ] || { log 'usage: profiles.sh <command> [argument ...]'; exit 64; }
  entry=$1
  shift
  case $entry in
    chrome_binary | chrome_roots | profiles_in_root | extension_in_profile | bind_profiles)
      "$entry" "$@"
      status=$?
      [ "$status" -ne 64 ] || log "wrong arguments for $entry"
      exit "$status"
      ;;
    *) log "unknown command $entry"; exit 64 ;;
  esac
fi
