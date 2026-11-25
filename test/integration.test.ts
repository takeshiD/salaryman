import { afterEach, beforeEach, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { LocalClient } from "../src/ipc";
import type { Human } from "../src/service";

const entry = join(import.meta.dir, "../src/cli.ts");
const owner = "p".repeat(32);
const taskSpec = { requestId: "integration", parentId: "parent", title: "Review a fixture", instructions: "Send a short summary." };
const worker = (name: string): Human => ({ worker: name, secret: crypto.randomUUID(), session: crypto.randomUUID() });
let root: string;
let env: Record<string, string>;
let daemons: ReturnType<typeof spawnDaemon>[] = [];
let ipc: LocalClient;
let sock: string;
let repo: string;
let base: string;

function git(...args: string[]) {
  const run = Bun.spawnSync(["git", "-C", repo, ...args], { env });
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ha-ipc-"));
  repo = join(root, "git repo");
  env = { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"), DOORMAT_PARENT_TOKEN: owner,
    DOORMAT_REPOSITORIES: JSON.stringify({ demo: repo }) };
  mkdirSync(repo);
  git("init", "-q");
  writeFileSync(join(repo, "example"), "base\n");
  git("add", "example");
  git("-c", "user.name=Example", "-c", "user.email=example@example.invalid", "commit", "-qm", "Fixture");
  base = git("rev-parse", "HEAD");
  sock = join(env.XDG_RUNTIME_DIR!, "human-agent", "agent.sock");
  ipc = new LocalClient(sock);
});
afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
    await daemon.exited;
  }
  rmSync(root, { recursive: true, force: true });
});

function spawnDaemon(overrides = {}) {
  return Bun.spawn([process.execPath, entry, "daemon"], { env: { ...env, ...overrides }, stdout: "ignore", stderr: "pipe" });
}
async function start() {
  const daemon = spawnDaemon();
  daemons.push(daemon);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) break;
    try {
      await ipc.parent(owner, "list_available_humans", {});
      return daemon;
    } catch { await Bun.sleep(20); }
  }
  if (daemon.exitCode === null) daemon.kill();
  throw new Error("Daemon failed to start: " + await new Response(daemon.stderr).text());
}
async function raw(bytes: string) {
  const socket = createConnection(sock);
  await once(socket, "connect");
  socket.write(bytes);
  let reply = "";
  for await (const chunk of socket) reply += chunk;
  return JSON.parse(reply);
}

test("socket modes, stale-socket restart, lease invalidation and duplicate daemon exclusion", async () => {
  const daemon = await start();
  expect(statSync(sock).mode & 0o777).toBe(0o600);
  expect(statSync(join(sock, "..")).mode & 0o777).toBe(0o700);
  const second = spawnDaemon({ XDG_STATE_HOME: join(root, "other-state") });
  expect(await second.exited).not.toBe(0);
  expect(await new Response(second.stderr).text()).toContain("already in use");
  const { taskId } = await ipc.parent(owner, "delegate_to_human", taskSpec);
  const human = worker("worker");
  const offer = (await ipc.human(human, "connect", { available: true })).task!;
  await ipc.human(human, "accept", { taskId, offerId: offer.offerId! });
  daemon.kill("SIGKILL");
  await daemon.exited;
  await start();
  await expect(ipc.human(human, "heartbeat", {})).rejects.toThrow("Connect or renew");
  expect((await ipc.parent(owner, "get_human_status", { taskId })).availability).toBe("OFFLINE");
  expect((await ipc.human(human, "connect", {})).task?.state).toBe("WORKING");
});

test("concurrent workers and duplicate accepts produce one owner; unaccepted-only cancel cannot reclaim it", async () => {
  await start();
  const { taskId } = await ipc.parent(owner, "delegate_to_human", taskSpec);
  const humans = [worker("one"), worker("two")];
  const snapshots = await Promise.all(humans.map((human) => ipc.human(human, "connect", { available: true })));
  expect(snapshots.filter(({ task }) => task?.id === taskId)).toHaveLength(1);
  const winner = snapshots.findIndex(({ task }) => task?.id === taskId);
  const args = { taskId, offerId: snapshots[winner]!.task!.offerId! };
  const results = await Promise.allSettled([
    ipc.human(humans[winner]!, "accept", args),
    ipc.human(humans[winner]!, "accept", args),
    ipc.human(humans[1 - winner]!, "accept", args),
  ]);
  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  await expect(ipc.parent(owner, "cancel_human_task", { taskId, reason: "Fallback" })).rejects.toThrow("already accepted");
});

