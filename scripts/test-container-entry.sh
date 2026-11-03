#!/bin/sh
# WebRTC in a page needs a default route on internal recnrun-tests; Docker still drops what leaves.
set -eu
if ! ip route show default | grep -q .; then
  ip route add default dev eth0
fi
exec xvfb-run -a "--server-args=-screen 0 1920x1440x24 -nolisten tcp" vp run --no-cache "$@"
