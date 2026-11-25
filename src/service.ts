import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { canonical, checkTransition, digest, DomainError, occupying, terminal, tokenMatches,
  type Availability, type Delegation, type Receipt, type Snapshot, type Submission, type Task, type TaskState } from "./model";
import type { Lease, Repository, StoredTask, Worker } from "./repository";

export type Human = { worker: string; secret: string; session: string };
export interface WorkspacePort {
  knows(repository: string): boolean;
  resolve(spec: NonNullable<Delegation["workspace"]>): Promise<string>;
  provision(taskId: string, repository: string, commit: string): Promise<string>;
}

function visible({ owner: _owner, ...task }: StoredTask): Task { return task; }
const fail = (code: string, message: string): never => { throw new DomainError(code, message); };
const ajv = new Ajv({
  strict: true, validateFormats: false, ownProperties: true,
  loadSchema: undefined, addUsedSchema: false,
});

function validator(schema: NonNullable<Delegation["expectedOutputSchema"]>) {
  // Compile only self-contained draft-07 schemas. AJV resolves no external resources.
  if (Buffer.byteLength(JSON.stringify(schema)) > 8_192) fail("BAD_SCHEMA", "Output schema exceeds 8192 bytes");
  function inspect(value: unknown, depth = 0) {
    if (depth > 24) fail("BAD_SCHEMA", "Output schema is too deeply nested");
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      // Keep model-supplied validators bounded and avoid untrusted regular expressions.
      if (["$ref", "$dynamicRef", "$recursiveRef", "pattern", "patternProperties", "format", "uniqueItems"].includes(key)) {
        fail("BAD_SCHEMA", `Unsupported schema keyword: ${key}`);
      }
      inspect(child, depth + 1);
    }
  }
  inspect(schema);
  try { return ajv.compile(schema); }
  catch { return fail("BAD_SCHEMA", "Expected a supported JSON Schema draft-07 object"); }
}

export class AgentService {
  private readonly preparations = new Map<string, Promise<Task>>();

  constructor(private readonly repo: Repository, private readonly workspaces: WorkspacePort,
    private readonly now = Date.now, private readonly leaseMs = 60_000, private readonly offerMs = 120_000) {}

  start() {
    this.repo.transaction(() => { this.repo.resetLeases(); this.reconcile(this.now()); });
  }
  tick() { this.run(() => undefined); }
  drain() { return Promise.allSettled(this.preparations.values()); }

  private run<T>(fn: (now: number) => T) {
    // Commit time-based updates independently of validation failures in the requested operation.
    this.repo.transaction(() => this.reconcile(this.now()));
    return this.repo.transaction(() => {
      const now = this.now();
      const result = fn(now);
      this.dispatch(now);
      return result;
    });
  }
  private transition(task: StoredTask, state: TaskState, now: number, actor: "system" | "human" | "parent",
    detail?: string): StoredTask {
    checkTransition(task.state, state);
    const updated = { ...task, state, updatedAt: now };
    if (state !== "OFFERED") { updated.offerUntil = null; updated.offerId = null; }
    if (state === "QUEUED") updated.worker = null;
    this.repo.saveTask(updated);
    this.repo.event(task.id, now, { actor, type: "transition", from: task.state, to: state, detail });
    return updated;
  }
  private reconcile(now: number) {
    this.repo.expireLeases(now);
    for (const task of this.repo.offered()) {
      if (this.deadlineReached(task, now) || task.offerUntil! <= now) {
        this.transition(task, "REJECTED", now, "system", "Offer expired");
      } else if (!task.worker || !this.repo.hasLease(task.worker, now)) {
        this.transition(task, "QUEUED", now, "system", "Worker disconnected before acceptance");
      }
    }
    for (const task of this.repo.queued()) {
      if (this.deadlineReached(task, now)) this.transition(task, "REJECTED", now, "system", "Task deadline expired before acceptance");
    }
  }
  private deadlineReached(task: StoredTask, now: number) {
    return task.spec.deadline !== undefined && Date.parse(task.spec.deadline) <= now;
  }
  private dispatch(now: number) {
    const free = this.repo.online(now).filter((worker) => worker.enabled && !this.repo.assigned(worker.id));
    if (!free.length) return;
    for (const [index, task] of this.repo.queued().filter((task) => !this.deadlineReached(task, now)).slice(0, free.length).entries()) {
      const worker = free[index]!;
      this.transition({ ...task, worker: worker.id, offerId: randomUUID(), offerUntil: now + this.offerMs }, "OFFERED", now, "system");
    }
  }
  private credentials(human: Human): Worker {
    const worker = this.repo.worker(human.worker);
    return worker && tokenMatches(worker.secret, human.secret) ? worker : fail("UNAUTHORIZED", "Invalid worker credentials");
  }
  private session(human: Human, now: number): Lease {
    this.credentials(human);
    const lease = this.repo.lease(human.session);
    return lease?.worker === human.worker && lease.until > now ? lease : fail("OFFLINE", "Connect or renew your session first");
  }
  private owned(secret: string, taskId: string): StoredTask {
    const task = this.repo.task(taskId);
    return task && tokenMatches(task.owner, secret) ? task : fail("NOT_FOUND", "Task not found");
  }
  private assigned(human: Human, taskId: string): StoredTask {
    const task = this.repo.task(taskId);
    return task?.worker === human.worker ? task : fail("NOT_FOUND", "Task not found");
  }
  private stateFor(worker: Worker, task: StoredTask | null): Availability {
    if (task?.state === "BLOCKED") return "BLOCKED";
    if (task && task.state !== "OFFERED") return "WORKING";
    return worker.enabled ? "AVAILABLE" : "PAUSED";
  }
  private snapshot(human: Human): Snapshot {
    const worker = this.credentials(human);
    const lease = this.repo.lease(human.session)!;
    const task = this.repo.assigned(human.worker);
    return { worker: worker.id, availability: this.stateFor(worker, task), offersEnabled: worker.enabled, task: task && visible(task), leaseUntil: lease.until };
  }

