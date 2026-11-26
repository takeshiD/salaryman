#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d /tmp/ha-tui.XXXXXX)
tmux_cmd=(tmux -f /dev/null -S "$scratch/tmux.sock")
daemon=
cleanup() {
  "${tmux_cmd[@]}" kill-server >/dev/null 2>&1 || true
  if [[ -n "$daemon" ]]; then
    kill "$daemon" 2>/dev/null || true
    wait "$daemon" 2>/dev/null || true
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT

export XDG_STATE_HOME="$scratch/state" XDG_RUNTIME_DIR="$scratch/run"
export SALARYMAN_PARENT_TOKEN
SALARYMAN_PARENT_TOKEN=$(bun -e 'console.log(crypto.randomUUID())')
export SALARYMAN_REPOSITORIES='{}'
ha=(bun "$PWD/src/cli.ts")
"${ha[@]}" daemon >"$scratch/daemon.log" 2>&1 &
daemon=$!
for ((i=0; i<100; i++)); do
  if [[ -S "$XDG_RUNTIME_DIR/human-agent/agent.sock" ]]; then break; fi
  sleep 0.05
done
"${tmux_cmd[@]}" new-session -d -x 60 -y 20 -s smoke "${ha[@]}" attach
capture() { "${tmux_cmd[@]}" capture-pane -p -t smoke; }
wait_for() {
  local needle=$1 screen=
  for ((i=0; i<120; i++)); do
    screen=$(capture)
    if [[ "$screen" == *"$needle"* ]]; then return 0; fi
    sleep 0.08
  done
  printf 'Missing %s in PTY:\n%s\n' "$needle" "$screen" >&2
  return 1
}
send() { "${tmux_cmd[@]}" send-keys -t smoke "$@"; }
parent() { "${ha[@]}" parent "$@"; }

wait_for 'PAUSED'
send p
wait_for 'AVAILABLE'
task=$(parent delegate_to_human - <<'JSON' | jq -r .taskId
{"requestId":"pty","parentId":"parent","title":"Review a sample answer","instructions":"Read the scoped fixture and send a short verdict.","context":"The sample answer is 42."}
JSON
)
wait_for 'a Accept'
wait_for 'Instructions'
send m
wait_for 'No updates from the parent yet.'
send m
send a
wait_for 'In progress'
jq -cn --arg taskId "$task" '{taskId:$taskId,text:"Also check the filename."}' | parent message_human - >/dev/null
wait_for 'm Updates (1 new)'
wait_for 'Instructions'
send m
wait_for '[m Updates (1)]'
wait_for 'Parent message'
wait_for 'Also check the filename.'
send l
wait_for 'Task activity'
send Escape
wait_for 'Instructions'
send k
wait_for 'Ask the parent'
send -l 'Should the result include test evidence?'
send F2
wait_for 'Waiting for parent'
jq -cn --arg taskId "$task" '{taskId:$taskId}' | parent get_task_events - \
  | jq -e 'any(.events[]; .type == "question" and .text == "Should the result include test evidence?")' >/dev/null
jq -cn --arg taskId "$task" '{taskId:$taskId,text:"Yes, include the smoke test result."}' | parent message_human - >/dev/null
wait_for 'm Updates (1 new)'
send m
wait_for 'Yes, include the smoke test result.'
"${tmux_cmd[@]}" resize-window -t smoke -x 40 -y 10
wait_for 'Terminal too small'
"${tmux_cmd[@]}" resize-window -t smoke -x 108 -y 29
wait_for 'Updates from the parent'
send s
wait_for 'Submit summary'
"${tmux_cmd[@]}" resize-window -t smoke -x 40 -y 10
wait_for 'Esc Save draft and go back'
send Escape
wait_for 'q Disconnect'
"${tmux_cmd[@]}" resize-window -t smoke -x 80 -y 24
wait_for 's Submit'
send Escape
wait_for 'Instructions'
send s
wait_for 'Submit summary'
send -l 'The sample answer passed the smoke test.'
send F2
wait_for 'Submitted for review'
submission=$(jq -cn --arg taskId "$task" '{taskId:$taskId}' | parent get_human_result - \
  | jq -er '.submission | select(.summary == "The sample answer passed the smoke test.").submissionId')
jq -cn --arg taskId "$task" --arg submissionId "$submission" '{taskId:$taskId,submissionId:$submissionId,feedback:"Please include the fixture name."}' \
  | parent reopen_human_task - >/dev/null
wait_for 'Changes requested'
wait_for 'Revision 2'
wait_for 'm Updates (1 new)'
send m
wait_for 'Review feedback'
wait_for 'Please include the fixture name.'
send Escape
wait_for 'Instructions'
send s
wait_for 'Submit summary'
send -l 'The smoke test passed for answer.txt.'
send F2
wait_for 'Submitted for review'
submission=$(jq -cn --arg taskId "$task" '{taskId:$taskId}' | parent get_human_result - \
  | jq -er '.submission | select(.revision == 2).submissionId')
jq -cn --arg taskId "$task" --arg submissionId "$submission" '{taskId:$taskId,submissionId:$submissionId,feedback:"Confirmed."}'   | parent complete_human_task - >/dev/null
wait_for 'Assignment closed'
send h
wait_for 'COMPLETED'
send 1
wait_for 'Review a sample answer'
send m
wait_for 'Confirmed.'
send q
for ((i=0; i<80; i++)); do
  if ! "${tmux_cmd[@]}" has-session -t smoke 2>/dev/null; then
    printf 'OpenTUI PTY smoke passed (60×20, 40×10, 108×29, 80×24).\n'
    exit 0
  fi
  sleep 0.05
done
printf 'TUI did not disconnect\n' >&2
exit 1
