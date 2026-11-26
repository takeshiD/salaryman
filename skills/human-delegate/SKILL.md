---
name: human-delegate
description: Delegate scoped tasks to an opted-in salaryman worker, answer their questions, and review submissions. Use when the user explicitly asks for a human handoff or when an authorized routing policy selects a human.
---

# Human delegation

Use the salaryman MCP tools in the parent session. Carry exactly one execution path for each attempt.

1. Default to manual routing. For explicitly authorized automatic or random routing, check `list_available_humans` and use `salaryman route` with a stable attempt ID, eligibility, availability, and the configured rate. An empty availability result can route an unstarted automatic attempt to AI. An explicitly requested handoff may queue offline.
2. Call `delegate_to_human` with a stable `requestId`, `parentId`, title, instructions, and only the context the human needs. Include an approved repository alias and ref when needed. Prefer a full commit hash. Specify acceptance criteria, expected output, and the offer deadline if relevant.
3. Save the returned `taskId` and event cursor in your working context. On an uncertain reply, retry the same request ID and identical payload with the same parent capability. Resolve the task state before starting work on that attempt.
4. Continue independent work while the task is pending. At a natural checkpoint or on an explicitly configured scheduler, call `get_task_events` with the last cursor, handle the page, and save `nextCursor`. Drain `hasMore` pages. If you must wait in a script, start with a 5-second delay and back off to 30 seconds between empty polls. Answer questions with `message_human`. If the host ends the turn, tell the user how to resume with the task ID. This runtime uses ordinary tools and supplies no native auto-resume.
5. For a caller-authorized fallback, first call `cancel_human_task` with `unacceptedOnly: true`. A confirmed `CANCELLED` or `REJECTED` permits fallback. After `ALREADY_ACCEPTED` or an uncertain reply, reconcile before taking any action. An offline worker can still own an accepted task. When explicitly stopping accepted work, coordinate with the worker and use an independent checkout for any replacement.
6. When submitted, call `get_human_result`, then `review_human_task` with its `submissionId`. Review the evidence and inspect the code or rerun tests as appropriate. Call `reopen_human_task` with actionable feedback, or `complete_human_task` with the same submission ID. A new revision has a new submission ID.
