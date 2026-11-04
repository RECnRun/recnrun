#!/bin/sh
# discovery.sh <command> [argument ...]
#
# The launcher's Downloads-root chain (POC PLAN.md P4.2): where a profile's Downloads root may be,
# each candidate verified only by the presence that carries the attempt token. POSIX sh only, no
# JSON parser, nothing read from a file is ever run or expanded. Source it with
# RECNRUN_DISCOVERY_LIB=1 to get the functions without the command entry.
#
# Commands (also functions):
#   pref_download_dir <root> <profileDirectory>   download.default_directory of that Preferences
#   os_default_download_dir                       the OS default Downloads folder
#   record_roots <record>                         the downloadsRoot paths a launcher record names
#   find_presences <home> <namespace>             roots under <home> that hold a presence
#   downloads_root_candidates <root> <profileDirectory> <record> <namespace>
#   profile_downloads_root <root> <profileDirectory> <record> <namespace> <token>
#
# Environment: RECNRUN_DISCOVERY_NO_PLUTIL=1 forces the sed reader of Preferences;
# RECNRUN_DISCOVERY_UNAME overrides `uname -s`.
#
# A wrong read of Preferences only ever prints nothing (Chrome's default), never another path.
# Exit: 0 done, 64 wrong call, 66 no candidate holds the token (stderr lists every candidate tried).

nl='
'

log() { printf 'discovery.sh: %s\n' "$*" >&2; }

