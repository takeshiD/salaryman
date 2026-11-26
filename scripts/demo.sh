#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d /tmp/ha-demo.XXXXXX)
daemon=
cleanup() {
  if [[ -n "$daemon" ]]; then
    kill "$daemon" 2>/dev/null || true
    wait "$daemon" 2>/dev/null || true
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
export XDG_STATE_HOME="$scratch/state" XDG_RUNTIME_DIR="$scratch/run"
export SALARYMAN_PARENT_TOKEN SALARYMAN_REPOSITORIES
SALARYMAN_PARENT_TOKEN=$(bun -e 'console.log(crypto.randomUUID())')
SALARYMAN_REPOSITORIES=$(jq -cn --arg path "$scratch/fixture" '{fixture:$path}')
git init -q "$scratch/fixture"
printf 'The sample answer is 42.\n' >"$scratch/fixture/answer.txt"
git -C "$scratch/fixture" add answer.txt
git -C "$scratch/fixture" -c user.name=Demo -c user.email=demo@example.invalid -c core.hooksPath=/dev/null commit -qm Fixture
base=$(git -C "$scratch/fixture" rev-parse HEAD)
ha=(bun "$PWD/src/cli.ts")
parent() { "${ha[@]}" parent "$@"; }
"${ha[@]}" daemon >"$scratch/daemon.log" 2>&1 &
daemon=$!
ready=false
for ((i=0; i<100; i++)); do
  if parent list_available_humans >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.05
done
if [[ "$ready" != true ]]; then cat "$scratch/daemon.log" >&2; exit 1; fi

"${ha[@]}" online | jq -e '.availability == "AVAILABLE"' >/dev/null
task=$(jq -cn --arg ref "$base" '{
  requestId:"demo", parentId:"demo-parent", title:"Check the fixture answer",
  instructions:"Read answer.txt in the worktree and submit the answer as evidence.",
  workspace:{repository:"fixture",ref:$ref}, allowedTools:["shell","git"]
}' | parent delegate_to_human - | jq -er .taskId)
path=$("${ha[@]}" accept "$task" | jq -er .workspacePath)
answer=$(cat "$path/answer.txt")
"${ha[@]}" ask "Should I include the exact value?" "$task" >/dev/null
jq -cn --arg taskId "$task" '{taskId:$taskId,text:"Yes, include the exact value."}' | parent message_human - >/dev/null
submit() {
  jq -cn --argjson revision "$1" --arg submissionId "$2" --arg evidence "$3"     '{revision:$revision,submissionId:$submissionId,summary:"Verified fixture",evidence:[$evidence]}'     | "${ha[@]}" submit - "$task" >/dev/null
}
review() {
  jq -cn --arg taskId "$task" --arg submissionId "$2" --arg feedback "$3"     '{taskId:$taskId,submissionId:$submissionId,feedback:$feedback}' | parent "$1" -
}
submit 1 first "$answer"
review reopen_human_task first "Please include the filename." | jq -e '.revision == 2' >/dev/null
submit 2 second "answer.txt: $answer"
review complete_human_task second "Verified." | jq -e '.state == "COMPLETED"' >/dev/null
jq -cn --arg taskId "$task" '{taskId:$taskId}' | parent get_human_result - | jq -e '.state == "COMPLETED"' >/dev/null
"${ha[@]}" disconnect >/dev/null
printf 'Completed %s after one review/rework cycle.\n' "$task"
