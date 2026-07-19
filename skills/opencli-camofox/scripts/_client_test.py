import os
import importlib.util

spec = importlib.util.spec_from_file_location(
    "_client", os.path.join(os.path.dirname(__file__), "_client.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def test_base_url_default():
    os.environ.pop("OPENCLI_GATEWAY_URL", None)
    assert c.base_url() == "http://localhost:8080"


def test_base_url_strips_slash():
    os.environ["OPENCLI_GATEWAY_URL"] = "http://x:8080/"
    assert c.base_url() == "http://x:8080"


def test_headers_include_bearer():
    os.environ["GATEWAY_API_KEY"] = "k"
    h = c.build_headers()
    assert h["Authorization"] == "Bearer k"


if __name__ == "__main__":
    test_base_url_default()
    test_base_url_strips_slash()
    test_headers_include_bearer()
    print("ok")
