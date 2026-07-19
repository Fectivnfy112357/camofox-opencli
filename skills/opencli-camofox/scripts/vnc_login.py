"""Get a noVNC link to log into a site manually.
Usage: python vnc_login.py [--url TARGET_URL]"""
import json
import sys
from _client import request

url = None
if "--url" in sys.argv:
    i = sys.argv.index("--url")
    if i + 1 < len(sys.argv):
        url = sys.argv[i + 1]
body = {"url": url} if url else {}
res = request("POST", "/login", body)
if res.get("ok"):
    print(res["data"]["vncUrl"])
else:
    print(json.dumps(res, ensure_ascii=False), file=sys.stderr)
    sys.exit(1)
