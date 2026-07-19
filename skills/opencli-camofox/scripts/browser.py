"""Run an opencli browser primitive via /run with site=browser.
Usage: python browser.py <action> [--key value | --flag | positional] ..."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from _client import request
from run import parse

if len(sys.argv) < 2:
    print("usage: browser.py <action> [--key value | positional]...", file=sys.stderr)
    sys.exit(1)
action = sys.argv[1]
body = {"site": "browser", "command": action, "args": parse(sys.argv[2:])}
print(json.dumps(request("POST", "/run", body), ensure_ascii=False, indent=2))
