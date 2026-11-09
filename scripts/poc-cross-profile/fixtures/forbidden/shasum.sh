#!/bin/sh
# Fixture: calls shasum
set -eu
shasum -a 256 "$1"
