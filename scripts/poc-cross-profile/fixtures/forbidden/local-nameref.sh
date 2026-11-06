#!/bin/sh
# Fixture: uses local -n
set -eu
f() { local -n ref=$1; }
