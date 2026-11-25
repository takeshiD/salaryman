import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { DomainError, id, token } from "./model";

function base(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  if (!isAbsolute(value)) throw new Error("XDG paths must be absolute");
  return value;
}

export function paths() {
  const runtimeBase = base(process.env.XDG_RUNTIME_DIR, `/run/user/${process.getuid!()}`);
  const state = join(base(process.env.XDG_STATE_HOME, join(homedir(), ".local", "state")), "human-agent");
  const runtime = join(runtimeBase, "human-agent");
  return { state, runtime, socket: join(runtime, "agent.sock"), worktrees: join(state, "worktrees") };
}

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) {
    throw new Error(`Expected an owned 0700 directory at ${path}`);
  }
}

export function ownSocket(path: string, checkMode = true) {
  const info = lstatSync(path);
  if (!info.isSocket() || info.uid !== process.getuid!() || (checkMode && (info.mode & 0o777) !== 0o600)) {
    throw new Error(`Expected an owned Unix socket with mode 0600 at ${path}`);
  }
}

export function parentToken() {
  const renamedConfig = process.env.DOORMAT_PARENT_TOKEN || process.env.DOORMAT_PARENT_TOKEN_FILE;
  const file = renamedConfig ? process.env.DOORMAT_PARENT_TOKEN_FILE : process.env.HUMAN_AGENT_PARENT_TOKEN_FILE;
  let value = renamedConfig ? process.env.DOORMAT_PARENT_TOKEN : process.env.HUMAN_AGENT_PARENT_TOKEN;
  if (!value && file) {
    if (!isAbsolute(file)) throw new DomainError("CONFIG", "Parent token file path must be absolute");
    const info = lstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600 || info.size > 256) {
      throw new DomainError("CONFIG", "Expected an owned 0600 parent token file");
    }
    value = readFileSync(file, "utf8").trim();
  }
  const parsed = token.safeParse(value);
  if (!parsed.success) throw new DomainError("CONFIG", "Configure a stable random DOORMAT_PARENT_TOKEN or DOORMAT_PARENT_TOKEN_FILE");
  return parsed.data;
}

const identity = z.strictObject({ secret: token, session: z.uuid() });
export function workerIdentity(worker: string) {
  id.parse(worker);
  const { state } = paths();
  const directory = join(state, "workers");
  privateDirectory(state);
  privateDirectory(directory);
  const path = join(directory, worker + ".json");
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = join(directory, `.${randomUUID()}`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify({ secret: randomBytes(32).toString("base64url"), session: randomUUID() })); }
      finally { closeSync(fd); }
      try { linkSync(temporary, path); }
      catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError; }
    } finally { unlinkSync(temporary); }
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600) {
    throw new Error(`Expected an owned 0600 credential file at ${path}`);
  }
  return { worker, ...identity.parse(JSON.parse(readFileSync(path, "utf8"))) };
}

export function secureSocket(path: string) {
  ownSocket(path, false);
  chmodSync(path, 0o600);
}