test("IPC rejects unknown methods, extra keys, malformed, overlarge and deeply nested frames", async () => {
  await start();
  expect(await raw('{"v":1,"method":"__proto__","auth":"unused","params":{}}\n')).toMatchObject({ code: "NO_METHOD" });
  expect(await raw("not JSON\n")).toMatchObject({ code: "BAD_FRAME" });
  expect(await raw("a".repeat(130 * 1024) + "\n")).toMatchObject({ code: "TOO_LARGE" });
  expect(await raw("[".repeat(100) + "]".repeat(100) + "\n")).toMatchObject({ code: "BAD_FRAME" });
  const payload = { ...taskSpec, command: "git" };
  await expect(ipc.parent(owner, "delegate_to_human", payload)).rejects.toThrow("unrecognized_keys");
  const { taskId } = await ipc.parent(owner, "delegate_to_human", taskSpec);
  await expect(ipc.parent("q".repeat(32), "get_human_status", { taskId })).rejects.toThrow("Task not found");
});

test("MCP SDK stdio lists tools, delegates, exchanges messages and reviews a submission", async () => {
  await start();
  const tokenFile = join(root, "parent.token");
  writeFileSync(tokenFile, owner + "\n", { mode: 0o600 });
  const { DOORMAT_PARENT_TOKEN: _token, ...stdioEnv } = env;
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", entry, "mcp"],
    env: { ...stdioEnv, DOORMAT_PARENT_TOKEN_FILE: tokenFile }, stderr: "pipe" });
  const client = new Client({ name: "doormat-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("complete_human_task");
    async function call<R>(name: string, args: Record<string, unknown> = {}) {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      const content = result.content[0];
      if (content?.type !== "text" || result.isError) throw new Error(JSON.stringify(result));
      return JSON.parse(content.text) as R;
    }
    const { taskId } = await call<{ taskId: string }>("delegate_to_human", taskSpec);
    expect((await call<{ state: string }>("get_human_status", { taskId })).state).toBe("QUEUED");
    const human = worker("worker");
    const offer = (await ipc.human(human, "connect", { available: true })).task!;
    await ipc.human(human, "accept", { taskId, offerId: offer.offerId! });
    await ipc.human(human, "ask", { taskId, text: "Should I include evidence?" });
    expect((await call<{ events: { type: string }[] }>("get_task_events", { taskId })).events.map(({ type }) => type)).toContain("question");
    await call("message_human", { taskId, text: "Yes." });
    await ipc.human(human, "submit", { taskId, submission: { submissionId: "s1", revision: 1, summary: "Done", evidence: ["Fixture passed"] } });
    expect((await call<{ submission: { evidence: string[] } }>("get_human_result", { taskId })).submission.evidence).toEqual(["Fixture passed"]);
    expect((await call<{ state: string }>("complete_human_task", { taskId, submissionId: "s1" })).state).toBe("COMPLETED");
  } finally { await client.close(); }
});

test("Git worktree appears only after acceptance, pins base, retains main checkout and avoids cleanup", async () => {
  await start();
  writeFileSync(join(repo, "example"), "local dirty change\n");
  const hook = join(repo, ".git", "hooks", "post-checkout");
  const marker = join(root, "hook-ran");
  writeFileSync(hook, "#!/bin/sh\ntouch " + marker + "\n", { mode: 0o755 });
  const { taskId } = await ipc.parent(owner, "delegate_to_human", { ...taskSpec, workspace: { repository: "demo", ref: base } });
  const human = worker("worker");
  const offer = (await ipc.human(human, "connect", { available: true })).task!;
  const dest = join(env.XDG_STATE_HOME!, "human-agent", "worktrees", taskId);
  expect(await Bun.file(join(dest, "example")).exists()).toBe(false);
  const ready = await ipc.human(human, "accept", { taskId, offerId: offer.offerId! });
  expect(ready.workspacePath).toBe(dest);
  expect(ready.commit).toBe(base);
  expect(await Bun.file(join(dest, "example")).text()).toBe("base\n");
  expect(await Bun.file(join(repo, "example")).text()).toBe("local dirty change\n");
  expect(await Bun.file(marker).exists()).toBe(false);
  await ipc.parent(owner, "cancel_human_task", { taskId, reason: "Stop", unacceptedOnly: false });
  expect(await Bun.file(join(dest, "example")).exists()).toBe(true);
});

