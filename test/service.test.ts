import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTransition, delegation } from "../src/model";
import { route } from "../src/routing";
import { AgentService, type Human, type WorkspacePort } from "../src/service";
import { SqliteRepository } from "../src/sqlite";

const owner = "p".repeat(32);
const foreign = "f".repeat(32);
const worker = (name: string): Human => ({ worker: name, secret: crypto.randomUUID(), session: crypto.randomUUID() });
const defaultSpec = { title: "Check the fixture", instructions: "Return a short answer.", parentId: "parent" };
const spec = (requestId = "unit-1") => ({ ...defaultSpec, requestId });
const result = (submissionId = "submit-1", revision = 1) => ({ summary: "Done", evidence: [], submissionId, revision });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function setup(path = ":memory:", workspaces: WorkspacePort = {
  knows: () => false, resolve: async () => "", provision: async () => "",
}) {
  let now = 1000;
  const repo = new SqliteRepository(path);
  const service = new AgentService(repo, workspaces, () => now, 100, 300);
  service.start();
  return { repo, service, advance: (ms: number) => { now += ms; service.tick(); } };
}

test("state graph rejects invalid transitions", () => {
  checkTransition("WORKING", "BLOCKED");
  checkTransition("REVIEWING", "WORKING");
  expect(() => checkTransition("QUEUED", "SUBMITTED")).toThrow("Cannot move");
  expect(() => checkTransition("COMPLETED", "WORKING")).toThrow("Cannot move");
});

test("opt in, pause, stale offer, reject, session expiry and queue deadline", () => {
  const { repo, service: s, advance } = setup();
  cleanups.push(() => repo.close());
  const w = worker("human");
  const first = s.delegate(owner, spec()).taskId;
  expect(s.connect(w, false).availability).toBe("PAUSED");
  expect(s.status(owner, first).state).toBe("QUEUED");
  const original = s.availability(w, true).task!;
  expect(original.state).toBe("OFFERED");
  expect(s.availableHumans()).toEqual([]);
  s.availability(w, false);
  expect(s.status(owner, first).state).toBe("QUEUED");
  const reoffered = s.availability(w, true).task!;
  expect(() => s.accept(w, first, original.offerId!)).toThrow("no longer current");
  s.reject(w, first, reoffered.offerId!, "Not available");
  expect(s.history(w, 10)[0]?.state).toBe("REJECTED");
  const expiring = s.delegate(owner, { ...spec("deadline"), deadline: new Date(1150).toISOString() }).taskId;
  advance(120);
  expect(s.status(owner, expiring).state).toBe("QUEUED");
  expect(() => s.heartbeat(w)).toThrow("Connect or renew");
  expect(s.connect({ ...w, session: crypto.randomUUID() }, false).availability).toBe("PAUSED");
  advance(30);
  expect(s.status(owner, expiring).state).toBe("REJECTED");
});

test("offer timer expires exactly at the boundary while worker lease stays live", () => {
  const { repo, service: s, advance } = setup();
  cleanups.push(() => repo.close());
  const w = worker("human");
  const { taskId } = s.delegate(owner, spec());
  const { task } = s.connect(w, true);
  for (let i = 0; i < 3; i++) { advance(80); s.heartbeat(w); }
  advance(60);
  expect(s.status(owner, taskId).state).toBe("REJECTED");
  expect(() => s.accept(w, taskId, task!.offerId!)).toThrow("no longer current");
});

test("ownership, idempotency, message cursor, rework, stale review and completed history", async () => {
  const { repo, service: s } = setup();
  cleanups.push(() => repo.close());
  const w = worker("worker");
  const other = worker("other");
  const { taskId } = s.delegate(owner, spec());
  expect(s.delegate(owner, spec())).toEqual({ taskId });
  expect(() => s.delegate(owner, { ...spec(), title: "Changed" })).toThrow("different payload");
  const { task } = s.connect(w, true);
  s.connect(other, true);
  expect(() => s.parentEvents(foreign, taskId, 0, 20)).toThrow("Task not found");
  expect(() => s.humanEvents(other, taskId, 0, 20)).toThrow("Task not found");
  expect(() => s.heartbeat({ ...w, secret: other.secret })).toThrow("Invalid worker credentials");
  await s.accept(w, taskId, task!.offerId!);
  s.question(w, taskId, "Which answer?");
  expect(s.heartbeat(w).availability).toBe("BLOCKED");
  s.parentMessage(owner, taskId, "Use the first one.");
  expect(s.heartbeat(w).task?.state).toBe("WORKING");
  const p1 = s.parentEvents(owner, taskId, 0, 2);
  const p2 = s.parentEvents(owner, taskId, p1.nextCursor, 30);
  expect(p1.hasMore).toBe(true);
  expect(p2.events.map(({ type }) => type)).toContain("question");
  const receipt = s.submit(w, taskId, result());
  expect(s.submit(w, taskId, result())).toEqual(receipt);
  expect(() => s.submit(w, taskId, { ...result(), summary: "Different" })).toThrow("different payload");
  expect(s.review(owner, taskId, "submit-1", "review").state).toBe("REVIEWING");
  expect(s.review(owner, taskId, "submit-1", "reopen", "Please add evidence").revision).toBe(2);
  expect(s.result(owner, taskId).submission).toBeNull();
  expect(s.result(owner, taskId, "submit-1").submission?.summary).toBe("Done");
  s.submit(w, taskId, result("submit-2", 2));
  expect(() => s.review(owner, taskId, "submit-1", "complete")).toThrow("current submission");
  expect(s.review(owner, taskId, "submit-2", "complete", "Verified").state).toBe("COMPLETED");
  expect(s.submit(w, taskId, result())).toEqual(receipt);
  expect(s.history(w, 10)[0]?.id).toBe(taskId);
  expect(s.history(other, 10)).toEqual([]);
});

