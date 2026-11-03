import { randomBytes } from "node:crypto";

export interface Sessions {
  create(user: string): string;
  user(sid: string | undefined): string | null;
  destroy(sid: string | undefined): void;
  /** A one-time code the API exchanges for its own session after the IdP login. */
  issueCode(user: string): string;
  redeemCode(code: string | null): string | null;
  /** Ends every session and pending code of the user, as a server-side expiry; returns how many sessions ended. */
  expire(user: string): number;
}

function token(): string {
  return randomBytes(16).toString("hex");
}

export function createSessions(): Sessions {
  const sessions = new Map<string, string>();
  const codes = new Map<string, string>();
  return {
    create(user) {
      const sid = token();
      sessions.set(sid, user);
      return sid;
    },
    user: (sid) => (sid === undefined ? null : (sessions.get(sid) ?? null)),
    destroy(sid) {
      if (sid !== undefined) sessions.delete(sid);
    },
    issueCode(user) {
      const code = token();
      codes.set(code, user);
      return code;
    },
    redeemCode(code) {
      if (code === null) return null;
      const user = codes.get(code) ?? null;
      codes.delete(code);
      return user;
    },
    expire(user) {
      let ended = 0;
      for (const [sid, owner] of sessions) if (owner === user && sessions.delete(sid)) ended++;
      for (const [code, owner] of codes) if (owner === user) codes.delete(code);
      return ended;
    },
  };
}
