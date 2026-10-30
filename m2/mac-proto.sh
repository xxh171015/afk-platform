# PROTOTYPE runner (wayfinder #70): runs proto.ts on this Mac with the worker's Cursor key, isolated under ~/afk-m2-proto
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
set -a; . ~/.afk/env; set +a
export AFK_MODEL=${AFK_MODEL:-auto} PROTO_HOME=~/afk-m2-proto/work
cd ~/afk-m2-proto && node proto.ts "$@"
