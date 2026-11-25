import {
  BoxRenderable, CliRenderEvents, createCliRenderer, ScrollBoxRenderable, TextareaRenderable, TextRenderable,
  type KeyEvent,
} from "@opentui/core";
import type { LocalClient } from "./ipc";
import { DomainError, submission, type Snapshot, type Task, type TaskEvent } from "./model";
import type { Human } from "./service";

const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
const errorText = (error: unknown) => error instanceof Error ? clean(error.message) : "Unexpected error";
const date = (milliseconds: number) => new Date(milliseconds).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");

function describe(task: Task, displayedAvailability?: string) {
  return [
    task.spec.title,
    [task.state !== displayedAvailability ? task.state : "", `Revision ${task.revision}`].filter(Boolean).join("   /   "),
    `Task   ${task.id}`,
    `Parent ${task.spec.parentId}${task.spec.parentTaskId ? " / " + task.spec.parentTaskId : ""}`,
    task.offerUntil ? `Offer expires   ${date(task.offerUntil)}` : "",
    task.spec.deadline ? `Deadline   ${date(Date.parse(task.spec.deadline))}` : "",
    task.spec.timeBudgetMinutes ? `Time budget   ${task.spec.timeBudgetMinutes} min (advisory)` : "",
    task.spec.allowedTools ? `Declared tools   ${task.spec.allowedTools.join(", ") || "none"}` : "",
    task.spec.workspace ? `Repository   ${task.spec.workspace.repository} @ ${task.spec.workspace.ref}` : "",
    task.workspacePath ? `Workspace   ${task.workspacePath}\nBase   ${task.commit}` : "",
    "\nInstructions", task.spec.instructions,
    task.spec.context ? "\nScoped context\n" + task.spec.context : "",
    task.spec.expectedOutputSchema ? "\nExpected output (JSON)\n" + JSON.stringify(task.spec.expectedOutputSchema, null, 2) : "",
  ].filter((value) => value !== "").join("\n");
}

function eventText(event: TaskEvent) {
  const prefix = `${date(event.at).slice(11, 19)}  ${event.actor}`;
  switch (event.type) {
    case "transition": return `${prefix} · ${event.to}${event.detail ? "\n" + event.detail : ""}`;
    case "submission": return `${prefix} · Submitted revision ${event.revision}\n${event.submissionId}`;
    case "workspace_ready": return `${prefix} · Workspace ready\n${event.path}`;
    default: return `${prefix} · ${event.type.replaceAll("_", " ")}\n${event.text}`;
  }
}

type View = "task" | "messages" | "history";
type FormKind = "ask" | "reject" | "submit" | "json" | "abandon";
type Draft = { kind: FormKind; task: Task; initial: string; submissionId: string };

