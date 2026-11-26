import {
  bold, BoxRenderable, CliRenderEvents, createCliRenderer, fg, ScrollBoxRenderable, stringToStyledText, StyledText,
  TextareaRenderable, TextRenderable,
  type KeyEvent,
} from "@opentui/core";
import type { LocalClient } from "./ipc";
import { DomainError, submission, type Snapshot, type Task, type TaskEvent } from "./model";
import type { Human } from "./service";
import { feedContent, isConversation, isParentUpdate, taskBrief, utcDate, type Segment, type Tone } from "./tui-view";

const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
const errorText = (error: unknown) => error instanceof Error ? clean(error.message) : "Unexpected error";
const palette: Record<Tone, string> = {
  body: "#dee6ec", title: "#f7fafc", label: "#a7c7d4", muted: "#96a6b7",
  accent: "#95e7cb", attention: "#ffd38f", review: "#cfc0ff", error: "#ffaaa6",
};
const background = "#10171f";
const surface = "#171f29";
const border = "#394a5b";

type View = "task" | "updates" | "activity" | "history";
type FormKind = "ask" | "reject" | "submit" | "json" | "abandon";
type Draft = { kind: FormKind; task: Task; initial: string; submissionId: string };

export async function attach(client: LocalClient, human: Human, available: boolean) {
  const noColor = process.env.NO_COLOR !== undefined;
  const renderer = await createCliRenderer({ useMouse: false, useKittyKeyboard: null, exitOnCtrlC: false,
    backgroundColor: noColor ? undefined : background,
    screenMode: "alternate-screen", consoleMode: "disabled", openConsoleOnError: false });
  const done = new Promise<void>((resolve) => renderer.once(CliRenderEvents.DESTROY, resolve));
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshPending: Promise<void> | undefined;
  try {
    const { root } = renderer;
    root.flexDirection = "column";
    root.paddingLeft = 1;
    root.paddingRight = 1;
    function label(id: string) {
      return new TextRenderable(renderer, { id, wrapMode: "word", flexShrink: 0, width: "100%" });
    }
    const header = label("header");
    header.wrapMode = "none";
    header.truncate = true;
    const tabs = label("tabs");
    const body = new BoxRenderable(renderer, { id: "body", flexGrow: 1, minHeight: 0, gap: 1 });
    function pane(id: string, weight: number) {
      const panel = new BoxRenderable(renderer, { id, flexGrow: weight, flexBasis: 0, minWidth: 0, minHeight: 0,
        flexDirection: "column", border: true, borderStyle: "rounded", borderColor: noColor ? undefined : border,
        backgroundColor: noColor ? undefined : surface, paddingLeft: 1, paddingRight: 1 });
      const box = new ScrollBoxRenderable(renderer, { id: id + "-scroll", flexGrow: 1, minHeight: 0,
        focusable: false, scrollY: true, verticalScrollbarOptions: { visible: false } });
      const content = label(id + "-content");
      box.add(content);
      panel.add(box);
      body.add(panel);
      return { panel, box, content };
    }
    const taskPane = pane("task", 6);
    const messages = pane("messages", 5);
    const form = new BoxRenderable(renderer, { id: "form", flexGrow: 1, minHeight: 0, flexDirection: "column", visible: false,
      border: true, borderStyle: "rounded", borderColor: noColor ? undefined : border, paddingLeft: 1, paddingRight: 1 });
    const formTitle = label("form-title");
    const input = new TextareaRenderable(renderer, { id: "draft", flexGrow: 1, width: "100%", wrapMode: "word",
      placeholder: "Type or paste here" });
    form.add(formTitle);
    form.add(input);
    const notice = label("notice");
    const actions = label("actions");
    const keys = label("keys");
    for (const element of [header, tabs, body, form, notice, actions, keys]) root.add(element);

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
    let loadingEvents = false;
    let parentUpdates = 0;
    let unread = 0;
    let events: TaskEvent[] = [];
    let conversation: TaskEvent[] = [];
    const openedThrough = new Map<string, number>();
    let history: Task[] = [];
    let selected: Task | undefined;
    let draft: Draft | undefined;
    const drafts = new Map<string, Draft>();
    const drawn = new WeakMap<TextRenderable, string>();
    const set = (label: TextRenderable, value: Segment[]) => {
      const key = JSON.stringify(value);
      if (drawn.get(label) === key) return;
      drawn.set(label, key);
      label.content = new StyledText(value.map(([part, tone = "body"]) => {
        const text = clean(part);
        const color = fg(palette[tone]);
        const strong = tone !== "muted" && tone !== "body";
        if (noColor) return strong ? bold(text) : stringToStyledText(text).chunks[0]!;
        return color(strong ? bold(text) : text);
      }));
    };
    const taskForView = () => selected ?? snapshot?.task ?? null;
    const compactScreen = () => renderer.width < 44 || renderer.height < 12;
    function showEventsFor(id: string) {
      if (eventId === id) return;
      eventId = id;
      cursor = 0;
      parentUpdates = 0;
      unread = 0;
      loadingEvents = !!id;
      events = [];
      conversation = [];
      messages.box.scrollTo(0);
    }
    function markUpdatesOpened() {
      if (view !== "updates" || draft || compactScreen() || messages.box.scrollTop > 0 || !eventId) return;
      if (cursor > (openedThrough.get(eventId) ?? 0)) openedThrough.set(eventId, cursor);
      unread = 0;
    }
    function render() {
      if (stopped) return;
      const compact = compactScreen();
      const wide = renderer.width >= 100 && renderer.height >= 24;
      const task = taskForView();
      const secondary = view === "updates" || view === "activity";
      const showFeed = !!task && view !== "history" && (wide || secondary);
      const presence = networkError ? "OFFLINE" : snapshot?.availability ?? "CONNECTING";
      showEventsFor(view !== "history" ? task?.id ?? "" : "");
      markUpdatesOpened();
      set(header, [["salaryman", "accent"], ["  /  ", "muted"],
        ...(!snapshot?.task || networkError ? [[presence + "   ", networkError ? "error" : "label"]] satisfies Segment[] : []),
        [human.worker, "muted"]]);
      const tab = (name: string, active: boolean, tone: Tone = "muted"): Segment =>
        [active ? `[${name}]` : name, active ? "title" : tone];
      const updateCount = unread ? ` (${unread} new)` : parentUpdates ? ` (${parentUpdates})` : "";
      tabs.visible = !compact && !draft && !!task && view !== "history";
      set(tabs, [
        tab(view === "task" ? "Task" : "Esc Task", view === "task"), ["   "],
        tab(`m Updates${updateCount}`, view === "updates", unread ? "attention" : "muted"), ["   "],
        tab("l Activity", view === "activity"),
      ]);
      body.visible = !compact && !draft;
      form.visible = !compact && !!draft;
      body.flexDirection = wide ? "row" : "column";
      taskPane.panel.visible = !secondary || wide || !task;
      messages.panel.visible = showFeed;
      if (!noColor) {
        taskPane.panel.borderColor = !secondary ? palette.label : border;
        messages.panel.borderColor = secondary ? palette.label : border;
      }
      if (view === "history") {
        set(taskPane.content, [["Recent assignments\n\n", "title"], ...(history.length
          ? history.flatMap((old, i): Segment[] => [[`${i + 1}  ${old.spec.title}\n`, "label"],
            [`   ${old.state}  ·  ${utcDate(old.updatedAt)}\n\n`, "muted"]])
          : [["Your past assignments will appear here.", "muted"]] satisfies Segment[])]);
      } else {
        set(taskPane.content, task ? taskBrief(task) : [
          [networkError ? "Waiting to reconnect" : !snapshot ? "" : snapshot.offersEnabled ? "Waiting for a task offer" : "Task offers are paused", "title"],
          ...(snapshot && !snapshot.offersEnabled && !networkError ? [["\n\nPress p when you’re ready to receive work.", "muted"]] satisfies Segment[] : []),
        ]);
      }
      if (showFeed) {
        const mode = view === "activity" ? "activity" : "updates";
        const rows = mode === "activity" ? events : conversation;
        set(messages.content, [[mode === "activity" ? "Task activity" : "Updates from the parent", "title"], ["  ·  UTC\n", "muted"],
          ...(!wide && task ? [[task.spec.title + "\n", "muted"]] satisfies Segment[] : []),
          ["\n"], ...feedContent(rows, mode, loadingEvents, openedThrough.get(eventId) ?? 0),
          ...(rows.length === 80 ? [["\nShowing the latest 80 entries.", "muted"]] satisfies Segment[] : [])]);
      }
      set(notice, [[compact ? "Terminal too small. Use at least 44 × 12." : networkError || hint, networkError ? "error" : "muted"]]);
      notice.visible = compact || !!(networkError || hint);
      const availableActions: string[] = [];
      if (view === "history") {
        if (history.length) availableActions.push("1–9 Open");
      } else if (!networkError && !selected) {
        if (task?.state === "OFFERED") availableActions.push("a Accept", "r Decline");
        if (task?.state === "WORKING" || task?.state === "BLOCKED") {
          availableActions.push("k Ask parent", "s Submit", "j JSON");
        }
        if (task?.state === "ACCEPTED") availableActions.push("w Retry workspace");
        if (task && ["ACCEPTED", "WORKING", "BLOCKED"].includes(task.state)) availableActions.push("x Abandon");
      }
      if (view !== "history" && task?.workspacePath) availableActions.push("w tmux");
      actions.visible = !compact && !draft && availableActions.length > 0;
      set(actions, [[availableActions.join("   "), "accent"]]);
      const controls = ["h History", snapshot?.offersEnabled ? "p Pause offers" : "p Enable offers",
        task || view === "history" ? "↑↓ Scroll" : "", "q Disconnect"];
      set(keys, [[compact ? (draft ? "Esc Save draft and go back" : "q Disconnect")
        : draft ? "F2 Send   Esc Back   Enter New line" : controls.filter(Boolean).join("   "), "muted"]]);
    }

    async function refresh() {
      try {
        const previousRevision = snapshot?.task?.revision;
        if (needsConnect) {
          snapshot = await client.human(human, "connect", { available: initialOptIn });
          initialOptIn = false;
          needsConnect = false;
        } else snapshot = await client.human(human, "heartbeat", {});
        networkError = "";
        const assigned = snapshot.task?.id ?? "";
        if (snapshot.task?.revision !== previousRevision && hint === "Submission sent.") hint = "";
        if (assigned !== lastTask) {
          if (lastTask && !assigned) hint = "Assignment closed. Press h for history and feedback.";
          else if (assigned) hint = "";
          lastTask = assigned;
          if (!selected && view !== "history") {
            view = "task";
            taskPane.box.scrollTo(0);
          }
        }
        const task = view === "history" ? null : taskForView();
        showEventsFor(task?.id ?? "");
        if (task) {
          for (let i = 0; i < 4; i++) {
            const page = await client.human(human, "human_events", { taskId: task.id, after: cursor });
            if (eventId !== task.id || stopped) break;
            events = [...events, ...page.events].slice(-80);
            conversation = [...conversation, ...page.events.filter(isConversation)].slice(-80);
            const seen = openedThrough.get(task.id) ?? 0;
            const updates = page.events.filter(isParentUpdate);
            parentUpdates += updates.length;
            unread += updates.filter((event) => event.seq > seen).length;
            cursor = page.nextCursor;
            loadingEvents = page.hasMore;
            if (!page.hasMore) break;
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
      set(formTitle, [[{ ask: "Ask the parent", reject: "Decline offer", abandon: "Abandon assignment",
        submit: "Submit summary", json: "Submit JSON · summary, evidence[], gitRef, diff, output" }[kind], "title"],
        ["\n" + task.spec.title + "\n", "muted"]]);
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
        if (compactScreen()) { stop(); return; }
        if (key.name === "f2") { stop(); void act(sendDraft); }
        if (busy) stop();
        return;
      }
      if (key.name === "q" && !key.ctrl) { stopped = true; renderer.destroy(); return; }
      if (busy || key.ctrl || compactScreen()) return;
      const task = taskForView();
      const scroller = view === "updates" || view === "activity" ? messages.box : taskPane.box;
      if (["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name)) {
        const delta = { up: -1, down: 1, pageup: -scroller.viewport.height, pagedown: scroller.viewport.height };
        if (key.name === "home" || key.name === "end") scroller.scrollTo(key.name === "home" ? 0 : Infinity);
        else scroller.scrollBy(delta[key.name as keyof typeof delta]);
        if (view === "updates" && unread) scroller.afterLayout(render);
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
      } else if ((key.name === "m" || key.name === "l") && task) {
        const target = key.name === "m" ? "updates" : "activity";
        view = view === target ? "task" : target;
        if (view !== "task") messages.box.scrollTo(0);
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
