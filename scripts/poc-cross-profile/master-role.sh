#!/bin/sh
# master-role.sh: the record's master block (POC PLAN.md P3.4, decision 11), sourced by first-run.sh.
# The namespace has at most one block with role=master; the writer adds the line to
# one block through a temp file in the record's folder and a rename, so a reader never sees half a
# record. Nothing read from the record is run or expanded.

nl='
'

# Succeeds when a block of namespace $2 in record $1 has role=master.
namespace_has_master() {
  [ -f "$1" ] || return 1
  nm_ns='' nm_master=''
  while IFS= read -r nm_line || [ -n "$nm_line" ]; do
    case $nm_line in
      '')
        if [ "$nm_ns" = "$2" ] && [ -n "$nm_master" ]; then return 0; fi
        nm_ns='' nm_master=''
        ;;
      namespace=*) nm_ns=${nm_line#namespace=} ;;
      role=master) nm_master=1 ;;
    esac
  done <"$1"
  [ "$nm_ns" = "$2" ] && [ -n "$nm_master" ]
}

# Writes the closed block in mr_block, plus role=master when its three keys matched and it has no role.
mr_flush() {
  if [ -n "$mr_block" ]; then
    printf '%s' "$mr_block"
    if [ "$mr_hit" = 3 ] && [ -z "$mr_role" ]; then
      printf 'role=master\n'
      mr_done=1
    fi
  fi
  mr_block='' mr_hit=0 mr_role=''
}
# Copies record $1 to stdout with role=master added to the block of user data dir $2, profile directory
# $3, and namespace $4 that has no role; fails when no block took it.
mr_copy() {
  mr_block='' mr_hit=0 mr_role='' mr_done=0
  while IFS= read -r mr_line || [ -n "$mr_line" ]; do
    if [ -z "$mr_line" ]; then
      mr_flush
      printf '\n'
      continue
    fi
    mr_block=$mr_block$mr_line$nl
    case $mr_line in
      "userDataDir=$2" | "profileDirectory=$3" | "namespace=$4") mr_hit=$((mr_hit + 1)) ;;
      role=*) mr_role=1 ;;
    esac
  done <"$1"
  mr_flush
  [ "$mr_done" = 1 ]
}
# Gives profile directory $3 of user data dir $2 in record $1 (namespace $4) role=master, unless the
# namespace has a master already or no roleless block names it. Exit 0 written, 1 nothing written.
set_master_role() {
  if namespace_has_master "$1" "$4"; then return 1; fi
  sm_tmp=$1.$$.tmp
  if mr_copy "$1" "$2" "$3" "$4" >"$sm_tmp"; then
    mv -f -- "$sm_tmp" "$1" && return 0
  fi
  rm -f -- "$sm_tmp"
  return 1
}
