import { randomBytes } from "node:crypto";

export interface Sessions {
  create(user: string): string;
  user(sid: string | undefined): string | null;
  destroy(sid: string | undefined): void;
  /** A one-time code the API exchanges for its own session after the IdP login. */
  issueCode(user: string): string;
  redeemCode(code: string | null): string | null;
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
  };
}
