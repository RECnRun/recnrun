#!/bin/sh
# clone-open.sh open-clone <clones-dir> <clone> <record> <namespace> [headed|headless]
#
# The first opening of a clone (POC PLAN.md P5.3, decisions 10, 11, and 13), over clone.sh. POSIX sh
# only, no JSON parser, nothing read from a file is ever run or expanded; positional arguments and one
# enumerated mode only. Source it with RECNRUN_DISCOVERY_LIB=1 for the functions.
#
# It reads <clones-dir>/<clone>/.recnrun-clone (a worker of the namespace, else 65), finds the one
# block of the record with role=master in the namespace and the identity key in the master's presence
# (<downloadsRoot>/RECnRun/poc/<ns>/peers/<profileId>/presence.json, else 66), and starts Chrome on the
# clone root with the bootstrap URL
#   chrome-extension://<extensionId>/bootstrap.html#clone=<token>&instance=<instanceId>&operation=<operationId>&namespace=<ns>&master=<masterProfileId>.<masterIdentityKey>
# Then it waits for acks/<instanceId>/<token>.json under a candidate Downloads root: the closed ack
# holds this token, instance, and operation, an identity, a boot, and "provisioned":true; any other is
# ignored. Only that ack registers the clone: one block (role=worker, downloadsRoot the root that
# acked) is appended to the record, and provisionedAt, operationId, and masterProfileId are appended
# to .recnrun-clone, which keeps its ten lines. stdout profileId=, operationId=, token=, boot=, root=;
# stderr pid=<n> at once. The Chrome it started is left running when no ack comes (69): the owner's
# lifecycle.sh stop ends it.
#
# A clone the record already registers is an ordinary reopen: open.sh open runs and its output and
# status are this script's. Environment: RECNRUN_OPEN_TIMEOUT_S (60) and RECNRUN_OPEN_POLL_S (1).
# Exit: 0 acked, 64 wrong call, 65 refused, 66 no Chrome or no master presence, 69 no ack in time,
# 70 the record or marker could not be written, 75 a process names the clone root.

co_as_library=${RECNRUN_DISCOVERY_LIB:-}
# shellcheck source=clone.sh
RECNRUN_DISCOVERY_LIB=1 . "$(dirname -- "$0")/clone.sh"
RECNRUN_DISCOVERY_LIB=$co_as_library # a dot keeps its own assignment: give back what this script saw

log() { printf 'clone-open.sh: %s\n' "$*" >&2; }

# --- The clone and the record ----------------------------------------------------------------

