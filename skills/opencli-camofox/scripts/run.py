"""Run an opencli command.
Usage: python run.py <site> <command> [--key value | --flag | positional] ...
Values that look like ints are sent as ints; a bare --flag sends true;
bare (non---) tokens are collected as positionals under "_"."""
import json
import sys
from _client import request


def parse(argv):
    args = {}
    positionals = []
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok.startswith("--"):
            key = tok[2:]
            if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                val = argv[i + 1]
                args[key] = int(val) if val.lstrip("-").isdigit() else val
                i += 2
            else:
                args[key] = True
                i += 1
        else:
            positionals.append(tok)
            i += 1
    if positionals:
        args["_"] = positionals
    return args


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: run.py <site> <command> [--key value]...", file=sys.stderr)
        sys.exit(1)
    site, command = sys.argv[1], sys.argv[2]
    body = {"site": site, "command": command, "args": parse(sys.argv[3:])}
    print(json.dumps(request("POST", "/run", body), ensure_ascii=False, indent=2))
