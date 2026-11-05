#!/bin/sh
# provision.sh run <state-dir> <record> <namespace>
# provision.sh status <state-dir> <operationId>
#
# The launcher's "Prepare workers" step (POC PLAN.md P6.1, decisions 11 and 13), over base.sh,
# clone.sh, and clone-open.sh. POSIX sh only, no JSON parser, nothing read from a file is ever run or
# expanded; positional arguments only. Source it with RECNRUN_DISCOVERY_LIB=1 for the functions.
#
# `run` finds the one block of the record with role=master in the namespace (none or several: logged,
# exit 0) and scans <master downloadsRoot>/RECnRun/poc/<ns>/ops/<operationId>/request.json: a plain
# file of at most 4096 bytes in a folder named by a lowercase v4 uuid, no link at any component, in
# the closed layout of the extension's PrepareRequestSchema (JSON.stringify key order, every key read
# as a substring, nothing else tolerated). Any other request is logged and left alone. Each valid
# request keeps <state-dir>/ops/<operationId> (key=value lines: step, state, startedAt, message,
# clone.<name> = instance id, boot.<name> = ack boot) and advances by ONE step per call, so the
# launcher loop stays responsive and a crash leaves a resumable state:
#   create-base  base.sh create-base <basesDir> <baseName>
#   install      nothing when the extension is already in the base, else base.sh quit (the Chrome
#                create-base left open) and install.sh install-base <basesDir> <baseName> <ns>
#                <build-dir> (build-dir: RECNRUN_EXTENSION_BUILD or <this dir>/extension); the exit code
#                and last stderr line of either fail the step
#   template     base.sh template; no ack in time (69) is pending-action: the step repeats on the next call
#   freeze       base.sh quit, then base.sh freeze
#   create-clone clone.sh create-clone for each w<i> (i up to clones) not created yet, in <basesDir>/clones
#   open-clone   clone-open.sh open-clone for each w<i> without an ack boot yet
#   done
# Every failed step writes state=error with its exit code and the last line of its stderr and stops
# until the request folder holds a plain empty file `retry` (consumed by the next call).
# <master downloadsRoot>/RECnRun/poc/<ns>/ops/<operationId>/status.json is the launcher's, replaced by
# rename: {"operationId","step","state","message","clones":[{"name","instanceId","boot","acked"}],"updatedAt"}.
# The base's template ack is never listed. `status` prints the state file.
#
# Exit: 0 done, 64 wrong call, 65 refused (record or state), 73 cannot write, 75 busy (another run).

pv_as_library=${RECNRUN_DISCOVERY_LIB:-}
# shellcheck source=clone-open.sh
RECNRUN_DISCOVERY_LIB=1 . "$(dirname -- "$0")/clone-open.sh"
RECNRUN_DISCOVERY_LIB=$pv_as_library # a dot keeps its own assignment: give back what this script saw
pv_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

log() { printf 'provision.sh: %s\n' "$*" >&2; }
record_refuse() {
  log "refused: $*"
  exit 65
}
pv_nl='
'
pv_steps='create-base install template freeze create-clone open-clone done'

# --- The master ------------------------------------------------------------------------------

record_hook_line() {
  case $line in role=*) pv_role=${line#role=} ;; esac
}
record_hook_block() {
  pv_block_role=$pv_role pv_role=
  [ "$b_ns" = "$ns" ] && [ "$pv_block_role" = master ] || return 0
  pv_masters=$((pv_masters + 1))
  pv_master_id=$b_id pv_master_root=$b_downloads
}
find_master_block() {
  pv_role='' pv_masters=0 pv_master_id='' pv_master_root=''
  if [ ! -f "$record" ] || [ ! -r "$record" ]; then refuse 'the record is not a readable file'; fi
  record_load "$record"
  record_parse 1
  if [ "$pv_masters" -ne 1 ]; then
    log "the record holds $pv_masters blocks with role=master in namespace $ns, not one: nothing to prepare"
    return 1
  fi
  is_v4 "$pv_master_id" || { log 'the master block has no lowercase v4 profileId'; return 1; }
  [ -n "$pv_master_root" ] || { log 'the master block has no downloadsRoot'; return 1; }
  plain_path "$pv_master_root" RECnRun poc "$ns" ops || return 1
}