  connect(human: Human, available: boolean) {
    this.run((now) => {
      const existing = this.repo.worker(human.worker);
      const worker = existing ? this.credentials(human) : { id: human.worker, secret: digest(human.secret), enabled: false };
      const session = this.repo.lease(human.session);
      if (session && session.worker !== worker.id) fail("UNAUTHORIZED", "Session is already in use");
      this.repo.saveWorker({ ...worker, enabled: worker.enabled || available });
      this.repo.saveLease({ id: human.session, worker: worker.id, until: now + this.leaseMs });
    });
    return this.snapshot(human);
  }
  heartbeat(human: Human) {
    this.run((now) => this.repo.saveLease({ ...this.session(human, now), until: now + this.leaseMs }));
    return this.snapshot(human);
  }
  availability(human: Human, enabled: boolean) {
    this.run((now) => {
      this.session(human, now);
      const worker = this.credentials(human);
      this.repo.saveWorker({ ...worker, enabled });
      const task = this.repo.assigned(worker.id);
      if (!enabled && task?.state === "OFFERED") this.transition(task, "QUEUED", now, "human", "Worker paused");
    });
    return this.snapshot(human);
  }
  disconnect(human: Human) {
    return this.run((now) => {
      const worker = this.credentials(human);
      const lease = this.repo.lease(human.session);
      if (lease?.worker === worker.id) this.repo.removeLease(lease.id);
      if (!this.repo.hasLease(worker.id, now)) this.repo.saveWorker({ ...worker, enabled: false });
      this.reconcile(now);
      return { disconnected: true };
    });
  }

