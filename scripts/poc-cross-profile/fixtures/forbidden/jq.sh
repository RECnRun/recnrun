#!/bin/sh
# Fixture: calls jq
set -eu
name=$(jq -r .name "$1")