# --- The request -----------------------------------------------------------------------------

# The grammar the base commands accept for a bases directory, without empty or dot segments or a final slash.
is_bases_dir() {
  is_plain_root "$1" || return 1
  case $1 in / | */ | *//* | */./* | */.) return 1 ;; esac
}
# Sets rq_* from the request file $1 of operation $2, else rq_why and failure (the file itself is fine).
parse_request() {
  rq_grammar='the request is not in the closed grammar'
  rq_why=$rq_grammar
  ack_rest=$(cat -- "$1")
  ack_take '{"operationId":"' '"' && [ "$ack_value" = "$2" ] || return 1
  ack_take '","kind":"prepare-workers","basesDir":"' '"' || return 1
  rq_why='basesDir is not an absolute path of letters, digits, dot, underscore, hyphen, and slash, without empty or dot segments or a final slash'
  is_bases_dir "$ack_value" || return 1
  rq_bases=$ack_value rq_why=$rq_grammar
  ack_take '","baseName":"' '"' && is_base_name "$ack_value" || return 1
  rq_name=$ack_value
  ack_take '","clones":' ',' || return 1
  rq_why='clones is not a whole number from 1 to 8'
  is_count "$ack_value" && [ "$ack_value" -ge 1 ] && [ "$ack_value" -le 8 ] || return 1
  rq_clones=$ack_value rq_why=$rq_grammar
  ack_take ',"namespace":"' '"' && [ "$ack_value" = "$ns" ] || return 1
  ack_take '","masterProfileId":"' '"' && [ "$ack_value" = "$pv_master_id" ] || return 1
  ack_take '","masterIdentity":{"key":"' '"' && is_base64url "$ack_value" 87 || return 1
  ack_take '","signedAt":' ',' && is_time "$ack_value" || return 1
  ack_take ',"signature":"' '"' && is_base64url "$ack_value" 86 || return 1
  ack_take '"},"createdAt":' '}' && is_time "$ack_value" || return 1
  [ "$ack_rest" = '}' ]
}
# Succeeds when the request of operation $1 is a plain small file in a plain folder (a link, a size over 4096
# bytes, or a NUL byte is ignored, not answered).
request_file_ok() {
  no_link_below "$pv_master_root" "RECnRun/poc/$ns/ops/$1/request.json" || return 1
  rf_file=$pv_ops/$1/request.json
  [ -f "$rf_file" ] && [ ! -L "$rf_file" ] || return 1
  rf_size=$(wc -c <"$rf_file" | tr -d ' ')
  [ "$rf_size" -le 4096 ] || return 1
  rf_text=$(cat -- "$rf_file")
  [ "${#rf_text}" -eq "$rf_size" ]
}

# --- The operation's state -------------------------------------------------------------------