test("SQLite restart invalidates presence, keeps acceptance and allows the same human to reconnect", async () => {
  const root = mkdtempSync(join(tmpdir(), "ha-db-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "tasks.sqlite");
  const before = setup(path);
  const w = worker("human");
  const { taskId } = before.service.delegate(owner, spec());
  const offered = before.service.connect(w, true).task!;
  await before.service.accept(w, taskId, offered.offerId!);
  before.service.disconnect(w);
  expect(before.service.status(owner, taskId).availability).toBe("OFFLINE");
  before.repo.close();
  const { service: s, repo } = setup(path);
  cleanups.push(() => repo.close());
  expect(() => s.heartbeat(w)).toThrow("Connect or renew");
  expect(s.status(owner, taskId).state).toBe("WORKING");
  expect(s.connect({ ...w, session: crypto.randomUUID() }, false).task?.id).toBe(taskId);
  expect(s.delegate(owner, spec()).taskId).toBe(taskId);
});

test("cancellation for fallback wins only before acceptance", async () => {
  const { repo, service: s } = setup();
  cleanups.push(() => repo.close());
  const w = worker("human");
  const { taskId } = s.delegate(owner, spec());
  const { task } = s.connect(w, true);
  expect(s.cancel(owner, taskId, "Fallback", true).state).toBe("CANCELLED");
  expect(() => s.accept(w, taskId, task!.offerId!)).toThrow();
  const next = s.delegate(owner, spec("next")).taskId;
  await s.accept(w, next, s.heartbeat(w).task!.offerId!);
  expect(() => s.cancel(owner, next, "Fallback", true)).toThrow("already accepted");
  expect(s.cancel(owner, next, "Stop", false).state).toBe("CANCELLED");
  expect(() => s.cancel(owner, next, "Fallback", true)).toThrow("already accepted");
  expect(() => s.submit(w, next, result())).toThrow("Cannot move");
});

test("workspace preparation commits ownership before I/O and cannot overwrite cancellation", async () => {
  let finish!: (path: string) => void;
  const provision = new Promise<string>((resolve) => { finish = resolve; });
  const { repo, service: s } = setup(":memory:", { knows: () => true, resolve: async () => "commit", provision: () => provision });
  cleanups.push(() => repo.close());
  const w = worker("human");
  const { taskId } = s.delegate(owner, { ...spec(), workspace: { repository: "demo", ref: "HEAD" } });
  const { task } = s.connect(w, true);
  const pending = s.accept(w, taskId, task!.offerId!);
  expect(s.status(owner, taskId).state).toBe("ACCEPTED");
  expect(() => s.cancel(owner, taskId, "Fallback", true)).toThrow("already accepted");
  await Promise.resolve();
  s.cancel(owner, taskId, "Stop", false);
  finish("/example");
  expect((await pending).state).toBe("CANCELLED");
  expect(s.status(owner, taskId).workspacePath).toBe("/example");
  expect(s.parentEvents(owner, taskId, 0, 30).events.map(({ type }) => type)).toContain("workspace_ready");
});

test("reject unsafe inputs and validate structured output", async () => {
  expect(delegation.safeParse({ ...spec(), workspace: { repository: "demo", ref: "--help" } }).success).toBe(false);
  expect(delegation.safeParse({ ...spec(), command: "arbitrary" }).success).toBe(false);
  const { repo, service: s } = setup();
  cleanups.push(() => repo.close());
  expect(() => s.delegate(owner, { ...spec(), expectedOutputSchema: { $ref: "https://example.invalid/schema" } })).toThrow("Unsupported");
  expect(() => s.delegate(owner, { ...spec(), workspace: { repository: "other", ref: "HEAD" } })).toThrow("not configured");
  const { taskId } = s.delegate(owner, { ...spec(), expectedOutputSchema: { type: "object",
    properties: { count: { type: "integer" } }, additionalProperties: false, required: ["count"] } });
  const w = worker("human");
  const { task } = s.connect(w, true);
  await s.accept(w, taskId, task!.offerId!);
  expect(() => s.submit(w, taskId, { ...result(), output: { count: "2" } })).toThrow("does not match");
  expect(s.submit(w, taskId, { ...result(), output: { count: 2 } }).state).toBe("SUBMITTED");
});

test("routing is explicit by default and random selection is stable per attempt", () => {
  const base = { eligible: true, explicitlyRequested: false, available: true, attemptId: "same" };
  expect(route({ ...base, mode: "manual" })).toBe("ai");
  expect(route({ ...base, mode: "manual", available: false, explicitlyRequested: true })).toBe("human");
  expect(route({ ...base, mode: "auto" })).toBe("human");
  expect(route({ ...base, mode: "auto", eligible: false })).toBe("ai");
  expect(route({ ...base, mode: "random", rate: 0 })).toBe("ai");
  expect(route({ ...base, mode: "random", rate: 1 })).toBe("human");
  const chosen = route({ ...base, mode: "random", rate: 0.4 });
  expect(Array.from({ length: 10 }, () => route({ ...base, mode: "random", rate: 0.4 }))).toEqual(Array(10).fill(chosen));
});
