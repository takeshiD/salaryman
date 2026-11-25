import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LocalClient } from "./ipc";
import { parentToken, paths } from "./local";
import { DomainError } from "./model";
import { parentRoutes, type Params, type ParentMethod } from "./rpc";

const descriptions: Record<ParentMethod, string> = {
  delegate_to_human: "Queue a scoped task and return its ID immediately. Reuse the same requestId and payload after an uncertain reply.",
  list_available_humans: "List idle humans who have opted in. Availability is advisory and can change before an offer.",
  get_human_status: "Read an owned task, its state and assignee availability.",
  message_human: "Send task-scoped instructions or reply to a human question.",
  get_human_result: "Read a result for the current revision or a specific previous submission.",
  cancel_human_task: "Cancel an owned task. unacceptedOnly defaults to true and is safe for fallback decisions.",
  get_task_events: "Read task-scoped events after a cursor. Continue with nextCursor.",
  review_human_task: "Mark the current submission as under review.",
  reopen_human_task: "Request rework of the current submission and add feedback.",
  complete_human_task: "Approve the current submission and close the task.",
};
const callResult = (value: object, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export async function mcp() {
  const client = new LocalClient(paths().socket);
  const auth = parentToken();
  const server = new McpServer({ name: "human-agent", version: "0.1.0" });
  function register<M extends ParentMethod>(name: M) {
    server.registerTool(name, { description: descriptions[name], inputSchema: parentRoutes[name].schema }, async (args: unknown) => {
      try { return callResult(await client.parent(auth, name, args as Params<M>)); }
      catch (error) {
        const expected = error instanceof DomainError;
        return callResult({ code: expected ? error.code : "INTERNAL", message: expected ? error.message : "Bridge error" }, true);
      }
    });
  }
  for (const name of Object.keys(parentRoutes) as ParentMethod[]) register(name);
  await server.connect(new StdioServerTransport());
}