# A message the status carries: printable ASCII without quote or backslash, at most 256 bytes.
clean_message() { printf '%s' "$1" | LC_ALL=C tr -cd ' -~' | LC_ALL=C tr -d '\042\134' | cut -c1-256; }
op_defaults() { op_step=none op_state=running op_started=0 op_message='' op_ids='' op_boots=''; }
op_set() {
  case $1 in
    step) case " $pv_steps " in *" $2 "*) op_step=$2 ;; *) return 1 ;; esac ;;
    state) case $2 in running | pending-action | error | done) op_state=$2 ;; *) return 1 ;; esac ;;
    startedAt) is_count "$2" && op_started=$2 ;;
    message) [ "$2" = "$(clean_message "$2")" ] && op_message=$2 ;;
    clone.w[1-8]) is_v4 "$2" && op_ids="$op_ids${1#clone.}=$2$pv_nl" ;;
    boot.w[1-8]) is_uuid "$2" && op_boots="$op_boots${1#boot.}=$2$pv_nl" ;;
    *) return 1 ;;
  esac
}
# Reads the state file $1 of an operation; an unreadable one exits 65.
read_op() {
  op_defaults
  [ -e "$1" ] || return 0
  if [ ! -f "$1" ] || [ -L "$1" ] || [ "$(wc -c <"$1" | tr -d ' ')" -gt 2048 ]; then die 65 "$1 is not a plain small file"; fi
  while IFS= read -r ro_line || [ -n "$ro_line" ]; do
    case $ro_line in *=*) ;; *) die 65 "$1 has a line without =" ;; esac
    op_set "${ro_line%%=*}" "${ro_line#*=}" || die 65 "$1: invalid ${ro_line%%=*}"
  done <"$1"
}
write_op() {
  wo_tmp=$pv_state/ops/.$op_id.$(lc_random).tmp
  (
    set -C
    printf 'step=%s\nstate=%s\nstartedAt=%s\nmessage=%s\n%s%s' "$op_step" "$op_state" "$op_started" "$op_message" \
      "$(printf '%s' "$op_ids" | sed 's/^/clone./')${op_ids:+$pv_nl}" \
      "$(printf '%s' "$op_boots" | sed 's/^/boot./')${op_boots:+$pv_nl}" >"$wo_tmp"
  ) || die 73 "cannot write $wo_tmp"
  mv -f -- "$wo_tmp" "$pv_state/ops/$op_id" || die 73 'cannot replace the state'
  write_status
}
value_of() {
  vo_rest=$1
  while [ -n "$vo_rest" ]; do
    vo_line=${vo_rest%%"$pv_nl"*}
    case $vo_line in "$2="*) printf '%s' "${vo_line#*=}"; return 0 ;; esac
    case $vo_rest in *"$pv_nl"*) vo_rest=${vo_rest#*"$pv_nl"} ;; *) vo_rest='' ;; esac
  done
  return 1
}
clones_json() {
  cj_out='' cj_i=1
  while [ "$cj_i" -le 8 ]; do
    cj_id=$(value_of "$op_ids" "w$cj_i") || { cj_i=$((cj_i + 1)); continue; }
    cj_boot='' cj_acked=false
    if cj_boot=$(value_of "$op_boots" "w$cj_i"); then cj_acked=true; else cj_boot=''; fi
    cj_out="$cj_out${cj_out:+,}{\"name\":\"w$cj_i\",\"instanceId\":\"$cj_id\",\"boot\":\"$cj_boot\",\"acked\":$cj_acked}"
    cj_i=$((cj_i + 1))
  done
  printf '%s' "$cj_out"
}
write_status() {
  ws_dir=$pv_ops/$op_id
  ws_tmp=$ws_dir/.status.json.$(lc_random).tmp
  (
    set -C
    printf '{"operationId":"%s","step":"%s","state":"%s","message":"%s","clones":[%s],"updatedAt":%s000}' \
      "$op_id" "$op_step" "$op_state" "$op_message" "$(clones_json)" "$(date +%s)" >"$ws_tmp"
  ) || die 73 "cannot write $ws_tmp"
  mv -f -- "$ws_tmp" "$ws_dir/status.json" || die 73 'cannot replace status.json'
}

# --- The steps -------------------------------------------------------------------------------

