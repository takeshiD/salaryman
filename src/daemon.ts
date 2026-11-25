import { Database } from "bun:sqlite";
import { join } from "node:path";
import { configuredRepositories, GitWorkspaces } from "./git";
import { listen } from "./ipc";
import { paths, privateDirectory } from "./local";
import { AgentService } from "./service";
import { SqliteRepository } from "./sqlite";

function lock(path: string) {
  const db = new Database(path);
  try { db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;"); }
  catch {
    db.close();
    throw new Error("The Human Agent runtime or state directory is already in use");
  }
  return db;
}

export async function daemon() {
  process.umask(0o077);
  const config = paths();
  privateDirectory(config.runtime);
  privateDirectory(config.state);
  privateDirectory(config.worktrees);
  const runtimeLock = lock(join(config.runtime, "daemon.lock"));
  try {
    const stateLock = lock(join(config.state, "daemon.lock"));
    try {
      const workspaces = new GitWorkspaces(config.worktrees, configuredRepositories());
      const repo = new SqliteRepository(join(config.state, "agent.sqlite"));
      try {
        const service = new AgentService(repo, workspaces);
        service.start();
        const listener = await listen(config.socket, service);
        console.error(`Human Agent listening at ${config.socket}`);
        const timer = setInterval(() => {
          try { service.tick(); }
          catch (error) { console.error("Queue tick failed:", error); }
        }, 2_000);
        let stop = () => {};
        try {
          await new Promise<void>((resolve, reject) => {
            stop = resolve;
            process.once("SIGTERM", stop);
            process.once("SIGINT", stop);
            listener.server.once("error", reject);
          });
        } finally {
          clearInterval(timer);
          process.off("SIGTERM", stop);
          process.off("SIGINT", stop);
          await listener.close();
          await service.drain();
        }
      } finally { repo.close(); }
    } finally { stateLock.close(); }
  } finally { runtimeLock.close(); }
}
