import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { DomainError, id, taskId, workspace } from "./model";
import type { WorkspacePort } from "./service";

const repositoryMap = z.record(id, z.string().refine(isAbsolute));
const hash = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export function configuredRepositories() {
  return repositoryMap.parse(JSON.parse(process.env.HUMAN_AGENT_REPOSITORIES ?? "{}"));
}

function gitEnvironment() {
  return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };
}
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: gitEnvironment(),
    timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 });
  const [out, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new DomainError("GIT", stderr.trim().slice(0, 1_000) || `Workspace command exited with status ${code}`);
  return out;
}
function gitArgs(path: string, args: string[]) {
  return ["git", "-C", path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "submodule.recurse=false", "-c", "protocol.allow=never", ...args];
}
const git = (path: string, ...args: string[]) => command(gitArgs(path, args));
async function rejectFilters(path: string) {
  const config = (await git(path, "config", "--null", "--name-only", "--list")).split("\0");
  if (config.some((key) => /^filter\..+\.(process|smudge|clean)$/i.test(key))) {
    throw new DomainError("GIT", "Configured external filters are unsupported in managed worktrees");
  }
}
const commonDir = (path: string) => git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");

async function statIfPresent(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

export class GitWorkspaces implements WorkspacePort {
  constructor(private readonly root: string, private readonly repositories: Record<string, string>) {}
  knows(repository: string) { return Object.hasOwn(this.repositories, repository); }
  private async repo(repository: string) {
    if (!this.knows(repository)) throw new DomainError("BAD_REPOSITORY", "Repository alias is not configured");
    const path = await realpath(this.repositories[repository]!);
    const top = (await git(path, "rev-parse", "--show-toplevel")).trim();
    if (path !== top || !await statIfPresent(join(path, ".git"))) {
      throw new DomainError("BAD_REPOSITORY", "Configure the top level of a local Git checkout");
    }
    return path;
  }
  async resolve(input: z.infer<typeof workspace>) {
    const { repository, ref } = workspace.parse(input);
    const path = await this.repo(repository);
    const commit = (await git(path, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}")).trim();
    if (!hash.test(commit)) throw new DomainError("GIT", "Expected a full commit hash");
    return commit;
  }
  async provision(id: string, repository: string, commit: string) {
    taskId.parse(id);
    if (!hash.test(commit)) throw new DomainError("GIT", "Invalid pinned commit");
    const path = await this.repo(repository);
    const root = await realpath(this.root);
    const destination = join(root, id);
    if (dirname(destination) !== root) throw new DomainError("GIT", "Invalid workspace destination");
    const lock = join(root, id + ".lock");
    const lockInfo = await statIfPresent(lock);
    if (lockInfo && !lockInfo.isFile()) throw new DomainError("GIT", "Unexpected workspace lock path");
    // An orphan Git process keeps this lock across daemon restarts.
    await command(["flock", "-n", lock, "true"]);
    const existing = await statIfPresent(destination);
    const registration = (await git(path, "worktree", "list", "--porcelain", "-z"))
      .split("\0\0").map((entry) => entry.split("\0")).find(([location]) => location === "worktree " + destination);
    const registered = !!registration;
    if (!existing && !registered) {
      // Local repo config is an operator trust boundary. Refuse external checkout filters.
      await rejectFilters(path);
      await command(["flock", "-n", lock, ...gitArgs(path, ["worktree", "add", "--detach", "--", destination, commit])]);
    } else {
      if (!registration?.includes("detached") || !existing?.isDirectory() || await realpath(destination) !== destination) {
        throw new DomainError("GIT", `Existing workspace needs manual inspection at ${destination}`);
      }
      if (await commonDir(path) !== await commonDir(destination)) {
        throw new DomainError("GIT", `Recovered workspace belongs to a different repository at ${destination}`);
      }
      await rejectFilters(destination);
      const head = (await git(destination, "rev-parse", "HEAD")).trim();
      const indexLock = (await git(destination, "rev-parse", "--path-format=absolute", "--git-path", "index.lock")).trim();
      const dirty = await git(destination, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all");
      if (head !== commit || dirty || await statIfPresent(indexLock)) {
        throw new DomainError("GIT", `Recovered workspace needs manual inspection at ${destination}`);
      }
    }
    return destination;
  }
}

export async function tmuxWorkspace(path: string, id: string) {
  const name = "human-agent-" + taskId.parse(id);
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error("The workspace path has moved");
  const session = Bun.spawn(["tmux", "has-session", "-t", "=" + name], { stdout: "ignore", stderr: "ignore" });
  if (await session.exited !== 0) {
    const create = Bun.spawn(["tmux", "new-session", "-d", "-s", name, "-c", path.replaceAll("#", "##")],
      { stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([create.exited, new Response(create.stderr).text()]);
    if (code !== 0) throw new Error(stderr.trim() || "tmux could not create the session");
  }
  return { session: name, path, attach: ["tmux", "attach-session", "-t", "=" + name] };
}
