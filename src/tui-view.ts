import type { Task, TaskEvent, TaskState } from "./model";

export type Tone = "body" | "title" | "label" | "muted" | "accent" | "attention" | "review" | "error";
export type Segment = [text: string, tone?: Tone];

export const utcDate = (milliseconds: number) => new Date(milliseconds).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");

const states: Record<TaskState, [string, Tone]> = {
  QUEUED: ["Queued", "muted"],
  OFFERED: ["Task offer", "attention"],
  ACCEPTED: ["Preparing workspace", "accent"],
  WORKING: ["In progress", "accent"],
  BLOCKED: ["Waiting for parent", "attention"],
  SUBMITTED: ["Submitted for review", "review"],
  REVIEWING: ["Under review", "review"],
  COMPLETED: ["Completed", "accent"],
  REJECTED: ["Declined", "muted"],
  CANCELLED: ["Cancelled", "muted"],
  FAILED: ["Abandoned", "muted"],
};

export function taskBrief(task: Task): Segment[] {
  const spec = task.spec;
  const [state, tone] = states[task.state];
  const rework = task.state === "WORKING" && task.revision > 1;
  const parent = [spec.parentId, spec.parentTaskId].filter(Boolean).join(" / ");
  const rows: Segment[] = [
    [spec.title + "\n", "title"],
    [rework ? "Changes requested" : state, rework ? "review" : tone],
    [task.revision > 1 ? `  ·  Revision ${task.revision}\n` : "\n", "muted"],
  ];
  function section(heading: string, content: string) {
    rows.push([`\n${heading}\n`, "label"], [content + "\n"]);
  }
  if (task.offerUntil) rows.push([`Accept by ${utcDate(task.offerUntil)}\n`, "attention"]);
  if (spec.deadline) rows.push([`Deadline ${utcDate(Date.parse(spec.deadline))}\n`, "muted"]);
  section("Instructions", spec.instructions);
  if (spec.expectedOutputSchema) section("Expected output", JSON.stringify(spec.expectedOutputSchema, null, 2));
  if (spec.context) section("Context", spec.context);
  if (spec.workspace) {
    section("Workspace", `${spec.workspace.repository} @ ${spec.workspace.ref}`);
    if (task.workspacePath) rows.push([task.workspacePath + "\n"], [`Base  ${task.commit}\n`, "muted"]);
  }
  if (spec.timeBudgetMinutes) rows.push([`\nTime budget  ${spec.timeBudgetMinutes} min (advisory)\n`, "muted"]);
  rows.push(["\nTask details\n", "label"], ["Parent  ", "label"], [parent + "\n"], ["Task ID  ", "label"], [task.id + "\n"]);
  if (spec.allowedTools) rows.push(["Declared tools  ", "label"], [spec.allowedTools.join(", ") || "None"]);
  return rows;
}

export function isParentUpdate(event: TaskEvent) {
  return event.actor === "parent" && (event.type === "message" || event.type === "feedback");
}

export function isConversation(event: TaskEvent) {
  return isParentUpdate(event) || event.type === "question";
}

export function feedContent(events: TaskEvent[], mode: "updates" | "activity", loading: boolean, openedThrough: number): Segment[] {
  if (!events.length) {
    if (loading) return [["Loading task updates…", "muted"]];
    return [[mode === "updates" ? "No updates from the parent yet." : "No activity yet.", "muted"]];
  }
  const rows: Segment[] = [];
  for (const event of events.toReversed()) {
    let heading: string;
    let tone: Tone = "label";
    let body: string | undefined;
    switch (event.type) {
      case "message": heading = "Parent message"; tone = "accent"; body = event.text; break;
      case "feedback": heading = "Review feedback"; tone = "review"; body = event.text; break;
      case "question": heading = "Your question"; body = event.text; break;
      case "transition": heading = states[event.to][0]; tone = states[event.to][1]; body = event.detail; break;
      case "submission": heading = `Submitted revision ${event.revision}`; body = event.submissionId; break;
      case "workspace_ready": heading = "Workspace ready"; body = event.path; break;
      case "workspace_error": heading = "Workspace setup failed"; tone = "error"; body = event.text; break;
    }
    if (rows.length) rows.push(["\n"]);
    rows.push([heading, tone], [`  ${utcDate(event.at).slice(5, 16)}`, "muted"]);
    if (isParentUpdate(event) && event.seq > openedThrough) rows.push(["  NEW", "attention"]);
    rows.push(["\n"]);
    if (body) rows.push([body + "\n"]);
  }
  return rows;
}
