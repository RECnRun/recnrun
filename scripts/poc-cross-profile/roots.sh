#!/bin/sh
# roots.sh: the "roots" map of registry.json (POC PLAN.md decision 11), sourced by catalog.sh.
# Each root id the record names maps to its absolute path, so an extension reads a listed peer's
# files under that peer's root; every path is checked before it reaches the JSON.

# RegistrySchema's RootPathSchema: record.sh's directory charset plus no empty or . segment, so
# no trailing slash either; fileUrlFor refuses such a segment.
is_root_path() {
  is_record_directory "$1" || return 1
  case $1/ in *//* | */./*) return 1 ;; esac
  return 0
}

# Prints "roots":{"r1":"<path>",...} from the "id|path" lines of $1, in the numeric order of ids.
roots_json() {
  rj_out='"roots":{'
  rj_separator=
  while IFS='|' read -r rj_id rj_path; do
    [ -n "$rj_id" ] || continue
    rj_out="$rj_out$rj_separator\"$rj_id\":\"$rj_path\""
    rj_separator=,
  done <<EOF
$(printf '%s' "$1" | sort -t '|' -k 1.2,1n)
EOF
  printf '%s}' "$rj_out"
}
