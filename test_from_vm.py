#!/usr/bin/env python3
"""End-to-end smoke test for the cbm-http bridge.

Usage:
    CBM_BRIDGE_TOKEN=<your-token> python3 test_from_vm.py [base-url]

- The bearer token comes from the CBM_BRIDGE_TOKEN environment variable
  (CBM_HTTP_TOKEN is accepted as a legacy alias). It is never read from a
  file and never printed.
- The base URL comes from the first CLI argument, or CBM_BRIDGE_URL,
  defaulting to http://127.0.0.1:8321/mcp. Pass your bridge's Tailscale
  URL, e.g. http://100.x.x.x:8321/mcp.
- Optional: if your client machine reaches the tailnet through an HTTP
  proxy on a non-default port, set CBM_TEST_PROXY_PORT to rewrite the
  port of the HTTPS_PROXY environment variable for this test run.
Prints the initialize result, the tool list, and one real read query.
"""
import json
import os
import sys
import urllib.request

TOKEN = os.environ.get("CBM_BRIDGE_TOKEN") or os.environ.get("CBM_HTTP_TOKEN") or ""
if not TOKEN:
    sys.exit("set CBM_BRIDGE_TOKEN to the bridge token first")
BASE = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.environ.get("CBM_BRIDGE_URL", "http://127.0.0.1:8321/mcp")
)

_proxy_port = os.environ.get("CBM_TEST_PROXY_PORT")
if _proxy_port and os.environ.get("HTTPS_PROXY"):
    tunnel_proxy = os.environ["HTTPS_PROXY"].rsplit(":", 1)[0] + ":" + _proxy_port
    os.environ["http_proxy"] = tunnel_proxy
    os.environ["https_proxy"] = tunnel_proxy


def rpc(payload, session=None, accept="application/json, text/event-stream"):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", accept)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if session:
        req.add_header("Mcp-Session-Id", session)
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode()
        sid = r.headers.get("Mcp-Session-Id")
    if not body.strip():
        return {}, sid
    # Streamable HTTP may answer as SSE; extract the JSON payload line.
    if "data:" in body:
        for line in body.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:]), sid
    return json.loads(body), sid


def main():
    init, sid = rpc(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "cbm-http-bridge-test", "version": "1.0"},
            },
        }
    )
    print("initialize:", json.dumps(init.get("result", init), ensure_ascii=False)[:300])
    rpc({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    tools, _ = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, sid)
    names = [t["name"] for t in tools["result"]["tools"]]
    print(f"tools ({len(names)}):", ", ".join(names))
    # one real read query: list indexed projects
    tool = "list_projects" if "list_projects" in names else names[0]
    res, _ = rpc(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": tool, "arguments": {}},
        },
        sid,
    )
    print(f"call {tool}:", json.dumps(res.get("result", res), ensure_ascii=False)[:600])


if __name__ == "__main__":
    sys.exit(main())