pv_child=''
# Runs `sh $1 ...` in the background, so a SIGTERM ends the wait; stdout and stderr go to files.
run_step() {
  RECNRUN_DISCOVERY_LIB='' /bin/sh "$@" >"$pv_state/ops/.run.out" 2>"$pv_state/ops/.run.err" &
  pv_child=$!
  wait "$pv_child"
  rs_code=$?
  pv_child=''
  return "$rs_code"
}
last_error_line() { clean_message "$(grep -v '^[[:space:]]*$' "$pv_state/ops/.run.err" | tail -n 1)"; }
# The value of key $1 in the stdout of the last step, else failure.
output_value() {
  while IFS= read -r ov_line || [ -n "$ov_line" ]; do
    case $ov_line in "$1="*) printf '%s' "${ov_line#*=}"; return 0 ;; esac
  done <"$pv_state/ops/.run.out"
  return 1
}
# Outcome of the step: sx_kind ok, pending, or fail; sx_text the message.
step_failed() {
  sx_kind=fail
  sx_text="exit $1: $(last_error_line)"
}
step_create_base() {
  run_step "$pv_dir/base.sh" create-base "$rq_bases" "$rq_name" || { step_failed $?; return 0; }
  sx_text="created $rq_name"
}
step_install() {
  pv_ext=$(head -n 1 "$pv_dir/extension-id" 2>/dev/null)
  if ! is_extension_id "$pv_ext"; then
    sx_kind=fail sx_text='exit 66: no valid extension id next to provision.sh'
    return 0
  fi
  if extension_in_profile "$rq_bases/$rq_name" Default "$pv_ext" >/dev/null; then
    sx_text='the extension is already in the base'
    return 0
  fi
  # create-base left Chrome open on the setup pages, and install.sh refuses a root a process holds.
  run_step "$pv_dir/base.sh" quit "$rq_bases" "$rq_name" || { step_failed $?; return 0; }
  run_step "$pv_dir/install.sh" install-base "$rq_bases" "$rq_name" "$ns" "${RECNRUN_EXTENSION_BUILD:-$pv_dir/extension}" || { step_failed $?; return 0; }
  sx_text='installed the extension in the base'
}
step_template() {
  run_step "$pv_dir/base.sh" template "$rq_bases" "$rq_name" "$ns"
  st_code=$?
  case $st_code in
    0) sx_text='the base answered the template' ;;
    69) sx_kind=pending sx_text='approve the template gesture in the base window' ;;
    *) step_failed "$st_code" ;;
  esac
}
step_freeze() {
  run_step "$pv_dir/base.sh" quit "$rq_bases" "$rq_name" || { step_failed $?; return 0; }
  run_step "$pv_dir/base.sh" freeze "$rq_bases" "$rq_name" "$ns" "$(head -n 1 "$pv_dir/extension-id" 2>/dev/null)" || { step_failed $?; return 0; }
  sx_text="froze $rq_name"
}
# Calls $1 once for each clone name w1 to w<clones> that has no $2 yet.
for_clones() {
  fc_i=1
  while [ "$fc_i" -le "$rq_clones" ]; do
    fc_name=w$fc_i
    fc_i=$((fc_i + 1))
    if [ "$2" = ids ]; then value_of "$op_ids" "$fc_name" >/dev/null && continue; else value_of "$op_boots" "$fc_name" >/dev/null && continue; fi
    "$1" "$fc_name" || return 0
  done
}
create_one() {
  clones_dir=$rq_bases/clones
  if [ ! -e "$clones_dir" ] && [ ! -L "$clones_dir" ]; then mkdir -- "$clones_dir" || { sx_kind=fail sx_text='exit 73: cannot create the clones directory'; return 1; }; fi
  run_step "$pv_dir/clone.sh" create-clone "$rq_bases" "$rq_name" "$clones_dir" "$1" "$ns" || { step_failed $?; return 1; }
  co_id=$(output_value instanceId)
  if ! is_v4 "$co_id"; then sx_kind=fail sx_text='exit 70: clone.sh printed no instance id'; return 1; fi
  op_ids="$op_ids$1=$co_id$pv_nl"
  write_op
}
open_one() {
  run_step "$pv_dir/clone-open.sh" open-clone "$rq_bases/clones" "$1" "$record" "$ns" || { step_failed $?; return 1; }
  oo_boot=$(output_value boot)
  if ! is_uuid "$oo_boot"; then sx_kind=fail sx_text='exit 70: clone-open.sh printed no boot'; return 1; fi
  op_boots="$op_boots$1=$oo_boot$pv_nl"
  write_op
}
step_create_clone() {
  for_clones create_one ids
  [ "$sx_kind" = ok ] && sx_text="created $rq_clones clones"
  return 0
}
step_open_clone() {
  for_clones open_one boots
  [ "$sx_kind" = ok ] && sx_text="opened $rq_clones clones"
  return 0
}
step_done() { sx_text='the workers are ready'; }

# --- One operation ---------------------------------------------------------------------------

