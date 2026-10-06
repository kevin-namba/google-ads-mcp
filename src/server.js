// MCP サーバー本体（stdio）。

import { readFileSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ToolError, Unavailable, createClient } from "./client.js";
import { loadConfig } from "./config.js";
import { TOOLS } from "./tools.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function reply(payload, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

/** 公開するツール。読み取り専用モードでは書き込みツールを**存在ごと**出さない。 */
export function visibleTools(config) {
  return config.readOnly ? TOOLS.filter((t) => !t.writes) : TOOLS;
}

export async function callTool(tools, ads, name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return reply({ status: "error", error: `不明なツールです: ${name}` }, true);
  try {
    return reply({ status: "ok", ...(await tool.handler(args ?? {}, ads)) });
  } catch (err) {
    if (err instanceof Unavailable) {
      return reply({ status: "unavailable", reason: err.message, ...(err.hint && { hint: err.hint }) }, true);
    }
    if (err instanceof ToolError) return reply({ status: "error", error: err.message }, true);
    return reply({ status: "error", error: `予期しないエラー: ${err?.message ?? err}` }, true);
  }
}

export function createServer(config = loadConfig(), ads = createClient(config)) {
  const tools = visibleTools(config);
  const server = new Server({ name: "google-ads-mcp", version: pkg.version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: {
        title: t.title,
        readOnlyHint: !t.writes,
        destructiveHint: t.destructive,
        openWorldHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(tools, ads, request.params.name, request.params.arguments),
  );

  return server;
}

export async function runServer() {
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `google-ads-mcp ${pkg.version} を起動しました（API ${config.apiVersion}` +
      `${config.readOnly ? "・読み取り専用" : ""}）\n`,
  );
}
