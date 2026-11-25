#!/usr/bin/env -S bun --no-env-file
import { parseArgs } from "node:util";
import { z } from "zod";
import { LocalClient } from "./ipc";
import { paths, parentToken, workerIdentity } from "./local";
import { DomainError, id, taskId } from "./model";
import { parentRoutes, type ParentMethod, type Params } from "./rpc";

const help = `doormat — local human delegation runtime

Usage
  doormat daemon
  doormat mcp                          MCP stdio bridge
  doormat attach [--worker ID] [--available]
  doormat connect [--worker ID]        Connect without opting into offers
  doormat online [--worker ID]         Opt in for one headless lease
  doormat status | heartbeat | pause | resume | disconnect
  doormat accept [TASK] | reject REASON [TASK]
  doormat ask TEXT [TASK] | abandon REASON [TASK]
  doormat workspace [TASK] [--tmux]     Print path or retry setup
  doormat submit FILE|- [TASK]         Submit JSON with revision and submissionId
  doormat events [TASK] [--after CURSOR]
  doormat history
  doormat parent TOOL [FILE|-]         Call a parent tool with JSON
  doormat route FILE|-                  Evaluate opt-in routing policy

Worker operations accept --worker ID (default: human).
Headless sessions must heartbeat at least once per minute.
`;

async function data(path: string) {
  const input = path === "-" ? Bun.stdin : Bun.file(path);
  if (path !== "-" && input.size > 128 * 1024) throw new DomainError("TOO_LARGE", "JSON input exceeds 128 KiB");
  const reader = input.stream().getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 128 * 1024) {
      await reader.cancel();
      throw new DomainError("TOO_LARGE", "JSON input exceeds 128 KiB");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
const routing = z.strictObject({ mode: z.enum(["manual", "auto", "random"]).default("manual"), eligible: z.boolean().default(false),
  explicitlyRequested: z.boolean().default(false), available: z.boolean(), attemptId: id, rate: z.number().min(0).max(1).optional() });

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") { console.log(help.trimEnd()); return; }
  if (command === "--version") { console.log("0.1.0"); return; }
  const cli = parseArgs({ args, allowPositionals: true, strict: true, options: {
    worker: { type: "string" }, available: { type: "boolean" }, after: { type: "string" }, tmux: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } });
  if (cli.values.help) { console.log(help.trimEnd()); return; }
  const [first, second] = cli.positionals;
  const count: Record<string, [number, number]> = { daemon: [0, 0], mcp: [0, 0], attach: [0, 0], connect: [0, 0], online: [0, 0],
    status: [0, 0], heartbeat: [0, 0], pause: [0, 0], resume: [0, 0], disconnect: [0, 0],
    accept: [0, 1], reject: [1, 2], ask: [1, 2], abandon: [1, 2], workspace: [0, 1], submit: [1, 2],
    events: [0, 1], history: [0, 0], parent: [1, 2], route: [1, 1] };
  if (!Object.hasOwn(count, command)) throw new Error("Unknown command. Run doormat --help");
  const [min, max] = count[command]!;
  if (cli.positionals.length < min || cli.positionals.length > max) throw new Error("Unexpected or missing arguments. Run doormat --help");
  const flags: Record<string, string[]> = { daemon: [], mcp: [], parent: [], route: [], attach: ["worker", "available"],
    workspace: ["worker", "tmux"], events: ["worker", "after"] };
  if (Object.keys(cli.values).some((value) => !(flags[command] ?? ["worker"]).includes(value))) throw new Error("Flag is unsupported for this command");

  if (command === "daemon") return (await import("./daemon")).daemon();
  if (command === "mcp") return (await import("./mcp")).mcp();
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (command === "route") return print({ route: (await import("./routing")).route(routing.parse(await data(first!))) });
  const client = new LocalClient(paths().socket);
  if (command === "parent") {
    if (!Object.hasOwn(parentRoutes, first!)) throw new Error(`Unknown parent tool. Available: ${Object.keys(parentRoutes).join(", ")}`);
    const method = first as ParentMethod;
    const payload = second ? await data(second) : {};
    // Validate at the daemon as well, including clients that connect without this CLI.
    const input = parentRoutes[method].schema.parse(payload) as Params<typeof method>;
    return print(await client.parent(parentToken(), method, input));
  }
  const human = workerIdentity(cli.values.worker ?? "human");
  if (command === "attach") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("attach requires a terminal. Use headless worker commands for JSON output");
    return (await import("./tui")).attach(client, { ...human, session: crypto.randomUUID() }, !!cli.values.available);
  }
  const current = () => client.human(human, "heartbeat", {});
  const selected = async (explicit?: string) => {
    if (explicit) return taskId.parse(explicit);
    const { task } = await current();
    if (!task) throw new Error("No current assignment");
    return task.id;
  };
  switch (command) {
    case "connect":
    case "online": return print(await client.human(human, "connect", { available: command === "online" }));
    case "status":
    case "heartbeat": return print(await current());
    case "pause":
    case "resume": return print(await client.human(human, "availability", { enabled: command === "resume" }));
    case "disconnect": return print(await client.human(human, "disconnect", {}));
    case "history": return print(await client.human(human, "history", {}));
    case "accept":
    case "reject": {
      const expected = command === "accept" ? first : second;
      const { task } = await current();
      if (!task?.offerId || (expected && expected !== task.id)) throw new Error("Requested offer is no longer current");
      const args = { taskId: task.id, offerId: task.offerId };
      return print(command === "accept" ? await client.human(human, "accept", args)
        : await client.human(human, "reject", { ...args, reason: first! }));
    }
    case "ask": return print(await client.human(human, "ask", { taskId: await selected(second), text: first! }));
    case "abandon": return print(await client.human(human, "abandon", { taskId: await selected(second), reason: first! }));
    case "submit": {
      const { submission } = await import("./model");
      const payload = submission.parse(await data(first!));
      return print(await client.human(human, "submit", { taskId: await selected(second), submission: payload }));
    }
    case "events": {
      const cursor = cli.values.after ?? "0";
      if (!/^\d+$/.test(cursor)) throw new Error("--after expects a nonnegative integer");
      return print(await client.human(human, "human_events", { taskId: await selected(first), after: Number(cursor) }));
    }
    case "workspace": {
      const { task } = await current();
      if (!task || (first && first !== task.id)) throw new Error("Requested workspace is not assigned");
      const ready = task.state === "ACCEPTED" ? await client.human(human, "workspace", { taskId: task.id }) : task;
      if (!ready.workspacePath) throw new Error("No workspace path for this assignment");
      if (!cli.values.tmux) return print({ path: ready.workspacePath, commit: ready.commit });
      return print(await (await import("./git")).tmuxWorkspace(ready.workspacePath, task.id));
    }
  }
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof DomainError ? `${error.code}: ${error.message}`
      : error instanceof Error ? error.message : "Unexpected error");
    process.exitCode = 1;
  }
}
