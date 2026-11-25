import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
export const taskId = z.uuid();
export const token = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
export const text = z.string().trim().min(1).max(8_192);
export const workspace = z.strictObject({ repository: id, ref: z.string().min(1).max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/) });
const jsonObject = z.record(z.string(), z.json());
export const delegation = z.strictObject({
  requestId: id,
  title: z.string().trim().min(1).max(160),
  instructions: text,
  context: text.optional(),
  parentId: id,
  parentTaskId: id.optional(),
  workspace: workspace.optional(),
  deadline: z.iso.datetime({ offset: true }).optional(),
  timeBudgetMinutes: z.int().min(1).max(10_080).optional(),
  allowedTools: z.array(id).max(32).optional(),
  expectedOutputSchema: jsonObject.optional(),
});
export const submission = z.strictObject({
  submissionId: id, revision: z.int().min(1),
  summary: text,
  evidence: z.array(text.max(2_048)).max(16).default([]),
  gitRef: z.string().trim().min(1).max(256).optional(),
  diff: z.string().max(32_768).optional(),
  output: z.json().optional(),
});
export const taskStates = ["QUEUED", "OFFERED", "ACCEPTED", "WORKING", "BLOCKED", "SUBMITTED",
  "REVIEWING", "COMPLETED", "REJECTED", "CANCELLED", "FAILED"] as const;
export type TaskState = typeof taskStates[number];
export type Availability = "AVAILABLE" | "OFFLINE" | "PAUSED" | "WORKING" | "BLOCKED";
export type Delegation = z.infer<typeof delegation>;
export type Submission = z.infer<typeof submission>;
export type Task = {
  id: string;
  spec: Delegation;
  state: TaskState;
  worker: string | null;
  offerUntil: number | null;
  offerId: string | null;
  workspacePath: string | null;
  commit: string | null;
  revision: number;
  createdAt: number;
  acceptedAt: number | null;
  updatedAt: number;
};
export type TaskEvent = {
  seq: number;
  taskId: string;
  at: number;
  actor: "system" | "human" | "parent";
} & (
  | { type: "transition"; from: TaskState | null; to: TaskState; detail?: string }
  | { type: "question" | "message" | "feedback" | "workspace_error"; text: string }
  | { type: "submission"; revision: number; submissionId: string }
  | { type: "workspace_ready"; path: string }
);
export type EventData = TaskEvent extends infer E
  ? E extends TaskEvent ? Omit<E, "seq" | "taskId" | "at"> : never : never;
export type Receipt = { taskId: string; revision: number; submissionId: string; state: "SUBMITTED" };
export type Snapshot = { worker: string; availability: Availability; task: Task | null; offersEnabled: boolean; leaseUntil: number };
export const occupying: readonly TaskState[] = ["OFFERED", "ACCEPTED", "WORKING", "BLOCKED", "SUBMITTED", "REVIEWING"];
export const terminal: readonly TaskState[] = ["COMPLETED", "REJECTED", "CANCELLED", "FAILED"];
const transitions: Record<TaskState, readonly TaskState[]> = {
  QUEUED: ["OFFERED", "CANCELLED", "REJECTED"],
  OFFERED: ["QUEUED", "ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["WORKING", "FAILED", "CANCELLED"],
  WORKING: ["BLOCKED", "SUBMITTED", "FAILED", "CANCELLED"],
  BLOCKED: ["WORKING", "SUBMITTED", "FAILED", "CANCELLED"],
  SUBMITTED: ["REVIEWING", "WORKING", "COMPLETED", "CANCELLED"],
  REVIEWING: ["WORKING", "COMPLETED", "CANCELLED"],
  COMPLETED: [], REJECTED: [], CANCELLED: [], FAILED: [],
};
export class DomainError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function checkTransition(from: TaskState, to: TaskState) {
  if (!transitions[from].includes(to)) throw new DomainError("INVALID_STATE", `Cannot move task from ${from} to ${to}`);
}
export function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function tokenMatches(hash: string, secret: string) {
  return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(digest(secret), "hex"));
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
