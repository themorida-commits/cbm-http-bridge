# cbm-http-bridge

An authenticated **Streamable HTTP bridge** for **codebase-memory-mcp** —
the open-source MCP server that indexes a codebase as a knowledge graph —
running on a machine inside a private [Tailscale](https://tailscale.com)
network.

The bridge spawns the upstream server as a **stdio child process** on the host
machine and re-exposes it as a stateless Streamable HTTP MCP endpoint
(`POST /mcp`), guarded by mandatory Bearer-token auth, bound to the host's
tailnet IP only, with an audit log of every call and a live deny-list for
destructive tools.

> فارسی: [README-fa.md](README-fa.md)

## Why this exists

Cloud-hosted agents (and any client outside your tailnet) **cannot reach a
tailnet-only service directly** — Tailscale addresses are not routable from
the public internet. The usual workaround, giving the agent SSH access to the
machine, is far broader than the job needs: a shell can do anything.

This bridge is a deliberately narrow tier in front of the code graph:

- **Read / query + index only.** Remote clients can list indexed projects,
  search and traverse the code graph, and trigger indexing — nothing else.
- **Destructive tools are refused at the bridge**, no matter what the client
  asks for (see the deny list below).
- **One token, one port, one interface** (the tailnet NIC) — a much smaller
  surface than a login shell.

It was built so a supervising agent running in a cloud VM could query a code
graph living on a developer's Mac, without the Mac exposing SSH to that agent.

## How it works

```
remote MCP client ──HTTP + Bearer──▶ bridge.mjs ──stdio──▶ codebase-memory-mcp
 (cloud VM, tailnet)                  (this repo)            (child process, local)
```

- One upstream stdio child is kept alive; `tools/list` and `tools/call` are
  forwarded to it.
- The downstream side is **stateless**: a fresh MCP server + transport is
  created per HTTP request (Streamable HTTP, protocol `2025-03-26`).
- Every request must carry `Authorization: Bearer <token>`; anything else
  gets `401` (and is audit-logged).
- `GET /healthz` (also behind auth) returns `{"ok": true}`.

### Deny list

These upstream tools are hard-refused by the bridge, returning an MCP error
to the client and an audit entry:

| Tool | Why |
|---|---|
| `delete_project` | destroys an indexed project |
| `manage_adr` | writes architecture-decision records |
| `ingest_traces` | writes trace content into the graph |

Edit the `DENIED` set in `bridge.mjs` if your deployment needs a different
policy — but think twice before allowing writes through a remote tier.

### Audit log

One line per event is appended to `audit.log` next to `bridge.mjs`
(override with `CBM_BRIDGE_AUDIT_LOG`):

```
2026-01-01T12:00:00.000Z call search_graph
2026-01-01T12:00:05.000Z refused delete_project
2026-01-01T12:00:09.000Z deny POST /mcp
```

Only the timestamp, event type and **tool name** are logged — never argument
contents.

## Setup

Requirements: Node.js ≥ 18, and `codebase-memory-mcp` installed on the host
(or set `CBM_BIN` to its path).

```bash
git clone <this-repo> cbm-http-bridge
cd cbm-http-bridge
npm install

export CBM_BRIDGE_TOKEN="$(openssl rand -hex 32)"   # keep this secret
export CBM_HTTP_HOST="127.0.0.1"                     # local-only smoke test
npm start
```

### Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `CBM_BRIDGE_TOKEN` | — (required) | Bearer token clients must send. The bridge **refuses to start** without it. (`CBM_HTTP_TOKEN` is accepted as a legacy alias.) |
| `CBM_HTTP_HOST` | `127.0.0.1` | Bind address. Set to the host's Tailscale IP (`100.x.x.x`) to serve tailnet clients. **Never use `0.0.0.0`.** |
| `CBM_HTTP_PORT` | `8321` | Listen port. |
| `CBM_BIN` | `codebase-memory-mcp` (via `PATH`) | Upstream stdio server command. |
| `CBM_BRIDGE_AUDIT_LOG` | `./audit.log` beside `bridge.mjs` | Audit log path. |

### Run it at login (macOS / launchd)

`launchd/com.example.cbm-http.plist.example` is a ready-to-fill LaunchAgent:
replace the `__PLACEHOLDER__` values (home dir, Node path, tailnet IP, token,
upstream binary), save it as `~/Library/LaunchAgents/com.example.cbm-http.plist`,
`chmod 600` it (it contains your token), and `launchctl load` it. It runs at
load and is kept alive by launchd.

### Smoke test

```bash
CBM_BRIDGE_TOKEN=<your-token> python3 test_from_vm.py http://<tailnet-ip>:8321/mcp
```

The test performs `initialize`, lists tools, and runs one real read query
(`list_projects` when available). See the file's docstring for the optional
proxy-port override.

Point any MCP client at `http://<tailnet-ip>:8321/mcp` with the Bearer token,
e.g. a Streamable HTTP server entry with an `Authorization` header.

## Security model

- **Network**: the bridge binds to exactly one address — by deployment, the
  host's Tailscale IP — so it is unreachable from the LAN and the internet.
  Tailnet ACLs remain your outer perimeter; this bridge is the inner one.
- **Auth**: a single long random Bearer token, compared on every request,
  including `/healthz`. No token configured ⇒ the process exits instead of
  serving unauthenticated.
- **Authorization**: even *with* a valid token, the deny-listed destructive
  tools are refused. A leaked token buys read/query/index access to your code
  graph — treat that as sensitive in itself, rotate by restarting the bridge
  with a new token.
- **Data minimization**: the audit log records tool names and times only.
- **Not covered**: TLS (traffic rides the encrypted tailnet; do not expose
  this endpoint outside it), per-client tokens, and rate limiting. If you need
  those, put the bridge behind a reverse proxy you control — inside the
  tailnet.

## License

MIT © 2026 Saeed Morida — see [LICENSE](LICENSE).
