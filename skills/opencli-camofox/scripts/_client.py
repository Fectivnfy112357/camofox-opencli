"""Shared HTTP client for the opencli-camofox skill (stdlib only)."""
import json
import os
import urllib.request
import urllib.error


def _load_dotenv():
    if os.environ.get("OPENCLI_GATEWAY_URL") and os.environ.get("GATEWAY_API_KEY"):
        return
    path = os.path.join(os.path.expanduser("~"), ".opencli-gateway.env")
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


_load_dotenv()


def base_url():
    return (os.environ.get("OPENCLI_GATEWAY_URL") or "http://localhost:8080").rstrip("/")


def api_key():
    return (os.environ.get("GATEWAY_API_KEY") or "").strip()


def build_headers():
    h = {"Content-Type": "application/json"}
    k = api_key()
    if k:
        h["Authorization"] = f"Bearer {k}"
    return h


def request(method, path, body=None, timeout=120):
    url = f"{base_url()}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=build_headers(), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except Exception:
            return {"ok": False, "error": {"code": f"http_{e.code}", "message": raw[:300]}}
