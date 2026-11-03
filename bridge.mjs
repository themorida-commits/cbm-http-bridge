// cbm-http-bridge — exposes a local stdio MCP server (codebase-memory-mcp)
// as an authenticated Streamable HTTP MCP endpoint for tailnet clients.
//
// Design (v1, read-oriented):
// - Bearer-token auth on every request. The token comes from the
//   CBM_BRIDGE_TOKEN environment variable (CBM_HTTP_TOKEN is accepted as a
//   legacy alias). No token configured, no service: the bridge refuses to
//   start instead of running unauthenticated.
// - Binds ONLY to the host given by CBM_HTTP_HOST (default 127.0.0.1; set it
//   to your machine's Tailscale IP to serve tailnet clients), port
//   CBM_HTTP_PORT (default 8321). Never bind 0.0.0.0.
// - Forwards tools/list and tools/call to ONE stdio child process
//   (CBM_BIN env, default "codebase-memory-mcp" resolved via PATH).
// - Audit: one line per tool call appended to the audit log (tool name +
//   time only; argument contents are NOT logged). Override the location
//   with CBM_BRIDGE_AUDIT_LOG.
//
// Requires: @modelcontextprotocol/sdk, express  (npm i in this dir)

import express from "express";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.CBM_BRIDGE_TOKEN || process.env.CBM_HTTP_TOKEN || "";
if (!TOKEN) {
  console.error(
    "cbm-http-bridge: refusing to start — set CBM_BRIDGE_TOKEN to a long random secret first."
  );
  process.exit(1);
}
const HOST = process.env.CBM_HTTP_HOST || "127.0.0.1";
const PORT = Number(process.env.CBM_HTTP_PORT || 8321);
const CBM_BIN = process.env.CBM_BIN || "codebase-memory-mcp";
const AUDIT = process.env.CBM_BRIDGE_AUDIT_LOG || join(here, "audit.log");

function audit(line) {
  try {
    appendFileSync(AUDIT, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

// ---- upstream stdio client to codebase-memory-mcp ----
const upstream = new Client(
  { name: "cbm-http-bridge", version: "1.0.0" },
  { capabilities: {} }
);
const transportUp = new StdioClientTransport({
  command: CBM_BIN,
  args: [],
  stderr: "inherit",
});
await upstream.connect(transportUp);

// ---- downstream MCP server (stateless: one transport per request) ----
function makeServer() {
  const server = new Server(
    { name: "codebase-memory-http", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const res = await upstream.listTools();
    return { tools: res.tools };
  });
  // Bridge-level guard: this endpoint is for supervisor queries + indexing.
  // Destructive / content-writing tools of the upstream server are refused here,
  // regardless of what the remote client asks for.
  const DENIED = new Set(["delete_project", "manage_adr", "ingest_traces"]);
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (DENIED.has(req.params.name)) {
      audit(`refused ${req.params.name}`);
      return {
        content: [
          {
            type: "text",
            text: `tool ${req.params.name} is disabled on this bridge (read/query + index only)`,
          },
        ],
        isError: true,
      };
    }
    audit(`call ${req.params.name}`);
    const res = await upstream.callTool({
      name: req.params.name,
      arguments: req.params.arguments ?? {},
    });
    return res;
  });
  return server;
}

const app = express();
app.use(express.json({ limit: "8mb" }));

app.use((req, res, next) => {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${TOKEN}`) {
    audit(`deny ${req.method} ${req.path}`);
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.all("/mcp", async (req, res) => {
  try {
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e) });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(PORT, HOST, () => {
  console.log(`cbm-http-bridge listening on http://${HOST}:${PORT}/mcp`);
});
