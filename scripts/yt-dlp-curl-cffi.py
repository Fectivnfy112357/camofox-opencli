#!/usr/bin/env python3
"""Run yt-dlp with curl_cffi as the only HTTP request handler.

This launcher is deliberately used only by the gateway video-download path.
yt-dlp normally registers both UrllibRH and CurlCFFIRH; the latter has a lower
default preference and a failed curl_cffi request can fall back to urllib.  The
gateway needs an explicit transport invariant for anti-bot protected video
sites, so remove UrllibRH before delegating to yt-dlp's ordinary CLI entrypoint.
"""

from yt_dlp.networking._curlcffi import CurlCFFIRH  # verifies curl_cffi exists
from yt_dlp.networking._urllib import UrllibRH
from yt_dlp.networking.common import _REQUEST_HANDLERS, _RH_PREFERENCES

# Do not let a handler-selection fallback reach Python urllib.  Retaining the
# explicit preference makes curl_cffi first even if a future yt-dlp release
# registers additional HTTP handlers.
_REQUEST_HANDLERS.pop(UrllibRH.RH_KEY, None)
_RH_PREFERENCES.add(lambda handler, request: 10_000 if isinstance(handler, CurlCFFIRH) else -10_000)

from yt_dlp import main


if __name__ == '__main__':
    main()