next_step() {
  case $1 in
    none) printf 'create-base' ;;
    create-base) printf 'install' ;;
    install) printf 'template' ;;
    template) printf 'freeze' ;;
    freeze) printf 'create-clone' ;;
    create-clone) printf 'open-clone' ;;
    *) printf 'done' ;;
  esac
}
# Consumes the retry file of the operation, if it is a plain empty one.
take_retry() {
  tr_file=$pv_ops/$op_id/retry
  [ -f "$tr_file" ] && [ ! -L "$tr_file" ] && [ ! -s "$tr_file" ] || return 1
  rm -f -- "$tr_file"
}
# Sets the step to run in target, or fails when the operation waits.
choose_target() {
  case $op_state in
    done) return 1 ;;
    error) take_retry || return 1; target=$op_step ;;
    pending-action) target=$op_step ;;
    *) target=$(next_step "$op_step") ;;
  esac
}
refuse_request() {
  op_state=error op_message=$(clean_message "refused: $rq_why")
  [ "$op_step" != none ] || op_step=create-base
  write_op
}
run_target() {
  sx_kind=ok sx_text=''
  "step_$(printf '%s' "$target" | tr - _)"
  op_step=$target
  case $sx_kind in
    ok) op_state=running; [ "$target" != "done" ] || op_state="done" ;;
    pending) op_state=pending-action ;;
    *) op_state=error ;;
  esac
  op_message=$(clean_message "$sx_text")
  write_op
}
advance_op() {
  op_id=$1
  read_op "$pv_state/ops/$op_id"
  choose_target || return 0
  [ "$op_started" != 0 ] || op_started=$(date +%s)
  if ! parse_request "$pv_ops/$op_id/request.json" "$op_id"; then
    refuse_request
    return 0
  fi
  run_target
}

# --- Commands --------------------------------------------------------------------------------

cleanup() {
  [ -z "$pv_child" ] || kill -TERM "$pv_child" 2>/dev/null
  rm -f -- "$pv_state/ops/.run.out" "$pv_state/ops/.run.err"
  release_lock "$pv_state/provision.lock" "$$"
}
cmd_run() {
  [ "$#" -eq 3 ] || die 64 'usage: run <state-dir> <record> <namespace>'
  state_dir "$1"
  no_link_below "$1" ops || die 65 "$1/ops is a symbolic link"
  mkdir -p -- "$1/ops"
  pv_state=$1 record=$2 ns=$3
  is_namespace "$ns" || die 65 'the namespace is not a namespace'
  if ! is_directory "$record" || [ ! -f "$record" ]; then die 65 'the record is not an absolute file'; fi
  find_master_block || return 0
  pv_ops=$pv_master_root/RECnRun/poc/$ns/ops
  take_lock "$pv_state/provision.lock" "$$"
  trap cleanup EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  for pv_folder in "$pv_ops"/*/; do
    pv_id=${pv_folder%/}
    pv_id=${pv_id##*/}
    if ! is_v4 "$pv_id" || ! plain_path "$pv_master_root" RECnRun poc "$ns" ops "$pv_id"; then
      [ "$pv_id" = '*' ] || log "ignored $pv_folder: not a plain folder named by a lowercase v4 uuid"
      continue
    fi
    if ! request_file_ok "$pv_id"; then
      log "ignored the request of $pv_id: not a plain file of at most 4096 bytes"
      continue
    fi
    advance_op "$pv_id"
  done
}
cmd_status() {
  [ "$#" -eq 2 ] || die 64 'usage: status <state-dir> <operationId>'
  state_dir "$1"
  is_v4 "$2" || die 65 'the operation id is not a lowercase v4 uuid'
  pv_state=$1
  read_op "$1/ops/$2"
  [ -e "$1/ops/$2" ] || die 65 "no operation $2"
  cat -- "$1/ops/$2"
}

if [ -z "$pv_as_library" ]; then
  [ "$#" -ge 1 ] || die 64 'usage: provision.sh run|status [argument ...]'
  pv_command=$1
  shift
  case $pv_command in
    run) cmd_run "$@" ;;
    status) cmd_status "$@" ;;
    *) die 64 "unknown command $pv_command" ;;
  esac
fi
