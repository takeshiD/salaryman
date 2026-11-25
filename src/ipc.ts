import { createConnection, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { unlinkSync } from "node:fs";
import { z } from "zod";
import { ownSocket, secureSocket } from "./local";
import { DomainError } from "./model";
import { dispatch, type HumanMethod, type Params, type ParentMethod, type Result } from "./rpc";
import type { AgentService, Human } from "./service";

const maxRequest = 128 * 1024;
const maxResponse = 2 * 1024 * 1024;

function frame(socket: Socket, maxBytes: number, ready: (parsed: unknown) => void, invalid: (error: Error) => void) {
  let fragments: Buffer[] = [];
  let bytes = 0;
  const receive = (chunk: Buffer) => {
    bytes += chunk.length;
    try {
      if (bytes > maxBytes) throw new DomainError("TOO_LARGE", "IPC frame is too large");
      const end = chunk.indexOf(10);
      if (end === -1) { fragments.push(chunk); return; }
      if (end !== chunk.length - 1) throw new DomainError("BAD_FRAME", "Expected one JSON line per connection");
      socket.off("data", receive);
      fragments.push(chunk.subarray(0, end));
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(fragments)));
      fragments = [];
      const stack: [unknown, number][] = [[parsed, 0]];
      let nodes = 0;
      while (stack.length) {
        const [value, depth] = stack.pop()!;
        if (depth > 48 || ++nodes > 60_000) throw new DomainError("BAD_FRAME", "IPC JSON is too complex");
        if (value && typeof value === "object") {
          for (const child of Object.values(value)) stack.push([child, depth + 1]);
        }
      }
      ready(parsed);
    } catch (error) {
      socket.off("data", receive);
      invalid(error instanceof DomainError ? error : new DomainError("BAD_FRAME", "Invalid JSON frame"));
    }
  };
  socket.on("data", receive);
}
function failure(error: unknown) {
  if (error instanceof DomainError) return { ok: false, code: error.code, message: error.message };
  if (error instanceof z.ZodError) {
    const details = error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "params"} (${issue.code})`);
    return { ok: false, code: "INVALID_INPUT", message: details.join(", ") };
  }
  console.error("IPC error:", error instanceof Error ? error.name : "unknown");
  return { ok: false, code: "INTERNAL", message: "Unexpected daemon error" };
}

export async function listen(socketPath: string, service: AgentService) {
  try {
    ownSocket(socketPath, false);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") resolve();
        else reject(error);
      });
      socket.once("connect", () => { socket.destroy(); reject(new Error("A doormat daemon is already listening")); });
      socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("Existing socket did not respond")); });
    });
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const idle = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    idle.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => idle.delete(socket));
    socket.once("end", () => { if (idle.has(socket)) socket.end(); });
    socket.setTimeout(100_000, () => socket.destroy());
    const reply = (value: unknown) => {
      const encoded = JSON.stringify(value) + "\n";
      if (Buffer.byteLength(encoded) > maxResponse) {
        socket.end(JSON.stringify(failure(new DomainError("TOO_LARGE", "Response is too large"))) + "\n");
      } else socket.end(encoded);
    };
    frame(socket, maxRequest, (request) => {
      idle.delete(socket);
      void Promise.resolve().then(() => dispatch(service, request))
        .then((data) => reply({ ok: true, data })).catch((error) => reply(failure(error)));
    }, (error) => reply(failure(error)));
  });
  server.listen(socketPath);
  await once(server, "listening");
  secureSocket(socketPath);
  let closing: Promise<void> | undefined;
  return { server, close: () => closing ??= new Promise<void>((resolve) => {
    server.close(() => resolve());
    for (const socket of idle) socket.destroy();
  }) };
}

const response = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: z.unknown() }),
  z.strictObject({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);
export class LocalClient {
  constructor(private readonly socketPath: string) {}
  parent<M extends ParentMethod>(auth: string, method: M, params: Params<M>) {
    return this.request<M>(auth, method, params);
  }
  human<M extends HumanMethod>(auth: Human, method: M, params: Params<M>) {
    return this.request<M>(auth, method, params);
  }
  private request<M extends ParentMethod | HumanMethod>(auth: Human | string, method: M, params: Params<M>) {
    return new Promise<Result<M>>((resolve, reject) => {
      const encoded = JSON.stringify({ v: 1, method, auth, params }) + "\n";
      if (Buffer.byteLength(encoded) > maxRequest) { reject(new DomainError("TOO_LARGE", "Request is too large")); return; }
      try { ownSocket(this.socketPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") reject(new DomainError("UNREACHABLE", "Daemon socket is unavailable"));
        else reject(error);
        return;
      }
      const socket = createConnection(this.socketPath);
      const offline = () => { socket.destroy(); reject(new DomainError("UNREACHABLE", "Daemon connection ended before a reply")); };
      socket.once("error", offline);
      socket.once("end", offline);
      socket.setTimeout(method === "accept" || method === "workspace" ? 90_000 : 5_000, offline);
      socket.once("connect", () => socket.write(encoded));
      frame(socket, maxResponse, (value) => {
        const parsed = response.safeParse(value);
        socket.destroy();
        if (!parsed.success) reject(new DomainError("BAD_FRAME", "Invalid daemon response"));
        else if (!parsed.data.ok) reject(new DomainError(parsed.data.code, parsed.data.message));
        else resolve(parsed.data.data as Result<M>);
      }, (error) => { socket.destroy(); reject(error); });
    });
  }
}
