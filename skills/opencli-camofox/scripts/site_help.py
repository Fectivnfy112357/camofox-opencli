"""Show commands for a site. Usage: python site_help.py <site>"""
import json
import sys
from _client import request

if len(sys.argv) < 2:
    print("usage: site_help.py <site>", file=sys.stderr)
    sys.exit(1)
print(json.dumps(request("GET", f"/sites/{sys.argv[1]}/help"), ensure_ascii=False, indent=2))
