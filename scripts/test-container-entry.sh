#!/bin/sh
# WebRTC in a page needs a default route on internal recnrun-tests; the filters below keep every packet in.
set -eu
if ! ip route show default | grep -q .; then
  ip route add default dev eth0
fi
# --internal still reaches the gateway and peer containers, so only lo leaves; the eth0 address loops back on lo.
iptables -A OUTPUT -o lo -j ACCEPT
# A page's mDNS host candidate resolves through the multicast loop copy; tc below drops the copy bound for eth0.
iptables -A OUTPUT -o eth0 -d 224.0.0.251 -p udp --dport 5353 -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited
# Nothing, ARP included, leaves through eth0; the iptables rejects above make connects fail at once.
tc qdisc add dev eth0 clsact
tc filter add dev eth0 egress matchall action drop
exec xvfb-run -a "--server-args=-screen 0 1920x1440x24 -nolisten tcp" vp run --no-cache "$@"
