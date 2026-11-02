import { afterAll, beforeAll, beforeEach } from "vite-plus/test";
import type { Origins } from "@/context.ts";
import type { LedgerEntry } from "@/ledger.ts";
import { startFixture, type Fixture } from "@/server.ts";

const EPHEMERAL = { app: 0, api: 0, idp: 0, staging: 0 };

// *.localhost does not resolve in every container, so tests reach the listeners on 127.0.0.1.
export function local(url: string): string {
  return url.replace(/\/\/[a-z]+\.localhost:/, "//127.0.0.1:");
}

export function location(response: Response): string {
  const value = response.headers.get("location");
  if (!value) throw new Error(`No Location header on ${response.url} (${response.status})`);
  return value;
}

export function cookieOf(response: Response): string {
  const [first = ""] = response.headers.getSetCookie();
  return first.split(";")[0] ?? "";
}

/** Starts a fixture on free ports for the test file and resets its ledger before each test. */
export function useFixture() {
  let fixture: Fixture | undefined;
  beforeAll(async () => {
    fixture = await startFixture({ ports: EPHEMERAL });
  });
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    await fetch(local(`${origins().api}/__ledger/reset`), { method: "POST" });
  });

  function origins(): Origins {
    if (!fixture) throw new Error("The fixture starts in beforeAll");
    return fixture.origins;
  }

  async function ledger(): Promise<LedgerEntry[]> {
    const response = await fetch(local(`${origins().api}/__ledger`));
    return (await response.json()) as LedgerEntry[];
  }

  async function signIn(username: string) {
    const login = await fetch(local(`${origins().idp}/login`), {
      method: "POST",
      body: new URLSearchParams({ username, redirect: `${origins().app}/` }),
      redirect: "manual",
    });
    const session = await fetch(local(location(login)), { redirect: "manual" });
    return { login, session, idpCookie: cookieOf(login), apiCookie: cookieOf(session) };
  }

  async function me(cookie: string) {
    const response = await fetch(local(`${origins().api}/me`), { headers: { cookie } });
    return { status: response.status, body: (await response.json()) as { user: string | null } };
  }

  return {
    get origins() {
      return origins();
    },
    ledger,
    signIn,
    me,
  };
}
