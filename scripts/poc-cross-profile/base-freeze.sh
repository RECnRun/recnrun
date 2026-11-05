#!/bin/sh
# The freeze of base.sh (POC PLAN.md P5.1): sourced by base.sh, which provides log, die, refuse,
# check_existing_root, holders_of, and open.sh's read_ack and is_v4.

# Sets ack_profile to the profile id of a template ack for setting $3 in namespace $2 below the
# Downloads root of the base in $1, or leaves it empty.
find_template_ack() {
  ack_profile=
  fta_candidates=$(downloads_root_candidates "$1" Default '' "$2")
  while IFS= read -r fta_root; do
    [ -n "$fta_root" ] || continue
    plain_path "$fta_root" RECnRun poc "$2" acks || continue
    for fta_folder in "$fta_root/RECnRun/poc/$2/acks"/*/; do
      fta_folder=${fta_folder%/}
      fta_id=${fta_folder##*/}
      is_v4 "$fta_id" || continue
      plain_path "$fta_root" RECnRun poc "$2" acks "$fta_id" || continue
      for fta_file in "$fta_folder"/*.json; do
        fta_token=${fta_file##*/}
        fta_token=${fta_token%.json}
        is_v4 "$fta_token" || continue
        if read_ack "$fta_file" "$fta_token" "$fta_id" "$3" >/dev/null; then
          ack_profile=$fta_id
          return 0
        fi
      done
    done
  done <<FTA
$fta_candidates
FTA
  return 0
}
# The setting= value of the marker file $1, or refuses a marker that is no plain small file.
marker_setting() {
  is_plain_file "$1" || refuse "$1 is not a plain file"
  [ "$(wc -c <"$1" | tr -d ' ')" -le 2048 ] || refuse "$1 is over 2 KiB"
  ms_value=
  while IFS= read -r ms_line || [ -n "$ms_line" ]; do
    case $ms_line in setting=*) ms_value=${ms_line#setting=} ;; esac
  done <"$1"
  printf '%s\n' "$ms_value"
}
freeze_base() {
  [ "$#" -eq 4 ] || die 64 'usage: base.sh freeze <bases-dir> <name> <namespace> <extensionId>'
  check_existing_root "$1" "$2"
  fz_root=$1/$2 fz_name=$2
  is_namespace "$3" || refuse 'the namespace is not a namespace'
  is_extension_id "$4" || refuse 'the extension id is not 32 letters a to p'
  marker=$fz_root/.recnrun-base
  if [ -e "$marker" ] || [ -L "$marker" ]; then
    [ "$(marker_setting "$marker")" = "$fz_name" ] || refuse "$marker holds another setting than $fz_name"
    cat -- "$marker"
    return 0
  fi
  holders_of "$fz_root"
  [ -z "$holders" ] || die 75 "a process holds the root: pids $holders"
  is_plain_file "$fz_root/Default/Preferences" || refuse "$fz_root/Default/Preferences is missing"
  install=$(extension_in_profile "$fz_root" Default "$4") || refuse "extension $4 is not installed in $fz_root/Default"
  find_template_ack "$fz_root" "$3" "$fz_name"
  [ -n "$ack_profile" ] || refuse "no template ack of $fz_name below the Downloads root of $fz_root"
  (
    set -C
    printf 'setting=%s\nextensionId=%s\nprofileId=%s\nnamespace=%s\nfrozenAt=%s\ninstall=%s\n' \
      "$fz_name" "$4" "$ack_profile" "$3" "$(date +%s)" "$install" >"$marker"
  ) || die 73 "cannot write $marker"
  cat -- "$marker"
}
