"""The P8 drill's stand-in for the platform API: canned answers for plat, and a log of every call.

python3 server.py <port> <log-dir>. Each call is appended to <log-dir>/calls.log; imported ticket files are saved
under <log-dir>/imports/<n>/.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port, log_dir = int(sys.argv[1]), sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
SPEC = open(os.path.join(here, "S-7.md"), encoding="utf-8").read()
USAGE = """Usage: plat <command> [options]   (add --json for machine output)

  spec show S-n                    the spec's body, tickets, edges and warnings
  spec confirm S-n                 confirm the split; the worker starts the tickets
  tickets import S-n <dir>         import a directory of ticket files (one .md per ticket) into a draft spec
  ticket view T-n [--md]           a ticket; --md prints it as a ticket file
  blocked                          what waits for a person
"""
imports = 0


def answer(args, files):
    global imports
    words = [a for a in args if a != "--json"]
    as_json = "--json" in args
    if not words or words[0] in ("help", "-h", "--help") or (len(words) == 1) or words[1] == "--help":
        return 0, USAGE, ""
    cmd = " ".join(words[:2])
    if cmd == "spec show":
        if as_json:
            return 0, json.dumps({"id": "S-7", "title": "按金额下限过滤订单", "state": "draft", "type": "feature",
                                  "body": SPEC, "tickets": [], "warnings": []}, ensure_ascii=False) + "\n", ""
        return 0, f"S-7  按金额下限过滤订单  (draft, feature)\n\n{SPEC}\nTickets: none yet\n", ""
    if cmd == "tickets import":
        if not files:
            return 1, "", f"plat: no ticket files (*.md) in {words[3] if len(words) > 3 else '?'}\n"
        imports += 1
        out_dir = os.path.join(log_dir, "imports", str(imports))
        os.makedirs(out_dir, exist_ok=True)
        lines = [f"Imported {len(files)} tickets into S-7 (draft)."]
        for i, (name, text) in enumerate(sorted(files.items())):
            open(os.path.join(out_dir, name), "w", encoding="utf-8").write(text)
            lines.append(f"  T-{40 + i}  {name[:-3]}")
        lines += ["", "Warnings:"]
        if len(files) >= 3:
            lines.append("  - T-41 and T-42 both touch src/orders/** but do not depend on each other.")
        else:
            lines.append("  - T-40 changes openapi/openapi.yaml, a protected path; it is listed in protected_paths_ok.")
        return 0, "\n".join(lines) + "\n", ""
    if cmd == "spec confirm":
        return 0, "S-7 confirmed: draft -> planned. The worker will start the tickets.\n", ""
    if cmd == "ticket view":
        return 0, "T-40: see the imported file.\n", ""
    if cmd.startswith("blocked"):
        return 0, "Nothing waits for a person.\n", ""
    return 2, "", f"plat: unknown command: {' '.join(args)}\n" + USAGE


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        code, out, err = answer(body.get("args", []), body.get("files", {}))
        with open(os.path.join(log_dir, "calls.log"), "a", encoding="utf-8") as log:
            log.write(f"{time.strftime('%H:%M:%S')}\tplat {' '.join(body.get('args', []))}\t-> {code}\n")
        data = json.dumps({"stdout": out, "stderr": err, "code": code}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


os.makedirs(log_dir, exist_ok=True)
ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