is_namespace() {
  case $1 in '' | *[!a-z0-9-]*) return 1 ;; esac
  [ "${#1}" -le 40 ]
}
is_directory() {
  case $1 in /*) ;; *) return 1 ;; esac
  case $1 in *"$nl"*) return 1 ;; esac
  case /$1/ in */../*) return 1 ;; esac
  [ "${#1}" -le 1024 ]
}
is_profile_directory() {
  case $1 in '' | . | .. | *[!A-Za-z0-9._:\ -]*) return 1 ;; esac
  [ "${#1}" -le 255 ]
}
is_token() {
  case $1 in '' | *[!0-9a-f-]*) return 1 ;; esac
  [ "${#1}" -eq 36 ]
}

# --- Step 1: Preferences ---------------------------------------------------------------------

# Prints the UTF-8 bytes of code point $1, a BMP value outside controls and surrogates.
emit_code_point() {
  if [ "$1" -lt 128 ]; then
    printf '%b' "$(printf '\\0%03o' "$1")"
  elif [ "$1" -lt 2048 ]; then
    printf '%b' "$(printf '\\0%03o\\0%03o' $((192 + $1 / 64)) $((128 + $1 % 64)))"
  else
    printf '%b' "$(printf '\\0%03o\\0%03o\\0%03o' $((224 + $1 / 4096)) $((128 + $1 / 64 % 64)) $((128 + $1 % 64)))"
  fi
}
# Prints $1 with its \uXXXX sequences decoded; any bad one prints nothing.
unescape_units() {
  u_rest=$1
  u_out=
  while :; do
    case $u_rest in *'\u'*) ;; *) break ;; esac
    u_out=$u_out${u_rest%%'\u'*}
    u_rest=${u_rest#*'\u'}
    u_hex=$(printf '%.4s' "$u_rest")
    case $u_hex in *[!0-9A-Fa-f]*) return 0 ;; esac
    [ "${#u_hex}" -eq 4 ] || return 0
    u_rest=${u_rest#????}
    u_cp=$((0x$u_hex))
    if [ "$u_cp" -lt 32 ] || { [ "$u_cp" -ge 55296 ] && [ "$u_cp" -le 57343 ]; }; then return 0; fi
    u_out=$u_out$(emit_code_point "$u_cp"; printf x)
    u_out=${u_out%x}
  done
  printf '%s' "$u_out$u_rest"
}
# The escaped string of download.default_directory; only the "download" object matches, which
# keeps savefile.default_directory out. Chrome writes one compact line (JSONWriter, no pretty print).
sed_download_dir() {
  LC_ALL=C sed -n -E 's/^.*[{,]"download":\{([^{}]*,)?"default_directory":"(([^"\\]|\\.)*)".*$/\2/p' "$1"
}
# The sed reader: the value unescaped (\\ first, parked on a control byte JSON never carries raw).
read_with_sed() {
  raw=$(sed_download_dir "$1") || return 0
  [ -n "$raw" ] || return 0
  mark=$(printf '\001')
  case $raw in *"$mark"*) return 0 ;; esac
  step=$(printf '%s' "$raw" | LC_ALL=C sed -e "s/\\\\\\\\/$mark/g" -e 's/\\"/"/g' -e 's/\\\//\//g')
  step=$(unescape_units "$step") || return 0
  # Any backslash left is an escape this reader does not decode.
  case $step in *\\*) return 0 ;; esac
  printf '%s' "$step" | tr '\001' "\\\\"
}
pref_download_dir() {
  [ "$#" -eq 2 ] || return 64
  if ! is_directory "$1" || ! is_profile_directory "$2"; then return 0; fi
  file=$1/$2/Preferences
  if [ ! -f "$file" ] || [ -L "$file" ]; then return 0; fi
  if [ -z "${RECNRUN_DISCOVERY_NO_PLUTIL:-}" ] && command -v plutil >/dev/null 2>&1; then
    value=$(plutil -extract download.default_directory raw -o - "$file" 2>/dev/null) || value=
  else
    value=$(read_with_sed "$file")
  fi
  # A relative or odd value is a bad read, and a bad read yields nothing.
  is_directory "$value" || return 0
  printf '%s\n' "$value"
}

# --- Step 2: the OS default ------------------------------------------------------------------

os_default_download_dir() {
  [ -n "${HOME:-}" ] || return 0
  system=${RECNRUN_DISCOVERY_UNAME:-$(uname -s)}
  if [ "$system" = Linux ]; then
    if command -v xdg-user-dir >/dev/null 2>&1; then
      value=$(xdg-user-dir DOWNLOAD 2>/dev/null) || value=
      if is_directory "$value"; then printf '%s\n' "$value"; return 0; fi
    fi
    dirs=${XDG_CONFIG_HOME:-$HOME/.config}/user-dirs.dirs
    if [ -f "$dirs" ]; then
      value=$(sed -n 's/^XDG_DOWNLOAD_DIR=//p' "$dirs" | tail -n 1)
      value=${value#\"}
      value=${value%\"}
      case $value in
        "\$HOME"/*) value=$HOME/${value#"\$HOME"/} ;;
        "\${HOME}"/*) value=$HOME/${value#"\${HOME}"/} ;;
      esac
      if is_directory "$value"; then printf '%s\n' "$value"; return 0; fi
    fi
  fi
  printf '%s\n' "$HOME/Downloads"
}

# --- Steps 3 and 4: the record and a bounded find --------------------------------------------

record_roots() {
  [ "$#" -eq 1 ] || return 64
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then return 0; fi
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      downloadsRoot=*) if is_directory "${line#downloadsRoot=}"; then printf '%s\n' "${line#downloadsRoot=}"; fi ;;
    esac
  done <"$1"
  return 0
}
# A presence sits six folders below its Downloads root and the file at most ten below home.
find_presences() {
  [ "$#" -eq 2 ] || return 64
  is_namespace "$2" || return 64
  [ -d "$1" ] || return 0
  suffix=/RECnRun/poc/$2/peers
  (
    cd "$1" 2>/dev/null || exit 0
    base=$(pwd)
    find . -maxdepth 10 \( -name '.*' ! -name . \) -prune -o -type f -name presence.json \
      -path "*$suffix/*/presence.json" -print 2>/dev/null |
      while IFS= read -r hit; do
        hit=${hit#.}
        hit=${hit%"$suffix"/*/presence.json}
        printf '%s\n' "$base$hit"
      done
  )
}

# --- The chain -------------------------------------------------------------------------------

downloads_root_candidates() {
  [ "$#" -eq 4 ] || return 64
  seen=
  {
    pref_download_dir "$1" "$2"
    os_default_download_dir
    record_roots "$3"
    find_presences "${HOME:-/nonexistent}" "$4"
  } | while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    case "$nl$seen" in *"$nl$candidate$nl"*) continue ;; esac
    seen=$seen$candidate$nl
    printf '%s\n' "$candidate"
  done
}
# True when a presence under $1 ends in the boot $3, the way the extension writes it.
holds_token() {
  for file in "$1/RECnRun/poc/$2/peers"/*/presence.json; do
    if [ ! -f "$file" ] || [ -L "$file" ]; then continue; fi
    [ "$(wc -c <"$file" | tr -d ' ')" -le 2048 ] || continue
    text=$(cat -- "$file")
    case $text in *',"boot":"'"$3"'"}') return 0 ;; esac
  done
  return 1
}
profile_downloads_root() {
  [ "$#" -eq 5 ] || return 64
  if ! is_namespace "$4" || ! is_token "$5"; then return 64; fi
  tried=
  candidates=$(downloads_root_candidates "$1" "$2" "$3" "$4")
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if holds_token "$candidate" "$4" "$5"; then printf '%s\n' "$candidate"; return 0; fi
    tried="$tried${tried:+, }$candidate"
  done <<EOF
$candidates
EOF
  log "not found: tried ${tried:-no candidate}"
  return 66
}

if [ -z "${RECNRUN_DISCOVERY_LIB:-}" ]; then
  [ "$#" -ge 1 ] || { log 'usage: discovery.sh <command> [argument ...]'; exit 64; }
  entry=$1
  shift
  case $entry in
    pref_download_dir | os_default_download_dir | record_roots | find_presences | \
      downloads_root_candidates | profile_downloads_root)
      "$entry" "$@"
      status=$?
      [ "$status" -ne 64 ] || log "wrong arguments for $entry"
      exit "$status"
      ;;
    *) log "unknown command $entry"; exit 64 ;;
  esac
fi
