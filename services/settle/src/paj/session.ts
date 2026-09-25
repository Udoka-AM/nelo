/**
 * The paj.cash session token, kept on disk between restarts.
 *
 * It is a bearer credential for Nelo's paj.cash account, so it lives outside
 * the repository (by default under ~/.config/nelo), is written owner-only,
 * and is never logged. When it expires, paj.cash needs a new one-time code,
 * which a person has to read: `pnpm paj:login`. Everything that needs the
 * session fails with a message that says so, rather than with a 401.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { PajError, type Session } from "./client.ts";

export interface SessionStore {
  read(): Session | null;
  write(session: Session): void;
}

export function fileSessionStore(path: string): SessionStore {
  return {
    read() {
      if (!existsSync(path)) return null;
      try {
        const s = JSON.parse(readFileSync(path, "utf8")) as Session;
        return typeof s.token === "string" && typeof s.expiresAt === "number" ? s : null;
      } catch {
        return null;
      }
    },
    write(session) {
      const tmp = `${path}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify(session));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
      chmodSync(path, 0o600);
    },
  };
}

export function memorySessionStore(initial: Session | null = null): SessionStore {
  let current = initial;
  return { read: () => current, write: (s) => void (current = s) };
}

/**
 * The session, if it has at least `marginMs` left. A request that starts on
 * a token with seconds to live fails halfway, which is worse than asking for
 * a login up front.
 */
export function currentSession(store: SessionStore, nowMs: number, marginMs = 60_000): Session {
  const s = store.read();
  if (!s || s.expiresAt - marginMs <= nowMs) {
    throw new PajError("The paj.cash session has expired. Log in again with `pnpm paj:login`.", 401, true);
  }
  return s;
}
