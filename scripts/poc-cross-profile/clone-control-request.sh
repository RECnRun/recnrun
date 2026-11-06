#!/bin/sh
# The request of clone-control.sh (POC PLAN.md P7.5): its closed grammar, its age, its file, and the clone
# it names. Sourced by clone-control.sh, which provides the roster (cc_*), log, and the ack_* parser.

# shellcheck disable=SC2034 # the settings and results are read by clone-control.sh
# Set by clone-control.sh before these run; named here so ShellCheck sees them.
ns='' cc_master_id='' cc_master_root='' cc_control='' cc_fresh_ms='' cc_ahead_ms='' cc_workers='' cc_ids='' cc_nl='' lc_id=''
ack_value='' ack_rest='' rq_why='' rq_action='' rq_instance='' rq_created='' cc_root='' cc_name=''

# --- The request -------------------------------------------------------------------------------

# Sets rq_* from the request file $1 of request $2, else rq_why and failure.
parse_request() {
  rq_why='the request is not in the closed grammar'
  ack_rest=$(cat -- "$1")
  ack_take '{"requestId":"' '"' && [ "$ack_value" = "$2" ] || return 1
  ack_take '","kind":"clone-control","action":"' '"' || return 1
  case $ack_value in
    close | open-headless | open-visible | reopen-headless | reopen-visible) rq_action=$ack_value ;;
    *) rq_why='the action is not one of close, open-headless, open-visible, reopen-headless, reopen-visible'; return 1 ;;
  esac
  ack_take '","instanceId":"' '"' && is_v4 "$ack_value" || return 1
  rq_instance=$ack_value
  ack_take '","namespace":"' '"' && [ "$ack_value" = "$ns" ] || return 1
  ack_take '","masterProfileId":"' '"' && [ "$ack_value" = "$cc_master_id" ] || return 1
  ack_take '","masterIdentity":{"key":"' '"' && is_base64url "$ack_value" 87 || return 1
  ack_take '","signedAt":' ',' && is_time "$ack_value" || return 1
  ack_take ',"signature":"' '"' && is_base64url "$ack_value" 86 || return 1
  ack_take '"},"createdAt":' '}' && is_time "$ack_value" || return 1
  rq_created=$ack_value
  [ "$ack_rest" = '}' ]
}
# Fails when createdAt is older than ten minutes or more than 5 s ahead of this clock.
check_fresh() {
  cf_now="$(date +%s)000"
  [ "$rq_created" -ge $((cf_now - cc_fresh_ms)) ] && [ "$rq_created" -le $((cf_now + cc_ahead_ms)) ] && return 0
  rq_why='the request is older than 10 minutes or from the future'
  return 1
}
# Succeeds when the request of $1 is a plain small file in a plain folder without a NUL byte.
request_file_ok() {
  no_link_below "$cc_master_root" "RECnRun/poc/$ns/control/$1/request.json" || return 1
  rf_file=$cc_control/$1/request.json
  [ -f "$rf_file" ] && [ ! -L "$rf_file" ] || return 1
  rf_size=$(wc -c <"$rf_file" | tr -d ' ')
  [ "$rf_size" -le 4096 ] || return 1
  rf_text=$(cat -- "$rf_file")
  [ "${#rf_text}" -eq "$rf_size" ]
}

# --- The clone ---------------------------------------------------------------------------------

# Sets cc_root and cc_name to the clone of instance $1 the record registers, when its root is a plain
# clone under a folder named clones whose marker belongs to that instance and this namespace.
eligible_clone() {
  cc_root='' ec_count=0
  while IFS= read -r ec_line; do
    [ "$ec_line" != "$1" ] || ec_count=$((ec_count + 1))
  done <<IDS
$cc_ids
IDS
  [ "$ec_count" -le 1 ] || { rq_why='the record names that profile in more than one block'; return 1; }
  while IFS= read -r ec_line; do
    [ "${ec_line%%=*}" = "$1" ] || continue
    cc_root=${ec_line#*=}
  done <<WORKERS
$cc_workers
WORKERS
  [ -n "$cc_root" ] || { rq_why='that profile is not the Default profile of a worker clone of the record'; return 1; }
  cc_name=${cc_root##*/}
  ec_parent=${cc_root%/*}
  case $cc_name in '' | .* | *[!A-Za-z0-9_-]*) rq_why="$cc_root is not a published clone root"; return 1 ;; esac
  [ "${ec_parent##*/}" = clones ] || { rq_why="$cc_root is not under a folder named clones"; return 1; }
  { [ -d "$cc_root" ] && [ ! -L "$cc_root" ]; } || { rq_why="$cc_root is not a plain folder"; return 1; }
  # Every component below the first is checked: macOS itself links /var, /tmp, and /etc.
  ec_top=${cc_root#/}
  ec_top=${ec_top%%/*}
  no_link_below "/$ec_top" "${cc_root#/"$ec_top"/}" || { rq_why="$cc_root has a link in its path"; return 1; }
  { is_plain_file "$cc_root/.recnrun-clone" && read_clone_marker "$cc_root/.recnrun-clone" "$cc_name"; } || { rq_why="$cc_root has no valid clone marker"; return 1; }
  { [ "$lc_id" = "$1" ] && [ "$(sed -n 4p "$cc_root/.recnrun-clone")" = "namespace=$ns" ]; } || { rq_why="the marker of $cc_name belongs to another instance or namespace"; return 1; }
}