test("workspace adapter preserves an unexpected path after an accepted task fails setup", async () => {
  await start();
  const { taskId } = await ipc.parent(owner, "delegate_to_human", { ...taskSpec, workspace: { repository: "demo", ref: base } });
  const human = worker("worker");
  const offer = (await ipc.human(human, "connect", { available: true })).task!;
  const dest = join(env.XDG_STATE_HOME!, "human-agent", "worktrees", taskId);
  symlinkSync(repo, dest);
  await expect(ipc.human(human, "accept", { taskId, offerId: offer.offerId! })).rejects.toThrow("manual inspection");
  expect((await ipc.human(human, "heartbeat", {})).task?.state).toBe("ACCEPTED");
  expect((await ipc.human(human, "human_events", { taskId })).events.map(({ type }) => type)).toContain("workspace_error");
  expect(await Bun.file(join(repo, "example")).text()).toBe("base\n");
});

test("half-closed clients receive replies to asynchronous accepts", async () => {
  await start();
  const { taskId } = await ipc.parent(owner, "delegate_to_human", { ...taskSpec, workspace: { repository: "demo", ref: base } });
  const human = worker("worker");
  const offer = (await ipc.human(human, "connect", { available: true })).task!;
  const connection = createConnection({ path: sock, allowHalfOpen: true });
  await once(connection, "connect");
  connection.end(JSON.stringify({ v: 1, method: "accept", auth: human, params: { taskId, offerId: offer.offerId } }) + "\n");
  let reply = "";
  for await (const chunk of connection) reply += chunk;
  expect(JSON.parse(reply)).toMatchObject({ ok: true, data: { state: "WORKING" } });
});

test("daemon shutdown disconnects idle socket peers", async () => {
  const daemon = await start();
  const connection = createConnection(sock);
  await once(connection, "connect");
  try {
    daemon.kill("SIGTERM");
    expect(await Promise.race([daemon.exited, Bun.sleep(1_200).then(() => "timeout")])).toBe(0);
  } finally { connection.destroy(); }
});

test("workspace restart recovery adopts a matching detached checkout and refuses a branch checkout", async () => {
  await start();
  const rootPath = join(env.XDG_STATE_HOME!, "human-agent", "worktrees");
  const { GitWorkspaces } = await import("../src/git");
  const workspaces = new GitWorkspaces(rootPath, { demo: repo });
  const taskId = crypto.randomUUID();
  const destination = await workspaces.provision(taskId, "demo", base);
  expect(await workspaces.provision(taskId, "demo", base)).toBe(destination);
  const branch = Bun.spawnSync(["git", "-C", destination, "switch", "-c", "recovery-branch"], { env });
  expect(branch.success).toBe(true);
  await expect(workspaces.provision(taskId, "demo", base)).rejects.toThrow("manual inspection");
});

test("simultaneous acceptance and fallback cancellation cannot both succeed", async () => {
  await start();
  const { taskId } = await ipc.parent(owner, "delegate_to_human", taskSpec);
  const human = worker("worker");
  const offer = (await ipc.human(human, "connect", { available: true })).task!;
  const results = await Promise.allSettled([
    ipc.human(human, "accept", { taskId, offerId: offer.offerId! }),
    ipc.parent(owner, "cancel_human_task", { taskId, reason: "Try a fallback", unacceptedOnly: true }),
  ]);
  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  const status = await ipc.parent(owner, "get_human_status", { taskId });
  expect(status.state).toBe(results[0]?.status === "fulfilled" ? "WORKING" : "CANCELLED");
});

test("workspace setup rejects repository-defined external filters", async () => {
  await start();
  git("config", "filter.test.smudge", "false");
  const task = { ...taskSpec, workspace: { repository: "demo", ref: base } };
  const { taskId } = await ipc.parent(owner, "delegate_to_human", task);
  const human = worker("worker");
  const offer = (await ipc.human(human, "connect", { available: true })).task!;
  await expect(ipc.human(human, "accept", { taskId, offerId: offer.offerId! })).rejects.toThrow("external filters");
  expect((await ipc.parent(owner, "get_human_status", { taskId })).state).toBe("ACCEPTED");
});

test("legacy environment variables still connect to the existing runtime", async () => {
  env.HUMAN_AGENT_PARENT_TOKEN = owner;
  env.HUMAN_AGENT_REPOSITORIES = env.DOORMAT_REPOSITORIES!;
  delete env.DOORMAT_PARENT_TOKEN;
  delete env.DOORMAT_REPOSITORIES;
  await start();
  const payload = JSON.stringify({ ...taskSpec, workspace: { repository: "demo", ref: base } });
  const child = Bun.spawn([process.execPath, entry, "parent", "delegate_to_human", "-"], {
    env, stdin: new Blob([payload]), stdout: "pipe", stderr: "pipe",
  });
  const [exit, output, errors] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(errors).toBe("");
  expect(exit).toBe(0);
  expect((await ipc.parent(owner, "get_human_status", { taskId: JSON.parse(output).taskId })).state).toBe("QUEUED");
});