export async function attach(client: LocalClient, human: Human, available: boolean) {
  const noColor = process.env.NO_COLOR !== undefined;
  const accent = noColor ? undefined : "#75d5bd";
  const dim = noColor ? undefined : "#a8aeb8";
  const renderer = await createCliRenderer({ useMouse: false, useKittyKeyboard: null, exitOnCtrlC: false,
    screenMode: "alternate-screen", consoleMode: "disabled", openConsoleOnError: false });
  const done = new Promise<void>((resolve) => renderer.once(CliRenderEvents.DESTROY, resolve));
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshPending: Promise<void> | undefined;
  try {
    const { root } = renderer;
    root.flexDirection = "column";
    root.paddingLeft = 1;
    root.paddingRight = 1;
    function label(id: string, fg?: string) {
      return new TextRenderable(renderer, { id, fg, wrapMode: "word", flexShrink: 0, width: "100%" });
    }
    const header = label("header", accent);
    const status = label("status", dim);
    const body = new BoxRenderable(renderer, { id: "body", flexGrow: 1, minHeight: 0, gap: 2 });
    function pane(id: string) {
      const box = new ScrollBoxRenderable(renderer, { id, flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0,
        focusable: false, scrollY: true, verticalScrollbarOptions: { visible: false } });
      const content = label(id + "-content");
      box.add(content);
      body.add(box);
      return { box, content };
    }
    const taskPane = pane("task");
    const messages = pane("messages");
    const form = new BoxRenderable(renderer, { id: "form", flexGrow: 1, minHeight: 0, flexDirection: "column", visible: false });
    const formTitle = label("form-title", accent);
    const input = new TextareaRenderable(renderer, { id: "draft", flexGrow: 1, width: "100%", wrapMode: "word",
      placeholder: "Type or paste here" });
    form.add(formTitle);
    form.add(input);
    const notice = label("notice", dim);
    const keys = label("keys", accent);
    for (const element of [header, status, body, form, notice, keys]) root.add(element);

    let snapshot: Snapshot | undefined;
    let view: View = "task";
    let stopped = false;
    let busy = false;
    let needsConnect = true;
    let initialOptIn = available;
    let networkError = "";
    let hint = "";
    let lastTask = "";
    let eventId = "";
    let cursor = 0;
    let events: TaskEvent[] = [];
    let history: Task[] = [];
    let selected: Task | undefined;
    let draft: Draft | undefined;
    const drafts = new Map<string, Draft>();
    const set = (label: TextRenderable, value: string) => {
      const sanitized = clean(value);
      if (label.plainText !== sanitized) label.content = sanitized;
    };
    const taskForView = () => selected ?? snapshot?.task ?? null;
    function render() {
      if (stopped) return;
      const width = renderer.width;
      const height = renderer.height;
      const compact = width < 44 || height < 12;
      const wide = width >= 100 && height >= 24;
      const task = taskForView();
      set(header, `doormat    ${human.worker}  /  ${networkError ? "OFFLINE" : snapshot?.availability ?? "CONNECTING"}`);
      const showOfferPolicy = !!snapshot?.task && snapshot.task.state !== "OFFERED";
      set(status, showOfferPolicy ? `Offers after this task   ${snapshot!.offersEnabled ? "enabled" : "paused"}` : "");
      status.visible = !compact && showOfferPolicy;
      body.visible = !compact && !draft;
      form.visible = !compact && !!draft;
      body.flexDirection = wide ? "row" : "column";
      taskPane.box.visible = view !== "messages" || wide;
      messages.box.visible = view !== "history" && (!!task && (wide || view === "messages"));
      if (view === "history") {
        set(taskPane.content, "Recent assignments\n\n" + (history.length
          ? history.map((old, i) => `${i + 1}  ${old.state.padEnd(10)} ${old.spec.title}\n    ${date(old.updatedAt)}`).join("\n")
          : "Your completed, declined, or cancelled assignments will appear here."));
      } else {
        set(taskPane.content, task ? describe(task, selected || networkError ? undefined : snapshot?.availability) : (snapshot?.offersEnabled
          ? "Waiting for a task offer." : "Press p to receive task offers."));
      }
      const previous = messages.box.scrollHeight;
      const follow = messages.box.scrollTop + messages.box.viewport.height >= previous - 1;
      set(messages.content, `Messages and activity${events.length === 80 ? " · last 80 events" : ""}\n\n`
        + (events.length ? events.map(eventText).join("\n\n") : "No activity yet."));
      if (follow && messages.box.visible) messages.box.scrollTo(Infinity);
      set(notice, compact ? "Terminal too small. Use at least 44 × 12." : (networkError || hint || ""));
      notice.visible = compact || !!(networkError || hint);
      const actions = [];
      if (!selected && task?.state === "OFFERED") actions.push("a Accept", "r Reject");
      if (!selected && (task?.state === "WORKING" || task?.state === "BLOCKED")) {
        actions.push("k Ask", "s Submit", "j JSON");
      }
      if (!selected && task?.state === "ACCEPTED") actions.push("w Retry workspace");
      else if (task?.workspacePath) actions.push("w tmux");
      if (!selected && task && ["ACCEPTED", "WORKING", "BLOCKED"].includes(task.state)) actions.push("x Abandon");
      if (view === "history") actions.splice(0, actions.length, "1–9 Open");
      set(keys, compact ? (draft ? "Esc Save draft and go back" : "q Disconnect") : draft ? "F2 Send   Esc Back   Enter New line"
        : [ ...actions, task && view !== "history" ? "m Messages" : "", "h History", "p Pause/resume", "↑↓ Scroll", "q Disconnect" ].filter(Boolean).join("   "));
    }

    async function refresh() {
      try {
        if (needsConnect) {
          snapshot = await client.human(human, "connect", { available: initialOptIn });
          initialOptIn = false;
          needsConnect = false;
        } else snapshot = await client.human(human, "heartbeat", {});
        networkError = "";
        const assigned = snapshot.task?.id ?? "";
        if (assigned !== lastTask) {
          if (lastTask && !assigned) hint = "Assignment closed. Press h for history and feedback.";
          else if (assigned) hint = "";
          lastTask = assigned;
          if (!selected && view !== "history") taskPane.box.scrollTo(0);
        }
        const task = taskForView();
        if ((task?.id ?? "") !== eventId) {
          eventId = task?.id ?? "";
          cursor = 0;
          events = [];
        }
        if (task) {
          const page = await client.human(human, "human_events", { taskId: task.id, after: cursor });
          if (eventId === task.id) {
            events = [...events, ...page.events].slice(-80);
            cursor = page.nextCursor;
          }
        }
        if (view === "history") history = await client.human(human, "history", { limit: 9 });
      } catch (error) {
        if (error instanceof DomainError && error.code === "OFFLINE") needsConnect = true;
        if (error instanceof DomainError && (error.code === "NOT_FOUND" || error.code === "OFFLINE")) {
          if (error.code === "OFFLINE") networkError = "Lease expired. Reconnecting…";
        } else networkError = errorText(error);
      }
      render();
    }
    function poll() {
      if (stopped || refreshPending) return;
      refreshPending = refresh().finally(() => { refreshPending = undefined; });
    }
    async function act(operation: () => Promise<unknown>) {
      if (busy || stopped) return;
      busy = true;
      hint = "";
      try { await operation(); }
      catch (error) { hint = errorText(error); }
      finally { busy = false; render(); poll(); }
    }
    const draftKey = (form: Draft) => `${form.task.id}/${form.task.revision}/${form.kind}`;
    function open(kind: FormKind, task: Task) {
      const next: Draft = { kind, task, submissionId: crypto.randomUUID(), initial: "" };
      if (kind === "json") next.initial = JSON.stringify({ summary: "", evidence: [], ...(task.workspacePath ? { gitRef: "" } : {}),
        ...(task.spec.expectedOutputSchema ? { output: {} } : {}) }, null, 2);
      draft = drafts.get(draftKey(next)) ?? next;
      set(formTitle, { ask: "Ask the parent", reject: "Decline offer", abandon: "Abandon assignment",
        submit: "Submit summary", json: "Submit JSON · summary, evidence[], gitRef, diff, output" }[kind]);
      input.setText(draft.initial);
      render();
      input.focus();
    }
    function closeDraft(keep: boolean) {
      if (draft) {
        if (keep) { draft.initial = input.plainText; drafts.set(draftKey(draft), draft); }
        else drafts.delete(draftKey(draft));
      }
      input.blur();
      draft = undefined;
      render();
    }
    async function sendDraft() {
      if (!draft) return;
      const active = draft;
      const task = active.task;
      const args = { taskId: task.id };
      const value = input.plainText;
      if (active.kind === "ask") await client.human(human, "ask", { ...args, text: value });
      else if (active.kind === "reject") await client.human(human, "reject", { ...args, offerId: task.offerId!, reason: value });
      else if (active.kind === "abandon") await client.human(human, "abandon", { ...args, reason: value });
      else {
        const fields: unknown = active.kind === "json" ? JSON.parse(value) : { summary: value };
        if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new Error("Enter a JSON object");
        const parsed = submission.parse({ ...fields, submissionId: active.submissionId, revision: task.revision });
        await client.human(human, "submit", { ...args, submission: parsed });
      }
      closeDraft(false);
      hint = active.kind === "submit" || active.kind === "json" ? "Submission sent." : "Sent.";
    }
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      const stop = () => { key.preventDefault(); key.stopPropagation(); };
      if (key.ctrl && key.name === "c") {
        stop();
        if (draft && !busy) closeDraft(true);
        else if (!draft) { stopped = true; renderer.destroy(); }
        return;
      }
      if (draft) {
        if (key.name === "escape" && !busy) { stop(); closeDraft(true); }
        if (renderer.width < 44 || renderer.height < 12) { stop(); return; }
        if (key.name === "f2") { stop(); void act(sendDraft); }
        if (busy) stop();
        return;
      }
      if (key.name === "q" && !key.ctrl) { stopped = true; renderer.destroy(); return; }
      if (busy || key.ctrl || renderer.width < 44 || renderer.height < 12) return;
      const task = taskForView();
      const scroller = view === "messages" ? messages.box : taskPane.box;
      if (["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name)) {
        const delta = { up: -1, down: 1, pageup: -scroller.viewport.height, pagedown: scroller.viewport.height };
        if (key.name === "home" || key.name === "end") scroller.scrollTo(key.name === "home" ? 0 : Infinity);
        else scroller.scrollBy(delta[key.name as keyof typeof delta]);
        return;
      }
      if (key.name === "p" && snapshot) {
        const enabled = !snapshot.offersEnabled;
        void act(async () => { snapshot = await client.human(human, "availability", { enabled }); });
      } else if (key.name === "h" || (key.name === "escape" && (selected || view !== "task"))) {
        const next = view === "history" || key.name === "escape" ? "task" : "history";
        selected = undefined;
        view = next;
        taskPane.box.scrollTo(0);
        render();
        poll();
      } else if (view === "history") {
        const old = history[Number(key.name) - 1];
        if (old) { selected = old; view = "task"; taskPane.box.scrollTo(0); render(); poll(); }
      } else if (key.name === "m" && task) {
        view = view === "messages" ? "task" : "messages";
        render();
      } else if (task) {
        if (key.name === "w" && task.workspacePath) {
          const path = task.workspacePath;
          void act(async () => { const tmux = await (await import("./git")).tmuxWorkspace(path, task.id);
            hint = `In another terminal run tmux attach-session -t =${tmux.session}`; });
        }
        if (selected || networkError) return;
        if (task.state === "ACCEPTED" && key.name === "w") {
          void act(() => client.human(human, "workspace", { taskId: task.id }));
        }
        if (task.state === "OFFERED" && task.offerId) {
          const offerId = task.offerId;
          if (key.name === "a") void act(() => client.human(human, "accept", { taskId: task.id, offerId }));
          if (key.name === "r") { stop(); open("reject", task); }
        }
        if (task.state === "WORKING" || task.state === "BLOCKED") {
          if (key.name === "k") { stop(); open("ask", task); }
          if (key.name === "s") { stop(); open(task.spec.expectedOutputSchema ? "json" : "submit", task); }
          if (key.name === "j") { stop(); open("json", task); }
        }
        if (key.name === "x" && ["ACCEPTED", "WORKING", "BLOCKED"].includes(task.state)) { stop(); open("abandon", task); }
      }
    });
    renderer.on(CliRenderEvents.RESIZE, render);
    renderer.once(CliRenderEvents.DESTROY, () => { stopped = true; if (timer) clearInterval(timer); });
    render();
    timer = setInterval(poll, 1_500);
    poll();
    await done;
    await refreshPending;
  } finally {
    if (timer) clearInterval(timer);
    if (!renderer.isDestroyed) renderer.destroy();
    await client.human(human, "disconnect", {}).catch(() => {});
  }
}
