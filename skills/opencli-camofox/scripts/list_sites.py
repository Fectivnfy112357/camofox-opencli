"""List/search opencli sites. Usage: python list_sites.py [query]"""
import json
import sys
from _client import request

q = sys.argv[1] if len(sys.argv) > 1 else None
path = f"/sites?q={q}" if q else "/sites"
print(json.dumps(request("GET", path), ensure_ascii=False, indent=2))
