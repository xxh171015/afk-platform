"""Print a turn's shell commands and final answer from a Cursor stream-json file; save the session id."""
import json
import sys

stream, session_file = sys.argv[1], sys.argv[2]
commands, result = [], None
for line in open(stream):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if e.get("session_id"):
        open(session_file, "w").write(e["session_id"])
    if e.get("type") == "tool_call" and e.get("subtype") == "started":
        call = e.get("tool_call", {})
        for name, body in call.items():
            if not name.endswith("ToolCall") or not isinstance(body, dict):
                continue
            args = body.get("args", body)
            if "command" in args:
                commands.append(f"{name}: {args['command']}")
            else:
                commands.append(f"{name}: {json.dumps(args, ensure_ascii=False)[:140]}")
    if e.get("type") == "result":
        result = e.get("result")
print("--- tool calls:")
for c in commands:
    print("  " + c)
print("--- answer:")
print(result if result is not None else "(no result event)")
