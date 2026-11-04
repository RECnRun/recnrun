#!/bin/sh
# Fixture: lowercases with a parameter expansion
set -eu
echo "${1,,}"