  delegate(secret: string, spec: Delegation) {
    return this.run((now) => {
      const owner = digest(secret);
      const existing = this.repo.request(owner, spec.requestId);
      if (existing) {
        if (canonical(existing.spec) !== canonical(spec)) fail("CONFLICT", "Request ID already used with a different payload");
        return { taskId: existing.id };
      }
      if (spec.workspace && !this.workspaces.knows(spec.workspace.repository)) fail("BAD_REPOSITORY", "Repository alias is not configured");
      if (spec.expectedOutputSchema) validator(spec.expectedOutputSchema);
      if (spec.deadline && Date.parse(spec.deadline) <= now) fail("EXPIRED", "Deadline must be in the future");
      const task: StoredTask = { id: randomUUID(), owner, spec, state: "QUEUED", worker: null, offerUntil: null,
        offerId: null, workspacePath: null, commit: null, revision: 1, createdAt: now, acceptedAt: null, updatedAt: now };
      this.repo.saveTask(task);
      this.repo.event(task.id, now, { type: "transition", actor: "parent", from: null, to: "QUEUED" });
      return { taskId: task.id };
    });
  }
  status(secret: string, id: string) {
    this.tick();
    const task = this.owned(secret, id);
    return { ...visible(task), availability: task.worker ? this.workerAvailability(task.worker) : null };
  }
  private workerAvailability(id: string): Availability {
    const worker = this.repo.worker(id);
    if (!worker || !this.repo.hasLease(id, this.now())) return "OFFLINE";
    return this.stateFor(worker, this.repo.assigned(id));
  }
  availableHumans() {
    this.tick();
    return this.repo.online(this.now()).filter((worker) => worker.enabled && !this.repo.assigned(worker.id))
      .map(({ id }) => ({ id, availability: "AVAILABLE" as const }));
  }
  parentEvents(secret: string, id: string, after: number, limit: number) {
    this.owned(secret, id);
    return this.eventPage(id, after, limit);
  }
  humanEvents(human: Human, id: string, after: number, limit: number) {
    this.session(human, this.now());
    this.assigned(human, id);
    return this.eventPage(id, after, limit);
  }
  private eventPage(id: string, after: number, limit: number) {
    const rows = this.repo.events(id, after, limit + 1);
    const events = rows.slice(0, limit);
    return { events, nextCursor: events.at(-1)?.seq ?? after, hasMore: rows.length > limit };
  }
  history(human: Human, limit: number) {
    this.session(human, this.now());
    return this.repo.history(human.worker, limit).map(visible);
  }
  result(secret: string, id: string, submissionId?: string) {
    const task = this.owned(secret, id);
    const entry = submissionId ? this.repo.submission(id, submissionId) : this.repo.latestSubmission(id, task.revision);
    return { state: task.state, revision: task.revision, submission: entry?.data ?? null };
  }
  cancel(secret: string, id: string, detail: string, unacceptedOnly: boolean) {
    return this.run((now) => {
      const task = this.owned(secret, id);
      if (unacceptedOnly && task.acceptedAt != null) fail("ALREADY_ACCEPTED", "Human already accepted this task");
      if (task.state === "CANCELLED" || task.state === "REJECTED") return visible(task);
      if (unacceptedOnly && task.state !== "QUEUED" && task.state !== "OFFERED") fail("ALREADY_ACCEPTED", "Human already accepted this task");
      return visible(this.transition(task, "CANCELLED", now, "parent", detail));
    });
  }
  parentMessage(secret: string, id: string, text: string) {
    return this.run((now) => {
      const task = this.owned(secret, id);
      if (terminal.includes(task.state)) fail("INVALID_STATE", "Task is closed");
      this.repo.event(id, now, { type: "message", actor: "parent", text });
      if (task.state === "BLOCKED") this.transition(task, "WORKING", now, "parent", "Parent replied");
      return { sent: true };
    });
  }
  question(human: Human, id: string, text: string) {
    return this.run((now) => {
      this.session(human, now);
      const task = this.assigned(human, id);
      if (task.state !== "BLOCKED") this.transition(task, "BLOCKED", now, "human", "Asked parent a question");
      this.repo.event(id, now, { type: "question", actor: "human", text });
      return { sent: true };
    });
  }
  private checkOffer(human: Human, id: string, offerId: string, now: number) {
    this.session(human, now);
    const task = this.assigned(human, id);
    if (task.state !== "OFFERED" || task.offerId !== offerId || task.offerUntil! <= now || this.deadlineReached(task, now)) {
      fail("STALE_OFFER", "This offer is no longer current");
    }
    return task;
  }
  reject(human: Human, id: string, offerId: string, detail: string) {
    return this.run((now) => visible(this.transition(this.checkOffer(human, id, offerId, now), "REJECTED", now, "human", detail)));
  }
  accept(human: Human, id: string, offerId: string) {
    const task = this.run((now) => {
      const offered = this.checkOffer(human, id, offerId, now);
      const accepted = this.transition({ ...offered, acceptedAt: now }, "ACCEPTED", now, "human");
      return accepted.spec.workspace ? accepted : this.transition(accepted, "WORKING", now, "system");
    });
    return task.spec.workspace ? this.prepare(task) : Promise.resolve(visible(task));
  }
  retryWorkspace(human: Human, id: string) {
    this.session(human, this.now());
    const task = this.assigned(human, id);
    if (task.state !== "ACCEPTED" || !task.spec.workspace) fail("INVALID_STATE", "No workspace setup is pending");
    return this.prepare(task);
  }
  private async prepareWorkspace(task: StoredTask) {
    const spec = task.spec.workspace!;
    try {
      const commit = task.commit ?? await this.workspaces.resolve(spec);
      const reserve = this.run((now) => {
        const current = this.repo.task(task.id)!;
        if (current.state !== "ACCEPTED") return false;
        this.repo.saveTask({ ...current, commit, updatedAt: now });
        return true;
      });
      if (!reserve) return visible(this.repo.task(task.id)!);
      const path = await this.workspaces.provision(task.id, spec.repository, commit);
      return this.run((now) => {
        const current = this.repo.task(task.id)!;
        const withPath = { ...current, workspacePath: path, updatedAt: now };
        const ready = current.state === "ACCEPTED" ? this.transition(withPath, "WORKING", now, "system") : withPath;
        if (current.state !== "ACCEPTED") this.repo.saveTask(ready);
        this.repo.event(task.id, now, { type: "workspace_ready", actor: "system", path });
        return visible(ready);
      });
    } catch (error) {
      const message = error instanceof DomainError ? error.message : "Workspace setup failed";
      this.run((now) => {
        if (this.repo.task(task.id)?.state === "ACCEPTED") {
          this.repo.event(task.id, now, { actor: "system", type: "workspace_error", text: message });
        }
      });
      return fail("WORKSPACE", message);
    }
  }
  private prepare(task: StoredTask) {
    const pending = this.preparations.get(task.id);
    if (pending) return pending;
    const preparation = this.prepareWorkspace(task).finally(() => this.preparations.delete(task.id));
    this.preparations.set(task.id, preparation);
    return preparation;
  }
  abandon(human: Human, id: string, detail: string) {
    return this.run((now) => {
      this.session(human, now);
      return visible(this.transition(this.assigned(human, id), "FAILED", now, "human", detail));
    });
  }
  submit(human: Human, id: string, data: Submission): Receipt {
    return this.run((now) => {
      this.session(human, now);
      const task = this.assigned(human, id);
      const saved = this.repo.submission(id, data.submissionId);
      if (saved) {
        if (canonical(saved.data) !== canonical(data)) fail("CONFLICT", "Submission ID already used with a different payload");
        return saved.receipt;
      }
      if (task.revision !== data.revision) fail("STALE_REVISION", "Submission revision is stale");
      if (task.spec.expectedOutputSchema && !validator(task.spec.expectedOutputSchema)(data.output)) {
        fail("BAD_OUTPUT", "Output does not match the expected schema");
      }
      this.transition(task, "SUBMITTED", now, "human");
      const receipt = { taskId: id, revision: data.revision, submissionId: data.submissionId, state: "SUBMITTED" as const };
      this.repo.saveSubmission(id, data, receipt);
      this.repo.event(id, now, { type: "submission", actor: "human", revision: data.revision, submissionId: data.submissionId });
      return receipt;
    });
  }
  review(secret: string, id: string, submissionId: string, action: "review" | "reopen" | "complete", detail?: string) {
    return this.run((now) => {
      const task = this.owned(secret, id);
      if (this.repo.latestSubmission(id, task.revision)?.data.submissionId !== submissionId) {
        fail("STALE_REVISION", "Review must target the current submission");
      }
      if (task.state !== "SUBMITTED" && task.state !== "REVIEWING") fail("INVALID_STATE", "Task is not awaiting review");
      if (action === "review" && task.state === "REVIEWING") return visible(task);
      const next = { review: "REVIEWING", reopen: "WORKING", complete: "COMPLETED" } as const;
      if (detail) this.repo.event(id, now, { type: "feedback", actor: "parent", text: detail });
      const updated = { ...task, revision: task.revision + Number(action === "reopen") };
      return visible(this.transition(updated, next[action], now, "parent"));
    });
  }
}
