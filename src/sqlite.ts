import { Database } from "bun:sqlite";
import { occupying, type EventData, type Receipt, type Submission, type TaskEvent } from "./model";
import type { Lease, Repository, SavedSubmission, StoredTask, Worker } from "./repository";

type JsonRow = { data: string };
const active = occupying.map((state) => `'${state}'`).join(",");
const decode = <T>(row: JsonRow | null): T | null => row ? JSON.parse(row.data) as T : null;
const decodeAll = <T>(rows: JsonRow[]): T[] => rows.map((row) => JSON.parse(row.data) as T);
export class SqliteRepository implements Repository {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL,
        state TEXT NOT NULL, worker TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
        data TEXT NOT NULL, UNIQUE(owner, request_id)
      );
      CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state, created);
      CREATE INDEX IF NOT EXISTS tasks_worker ON tasks(worker, updated);
      CREATE UNIQUE INDEX IF NOT EXISTS one_assignment ON tasks(worker)
        WHERE state IN (${active});
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY, secret TEXT NOT NULL, enabled INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY, worker TEXT NOT NULL REFERENCES workers(id), "until" INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lease_worker ON leases(worker, "until");
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        at INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id,seq);
      CREATE TABLE IF NOT EXISTS submissions (
        task_id TEXT NOT NULL REFERENCES tasks(id), id TEXT NOT NULL, revision INTEGER NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY(task_id,id), UNIQUE(task_id,revision)
      );
    `);
  }

  close() { this.db.close(); }
  transaction<T>(operation: () => T): T { return this.db.transaction(operation).immediate(); }
  task(id: string) { return decode<StoredTask>(this.db.query<JsonRow, [string]>("SELECT data FROM tasks WHERE id=?").get(id)); }
  request(owner: string, requestId: string) { return decode<StoredTask>(this.db.query<JsonRow, [string, string]>(
    "SELECT data FROM tasks WHERE owner=? AND request_id=?").get(owner, requestId)); }
  saveTask(task: StoredTask) {
    this.db.query(`INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      state=excluded.state, worker=excluded.worker, updated=excluded.updated, data=excluded.data`)
      .run(task.id, task.owner, task.spec.requestId, task.state, task.worker, task.createdAt, task.updatedAt, JSON.stringify(task));
  }
  queued() { return decodeAll<StoredTask>(this.db.query<JsonRow, []>("SELECT data FROM tasks WHERE state='QUEUED' ORDER BY created,rowid").all()); }
  offered() { return decodeAll<StoredTask>(this.db.query<JsonRow, []>("SELECT data FROM tasks WHERE state='OFFERED'").all()); }
  assigned(worker: string) { return decode<StoredTask>(this.db.query<JsonRow, [string]>(
    `SELECT data FROM tasks WHERE worker=? AND state IN (${active})`).get(worker)); }
  history(worker: string, limit: number) { return decodeAll<StoredTask>(this.db.query<JsonRow, [string, number]>(
    `SELECT data FROM tasks WHERE worker=? AND state NOT IN (${active}) ORDER BY updated DESC,rowid DESC LIMIT ?`).all(worker, limit)); }
  worker(id: string) {
    const row = this.db.query<{ id: string; secret: string; enabled: number }, [string]>("SELECT * FROM workers WHERE id=?").get(id);
    return row && { ...row, enabled: Boolean(row.enabled) };
  }
  online(now: number) {
    return this.db.query<{ id: string; secret: string; enabled: number }, [number]>(
      'SELECT * FROM workers WHERE EXISTS(SELECT 1 FROM leases WHERE worker=workers.id AND "until">?) ORDER BY id').all(now)
      .map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
  }
  saveWorker(worker: Worker) { this.db.query("INSERT INTO workers VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled")
    .run(worker.id, worker.secret, Number(worker.enabled)); }
  lease(id: string) { return this.db.query<Lease, [string]>("SELECT * FROM leases WHERE id=?").get(id); }
  saveLease(lease: Lease) { this.db.query('INSERT INTO leases VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET "until"=excluded."until"')
    .run(lease.id, lease.worker, lease.until); }
  removeLease(id: string) { this.db.query("DELETE FROM leases WHERE id=?").run(id); }
  expireLeases(now: number) { this.db.query(`UPDATE workers SET enabled=0 WHERE enabled=1 AND
    NOT EXISTS(SELECT 1 FROM leases WHERE worker=workers.id AND "until">?)`).run(now);
    this.db.query('DELETE FROM leases WHERE "until"<=?').run(now); }
  resetLeases() { this.db.exec("DELETE FROM leases; UPDATE workers SET enabled=0"); }
  hasLease(worker: string, now: number) {
    return Boolean(this.db.query('SELECT 1 FROM leases WHERE worker=? AND "until">? LIMIT 1').get(worker, now));
  }
  event(taskId: string, at: number, data: EventData) {
    this.db.query("INSERT INTO events(task_id,at,data) VALUES (?,?,?)").run(taskId, at, JSON.stringify(data));
  }
  events(taskId: string, after: number, limit: number) {
    return this.db.query<{ seq: number; at: number; data: string }, [string, number, number]>(
      "SELECT seq,at,data FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?").all(taskId, after, limit)
      .map((row): TaskEvent => ({ ...JSON.parse(row.data) as EventData, seq: row.seq, at: row.at, taskId }));
  }
  submission(taskId: string, submissionId: string) { return decode<SavedSubmission>(this.db.query<JsonRow, [string, string]>(
    "SELECT data FROM submissions WHERE task_id=? AND id=?").get(taskId, submissionId)); }
  latestSubmission(taskId: string, revision: number) { return decode<SavedSubmission>(this.db.query<JsonRow, [string, number]>(
    "SELECT data FROM submissions WHERE task_id=? AND revision=?").get(taskId, revision)); }
  saveSubmission(taskId: string, data: Submission, receipt: Receipt) {
    this.db.query("INSERT INTO submissions VALUES (?,?,?,?)").run(taskId, data.submissionId, data.revision, JSON.stringify({ data, receipt }));
  }
}
