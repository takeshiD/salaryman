import { z } from "zod";
import { delegation, DomainError, id, submission, taskId, text, token } from "./model";
import type { AgentService, Human } from "./service";

const task = { taskId };
const events = z.strictObject({ ...task, after: z.int().nonnegative().default(0), limit: z.int().min(1).max(30).default(30) });
const empty = z.strictObject({});
const human = z.strictObject({ worker: id, secret: token, session: z.uuid() });
const offer = { ...task, offerId: z.uuid() };
const review = { ...task, submissionId: id };
const reason = z.string().trim().min(1).max(1_000);

function procedure<Auth, Schema extends z.ZodType, R>(
  auth: z.ZodType<Auth>, schema: Schema, execute: (service: AgentService, auth: Auth, args: z.output<Schema>) => R,
) {
  return { schema, run: (service: AgentService, rawAuth: unknown, rawArgs: unknown) =>
    execute(service, auth.parse(rawAuth), schema.parse(rawArgs)) };
}
const parent = <S extends z.ZodType, R>(schema: S, execute: (service: AgentService, auth: string, args: z.output<S>) => R) =>
  procedure(token, schema, execute);
const worker = <S extends z.ZodType, R>(schema: S, execute: (service: AgentService, auth: Human, args: z.output<S>) => R) =>
  procedure(human, schema, execute);

export const parentRoutes = {
  delegate_to_human: parent(delegation, (s, a, p) => s.delegate(a, p)),
  list_available_humans: parent(empty, (s) => s.availableHumans()),
  get_human_status: parent(z.strictObject(task), (s, a, p) => s.status(a, p.taskId)),
  message_human: parent(z.strictObject({ ...task, text }), (s, a, p) => s.parentMessage(a, p.taskId, p.text)),
  get_human_result: parent(z.strictObject({ ...task, submissionId: id.optional() }), (s, a, p) => s.result(a, p.taskId, p.submissionId)),
  cancel_human_task: parent(z.strictObject({ ...task, reason, unacceptedOnly: z.boolean().default(true) }),
    (s, a, p) => s.cancel(a, p.taskId, p.reason, p.unacceptedOnly)),
  get_task_events: parent(events, (s, a, p) => s.parentEvents(a, p.taskId, p.after, p.limit)),
  review_human_task: parent(z.strictObject(review), (s, a, p) => s.review(a, p.taskId, p.submissionId, "review")),
  reopen_human_task: parent(z.strictObject({ ...review, feedback: text }),
    (s, a, p) => s.review(a, p.taskId, p.submissionId, "reopen", p.feedback)),
  complete_human_task: parent(z.strictObject({ ...review, feedback: text.optional() }),
    (s, a, p) => s.review(a, p.taskId, p.submissionId, "complete", p.feedback)),
};
export const humanRoutes = {
  connect: worker(z.strictObject({ available: z.boolean().default(false) }), (s, a, p) => s.connect(a, p.available)),
  heartbeat: worker(empty, (s, a) => s.heartbeat(a)),
  availability: worker(z.strictObject({ enabled: z.boolean() }), (s, a, p) => s.availability(a, p.enabled)),
  disconnect: worker(empty, (s, a) => s.disconnect(a)),
  accept: worker(z.strictObject(offer), (s, a, p) => s.accept(a, p.taskId, p.offerId)),
  reject: worker(z.strictObject({ ...offer, reason }), (s, a, p) => s.reject(a, p.taskId, p.offerId, p.reason)),
  ask: worker(z.strictObject({ ...task, text }), (s, a, p) => s.question(a, p.taskId, p.text)),
  abandon: worker(z.strictObject({ ...task, reason }), (s, a, p) => s.abandon(a, p.taskId, p.reason)),
  workspace: worker(z.strictObject(task), (s, a, p) => s.retryWorkspace(a, p.taskId)),
  submit: worker(z.strictObject({ ...task, submission }), (s, a, p) => s.submit(a, p.taskId, p.submission)),
  human_events: worker(events, (s, a, p) => s.humanEvents(a, p.taskId, p.after, p.limit)),
  history: worker(z.strictObject({ limit: z.int().min(1).max(20).default(10) }), (s, a, p) => s.history(a, p.limit)),
};
const routes = { ...parentRoutes, ...humanRoutes };
export type ParentMethod = keyof typeof parentRoutes;
export type HumanMethod = keyof typeof humanRoutes;
type Method = keyof typeof routes;
export type Params<M extends Method> = z.input<typeof routes[M]["schema"]>;
export type Result<M extends Method> = Awaited<ReturnType<typeof routes[M]["run"]>>;

const envelope = z.strictObject({ v: z.literal(1), method: z.string().max(48), auth: z.unknown(), params: z.unknown() });
export function dispatch(service: AgentService, frame: unknown) {
  const request = envelope.parse(frame);
  if (!Object.hasOwn(routes, request.method)) throw new DomainError("NO_METHOD", "Unknown RPC method");
  return routes[request.method as Method].run(service, request.auth, request.params);
}