# Sets instance, mk_ns, mk_ext, and mk_prov (the marker holds the provisioning lines) from the marker
# of the clone, which read_clone_marker has just checked line by line, or refuses.
read_marker() {
  marker=$root/.recnrun-clone
  is_plain_file "$marker" || refuse "$root has no .recnrun-clone: it is not a clone"
  [ "$(wc -c <"$marker" | tr -d ' ')" -le 2048 ] || refuse "$marker is over 2 KiB"
  read_clone_marker "$marker" "$clone" || refuse "$marker is not in the clone grammar"
  mk_ns='' mk_ext='' mk_prov=''
  while IFS= read -r rm_line || [ -n "$rm_line" ]; do
    case $rm_line in
      namespace=*) mk_ns=${rm_line#*=} ;;
      extensionId=*) mk_ext=${rm_line#*=} ;;
      masterProfileId=*) mk_prov=1 ;;
    esac
  done <"$marker"
  [ "$mk_ns" = "$ns" ] || refuse "the clone belongs to namespace $mk_ns, not $ns"
  instance=$lc_id
}
# The role of the block being read; the block hook runs once the block is closed.
record_hook_line() {
  case $line in role=*) oc_role=${line#role=} ;; esac
}
record_hook_block() {
  oc_block_role=$oc_role oc_role=
  [ "$b_ns" = "$ns" ] || return 0
  if [ "$oc_block_role" = master ]; then
    oc_masters=$((oc_masters + 1))
    oc_master_id=$b_id oc_master_downloads=$b_downloads
  fi
  if [ "$b_id" = "$instance" ] && [ -z "$oc_registered" ]; then oc_registered=1 oc_reg_user=$b_user; fi
}
scan_record() {
  oc_role='' oc_masters=0 oc_master_id='' oc_master_downloads='' oc_registered='' oc_reg_user=''
  if [ ! -f "$record" ] || [ ! -r "$record" ]; then refuse 'the record is not a readable file'; fi
  record_load "$record"
  record_parse 1
}
no_master_presence() {
  log "master presence not found: $1"
  exit 66
}
# Sets master_key from the presence of the one master of the record, or exits 66.
find_master() {
  [ "$oc_masters" -eq 1 ] || refuse "the record holds $oc_masters blocks with role=master in namespace $ns, not one"
  is_v4 "$oc_master_id" || refuse 'the master block has no lowercase v4 profileId'
  [ -n "$oc_master_downloads" ] || no_master_presence 'the master block has no downloadsRoot'
  fm_file=$oc_master_downloads/RECnRun/poc/$ns/peers/$oc_master_id/presence.json
  plain_path "$oc_master_downloads" RECnRun poc "$ns" peers "$oc_master_id" || no_master_presence "no plain folder below $oc_master_downloads"
  is_plain_file "$fm_file" || no_master_presence "$fm_file is not a plain file"
  fm_size=$(wc -c <"$fm_file" | tr -d ' ')
  [ "$fm_size" -le 4096 ] || no_master_presence "$fm_file is over 4096 bytes"
  fm_text=$(cat -- "$fm_file")
  [ "${#fm_text}" -eq "$fm_size" ] || no_master_presence "$fm_file holds a NUL byte"
  case $fm_text in *'"identity":{"key":"'*) ;; *) no_master_presence "$fm_file has no identity key" ;; esac
  fm_rest=${fm_text#*'"identity":{"key":"'}
  master_key=${fm_rest%%\"*}
  is_base64url "$master_key" 87 || no_master_presence "$fm_file holds an identity key that is not 87 base64url characters"
}

# --- The ack ---------------------------------------------------------------------------------

# Prints the boot of the clone ack $1 when it is a small plain file that holds, as plain substrings of
# the fixed grammar, this token, instance, and operation, an identity, and "provisioned":true.
read_clone_ack() {
  if [ ! -f "$1" ] || [ -L "$1" ]; then return 1; fi
  size=$(wc -c <"$1" | tr -d ' ')
  [ "$size" -le 4096 ] || return 1
  rca_text=$(cat -- "$1")
  [ "${#rca_text}" -eq "$size" ] || return 1
  for rca_part in "\"token\":\"$token\"" "\"profileId\":\"$instance\"" '"identity":{' \
    "\"instanceId\":\"$instance\"" "\"operationId\":\"$operation\"" '"provisioned":true'; do
    case $rca_text in *"$rca_part"*) ;; *) return 1 ;; esac
  done
  case $rca_text in *'"boot":"'*) ;; *) return 1 ;; esac
  rca_rest=${rca_text#*'"boot":"'}
  rca_boot=${rca_rest%%\"*}
  is_uuid "$rca_boot" || return 1
  printf '%s\n' "$rca_boot"
}
# One look under every candidate Downloads root, the clone's pinned one first; sets acked_root and
# acked_boot, else leaves the roots tried in $tried. $1 is the record, $2 the namespace.
look_for_clone_ack() {
  candidates=$(downloads_root_candidates "$root" Default "$1" "$2")
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    folder=$candidate/RECnRun/poc/$2/acks/$instance
    if plain_path "$candidate" RECnRun poc "$2" acks "$instance" && found_boot=$(read_clone_ack "$folder/$token.json"); then
      acked_root=$candidate acked_boot=$found_boot
      return 0
    fi
    tried="$tried${tried:+, }$candidate"
  done <<EOF
$candidates
EOF
  return 1
}

# --- The opening -----------------------------------------------------------------------------

# Chrome runs in the background with separate words; every value in them was checked above.
start_clone() {
  finder=chrome_binary # by name: ShellCheck would read a bare call as a forgotten "$@"
  chrome=$("$finder") || { log 'no Google Chrome found'; exit 66; }
  unpacked_code_present "$root" Default "$mk_ext" || exit $?
  token=$(new_token)
  operation=$(new_instance_id) || die 70 'no native source of a v4 uuid (uuidgen or /proc)'
  url="chrome-extension://$mk_ext/bootstrap.html#clone=$token&instance=$instance&operation=$operation&namespace=$ns&master=$oc_master_id.$master_key"
  set -- "--user-data-dir=$root" --profile-directory=Default --no-first-run --no-default-browser-check "$url"
  [ "$mode" != headless ] || set -- --headless=new "$@"
  "$chrome" "$@" >/dev/null 2>&1 &
  log "pid=$!"
}
# The same append path as first-run.sh: a blank line between blocks, nothing rewritten.
register_clone() {
  is_record_directory "$acked_root" || die 70 "the Downloads root $acked_root cannot be held by the record"
  rc_gap=''
  if [ -s "$record" ]; then
    rc_gap=$nl
    [ -z "$(tail -c 1 "$record")" ] || rc_gap=$nl$nl
  fi
  {
    printf '%s' "$rc_gap"
    printf 'userDataDir=%s\nprofileDirectory=Default\nprofileId=%s\nnamespace=%s\nrole=worker\ndownloadsRoot=%s\n' \
      "$root" "$instance" "$ns" "$acked_root"
  } >>"$record" || die 70 "cannot write $record"
  printf 'provisionedAt=%s\noperationId=%s\nmasterProfileId=%s\n' "$(date +%s)" "$operation" "$oc_master_id" \
    >>"$marker" || die 70 "the clone is registered but $marker could not be written"
}
reopen_registered() {
  [ "$oc_reg_user" = "$root" ] || refuse "the record registers $instance for another root than $root"
  log "$instance is registered: reopening"
  RECNRUN_DISCOVERY_LIB='' /bin/sh "$here/open.sh" open "$record" "$ns" "$instance" "$mode"
  oc_code=$?
  exit "$oc_code"
}
open_clone() {
  [ "$#" -ge 4 ] || die 64 'usage: clone-open.sh open-clone <clones-dir> <clone> <record> <namespace> [headed|headless]'
  [ "$#" -le 5 ] || refuse 'a free argument: the request is the clones directory, clone, record, namespace, and mode'
  mode=headed
  [ "$#" -lt 5 ] || mode=$5
  case $mode in headed | headless) ;; *) refuse 'the mode is neither headed nor headless' ;; esac
  check_timing
  clones=$1 clone=$2 record=$3 ns=$4
  is_namespace "$ns" || refuse 'the namespace is not a namespace'
  check_clones_dir "$clones"
  is_clone_name "$clone" || refuse 'the clone name is not [A-Za-z0-9][A-Za-z0-9-]{0,31}'
  root=$clones/$clone
  if [ ! -d "$root" ] || [ -L "$root" ]; then refuse "$root is not a plain existing directory"; fi
  ! is_base_root "$root" || refuse "$root is a frozen base, not a clone"
  read_marker
  scan_record
  [ -z "$oc_registered" ] || reopen_registered
  [ -z "$mk_prov" ] || refuse "$marker says provisioned but the record does not register $instance"
  holders_of "$root"
  [ -z "$holders" ] || die 75 "a process names the clone root: pids $holders; close it first"
  find_master
  start_clone
  looker=look_for_clone_ack
  if ! wait_for_ack "$record" "$ns"; then
    log "no ack for $token within $limit s: tried ${tried:-no candidate}"
    exit 69
  fi
  register_clone
  printf 'profileId=%s\noperationId=%s\ntoken=%s\nboot=%s\nroot=%s\n' "$instance" "$operation" "$token" "$acked_boot" "$acked_root"
}

if [ -z "$co_as_library" ]; then
  [ "$#" -ge 1 ] || die 64 'usage: clone-open.sh open-clone <clones-dir> <clone> <record> <namespace> [headed|headless]'
  entry=$1
  shift
  case $entry in
    open-clone) open_clone "$@" ;;
    *) die 64 "unknown command $entry" ;;
  esac
fi
