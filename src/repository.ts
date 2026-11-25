import type { EventData, Receipt, Submission, Task, TaskEvent } from "./model";

export interface Worker { id: string; secret: string; enabled: boolean }
export interface Lease { id: string; worker: string; until: number }
export type StoredTask = Task & { owner: string };
export interface SavedSubmission { data: Submission; receipt: Receipt }

export interface Repository {
  transaction<T>(operation: () => T): T;
  task(id: string): StoredTask | null;
  request(owner: string, requestId: string): StoredTask | null;
  saveTask(task: StoredTask): void;
  queued(): StoredTask[];
  offered(): StoredTask[];
  assigned(worker: string): StoredTask | null;
  history(worker: string, limit: number): StoredTask[];
  worker(id: string): Worker | null;
  online(now: number): Worker[];
  saveWorker(worker: Worker): void;
  lease(id: string): Lease | null;
  saveLease(lease: Lease): void;
  removeLease(id: string): void;
  expireLeases(now: number): void;
  resetLeases(): void;
  hasLease(worker: string, now: number): boolean;
  event(taskId: string, at: number, data: EventData): void;
  events(taskId: string, after: number, limit: number): TaskEvent[];
  submission(taskId: string, submissionId: string): SavedSubmission | null;
  latestSubmission(taskId: string, revision: number): SavedSubmission | null;
  saveSubmission(taskId: string, data: Submission, receipt: Receipt): void;
}
