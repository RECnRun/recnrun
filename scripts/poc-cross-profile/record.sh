#!/bin/sh
# record.sh: the grammar of the launcher's record file (POC PLAN.md decision 11), sourced by
# catalog.sh. Keys userDataDir, profileDirectory, profileId, namespace, role (master, worker,
# template), masterFingerprint, downloadsRoot, root, one key=value per line, one record per block,
# blocks separated by a blank line. Directories are absolute, use only [A-Za-z0-9._:/ -], and
# have no .. segment; root is r plus 1 to 3 digits. Any byte other than printable ASCII or a
# newline, NUL included, refuses the whole record before anything is read.
#
# The caller defines record_refuse <message>, which must not return, and may define the hooks
# record_hook_line (a line kept, in $line), record_hook_blank, and record_hook_block <pass>
# (a closed, valid block: b_user, b_profile, b_id, b_ns, b_downloads, b_root, b_start).

# Lowercase hex in every group: a fifth hyphen means a group holds one.
is_uuid() {
  case $1 in *[!0-9a-f-]* | *-*-*-*-*-*) return 1 ;; esac
  case $1 in ????????-????-????-????-????????????) return 0 ;; esac
  return 1
}
is_v4() {
  is_uuid "$1" || return 1
  case $1 in ????????-????-4???-[89ab]???-????????????) return 0 ;; esac
  return 1
}
is_namespace() {
  case $1 in '' | *[!a-z0-9-]*) return 1 ;; esac
  [ "${#1}" -le 40 ]
}
is_record_directory() {
  case $1 in /*) ;; *) return 1 ;; esac
  case $1 in *[!A-Za-z0-9._:/\ -]*) return 1 ;; esac
  case /$1/ in */../*) return 1 ;; esac
  [ "${#1}" -le 1024 ]
}
is_profile_directory() {
  case $1 in '' | . | .. | *[!A-Za-z0-9._:\ -]*) return 1 ;; esac
  [ "${#1}" -le 255 ]
}
is_fingerprint() {
  case $1 in '' | *[!0-9A-F:]*) return 1 ;; esac
  [ "${#1}" -le 200 ]
}
is_root_id() {
  case $1 in r[0-9] | r[0-9][0-9] | r[0-9][0-9][0-9]) return 0 ;; esac
  return 1
}
# RegistrySchema's TimeSchema: a safe integer, so at most Number.MAX_SAFE_INTEGER.
is_time() {
  case $1 in '' | *[!0-9]* | 0?*) return 1 ;; esac
  [ "${#1}" -le 16 ] && [ "$1" -le 9007199254740991 ]
}
# An unpadded base64url string of exactly $2 characters.
is_base64url() {
  case $1 in *[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -eq "$2" ]
}

record_hook_line() { :; }
record_hook_blank() { :; }
record_hook_block() { :; }

# Sets record_text from file $1, or refuses; read once, so every pass sees the same record.
record_load() {
  if [ -f "$1" ] && [ "$(wc -c <"$1" | tr -d ' ')" -gt 65536 ]; then
    record_refuse 'the record file is over 64 KiB'
  fi
  # Command substitution drops NUL bytes, so tr marks every byte outside the format before the
  # shell holds any, and one mark refuses the whole record.
  mark=$(printf '\001')
  record_text=$(tr -c '\n -~' '\001' <"$1")
  [ "${#record_text}" -le 65536 ] || record_refuse 'the record file is over 64 KiB'
  case $record_text in *"$mark"*) record_refuse 'the record file holds a byte other than printable ASCII or a newline' ;; esac
}

record_reset() {
  b_user='' b_profile='' b_id='' b_ns='' b_downloads='' b_root='' b_seen=' ' b_start=0
}
bad_value() { record_refuse "record line $lineno: invalid $1"; }
set_key() {
  case $b_seen in *" $1 "*) record_refuse "record line $lineno: repeated key $1" ;; esac
  b_seen="$b_seen$1 "
  [ -n "$2" ] || record_refuse "record line $lineno: empty value for $1"
  case $1 in
    userDataDir) is_record_directory "$2" || bad_value "$1"; b_user=$2 ;;
    profileDirectory) is_profile_directory "$2" || bad_value "$1"; b_profile=$2 ;;
    profileId) is_uuid "$2" || bad_value "$1"; b_id=$2 ;;
    namespace) is_namespace "$2" || bad_value "$1"; b_ns=$2 ;;
    role) case $2 in master | worker | template) ;; *) bad_value "$1" ;; esac ;;
    masterFingerprint) is_fingerprint "$2" || bad_value "$1" ;;
    downloadsRoot) is_record_directory "$2" || bad_value "$1"; b_downloads=$2 ;;
    root) is_root_id "$2" || bad_value "$1"; b_root=$2 ;;
    *) record_refuse "record line $lineno: unknown key" ;;
  esac
}
# A closed block names a profile, a root, or both; the block hook of pass $1 sees only a valid one.
record_end_block() {
  [ "$b_start" -ne 0 ] || return 0
  where="record block at line $b_start"
  if { [ -z "$b_user" ] && [ -n "$b_profile" ]; } || { [ -n "$b_user" ] && [ -z "$b_profile" ]; }; then
    record_refuse "$where: userDataDir and profileDirectory go together"
  fi
  if [ -z "$b_user" ] && [ -z "$b_downloads" ]; then record_refuse "$where: names no profile or root"; fi
  if [ -n "$b_root" ] && [ -z "$b_downloads" ]; then record_refuse "$where: root without downloadsRoot"; fi
  if [ -n "$b_user" ] && [ -z "$b_id" ]; then record_refuse "$where: userDataDir without profileId"; fi
  if [ -n "$b_user" ] && [ -z "$b_ns" ]; then record_refuse "$where: userDataDir without namespace"; fi
  record_hook_block "$1"
}
# Walks record_text once for pass $1, which only the block hook reads.
record_parse() {
  record_reset
  lineno=0
  while IFS= read -r line; do
    lineno=$((lineno + 1))
    if [ -z "$line" ]; then
      record_end_block "$1"
      record_reset
      record_hook_blank
      continue
    fi
    [ "$b_start" -ne 0 ] || b_start=$lineno
    case $line in *=*) ;; *) record_refuse "record line $lineno: expected key=value" ;; esac
    set_key "${line%%=*}" "${line#*=}"
    record_hook_line
  done <<RECORD
$record_text
RECORD
  record_end_block "$1"
}
