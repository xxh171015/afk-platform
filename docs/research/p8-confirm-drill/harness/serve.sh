#!/bin/bash
# serve.sh start <run> | stop: the drill's platform API for one run, on 127.0.0.1:8787.
here="$(cd "$(dirname "$0")" && pwd)"
pidfile=/tmp/afk-p8/api.pid
case "$1" in
start)
  mkdir -p "/tmp/afk-p8/run-$2/api"
  nohup python3 "$here/server.py" 8787 "/tmp/afk-p8/run-$2/api" >/tmp/afk-p8/api.out 2>&1 &
  echo $! >"$pidfile"; sleep 1; echo "api pid $(cat $pidfile)";;
stop)
  [ -f "$pidfile" ] && kill "$(cat "$pidfile")" && rm "$pidfile" && echo stopped;;
esac
