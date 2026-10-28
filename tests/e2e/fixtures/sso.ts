import type { BrowserContext, Page, Worker } from "@playwright/test";
import { IDP } from "../apps/sso-pages.ts";
import type { SsoState } from "../apps/sso-pages.ts";
import { expect } from "./extension.ts";
import { identitiesAt, lifecycleDriver } from "./lifecycle.ts";
import { APP } from "./workspace.ts";

/** The capability every SSO identity declares when its provider's session must come back. */
export const SSO_HOSTS = { cookieHosts: ["sso.localhost"] };
/** What the app settles on when the provider has no session for it. */
export const SIGNED_OUT = { signedIn: null, error: "login_required" };

/** The SSO client app's page for `run`, where it settles after every sign-in round trip. */
export const ssoAppUrl = (run: string) => `${APP}/sso-app/?run=${encodeURIComponent(run)}`;

/** The server-session client's page for `run`; it signs in through its callback. */
export const ssoServerUrl = (run: string) => `${ssoAppUrl(run)}&server=1`;

/** Signs `user` in at the provider, as its login form would, and returns to the app. */
export async function ssoSignIn(page: Page, run: string, user: string): Promise<SsoState> {
  const query = new URLSearchParams({ run, user, redirect_uri: ssoAppUrl(run) });
  await page.goto(`${IDP}/sso/login?${query.toString()}`);
  return ssoSettled(page);
}

/** The server client that sends a user without a session to its provider's sign-in page. */
export const ssoInteractiveUrl = (run: string) => `${ssoServerUrl(run)}&interactive=1`;

/** Signs `user` in on the provider's sign-in page, as a person would, and waits for the app. */
export async function ssoFormSignIn(page: Page, user: string): Promise<SsoState> {
  await expect(page).toHaveTitle("Sign in");
  await page.getByRole("textbox", { name: "User" }).fill(user);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${APP}/sso-app/**`);
  return ssoSettled(page);
}

/** Signs `user` in for the server-session client: the provider answers its callback. */
export async function ssoServerSignIn(page: Page, run: string, user: string): Promise<SsoState> {
  const back = `${APP}/sso-app/callback?run=${encodeURIComponent(run)}`;
  const query = new URLSearchParams({ run, user, redirect_uri: back, response_mode: "query" });
  await page.goto(`${IDP}/sso/login?${query.toString()}`);
  return ssoSettled(page);
}

async function expireAt(path: string, run: string): Promise<void> {
  const response = await fetch(`http://localhost:5192${path}?run=${run}`, { method: "POST" });
  if (!response.ok) throw new Error(`${path} answered ${response.status}.`);
}

/** Expires the server client's sessions of `run`; Node may not resolve *.localhost. */
export const expireServerSessions = (run: string) => expireAt("/sso-app/expire", run);

/** Expires the provider's sessions of `run`, until a sign-in there. */
export const expireProviderSessions = (run: string) => expireAt("/sso/expire", run);

/** The managed tab once it shows the app or its provider, other than `previous`. */
export async function ssoPage(context: BrowserContext, previous?: Page): Promise<Page> {
  const hosts = new Set([new URL(APP).host, new URL(IDP).host]);
  const found = () =>
    context
      .pages()
      .find(
        (each) =>
          each !== previous && !each.isClosed() && hosts.has(URL.parse(each.url())?.host ?? ""),
      );
  if (previous) await expect.poll(() => previous.isClosed()).toBe(true);
  await expect.poll(() => found() !== undefined).toBe(true);
  const page = found();
  if (!page) throw new Error("No page shows the SSO app.");
  return page;
}

/** Waits until the app is back from the provider and decided who is signed in. */
export async function ssoSettled(page: Page): Promise<SsoState> {
  const handle = await page.waitForFunction(() => {
    const state = (window as { __sso?: SsoState }).__sso;
    return state?.done === true ? state : undefined;
  });
  return (await handle.jsonValue()) as SsoState;
}

/** What the provider's own origin holds in localStorage, read on its page in the managed tab. */
export async function idpStorage(page: Page): Promise<Record<string, string>> {
  await page.goto(`${IDP}/sso/storage`);
  return page.evaluate(
    () =>
      (window as { __idp?: { localStorage: Record<string, string> } }).__idp?.localStorage ?? {},
  );
}

/** Identities by label at `url`, each declaring `capabilities`. */
export async function ssoSetUp(
  context: BrowserContext,
  serviceWorker: Worker,
  url: string,
  capabilities?: { cookieHosts: string[] },
) {
  const driver = await lifecycleDriver(context, serviceWorker);
  const identities = identitiesAt(driver.command, url, new Map(), capabilities);
  const tab: { page?: Page } = {};
  /** Opens `label` and waits until the app settled on who is signed in. */
  const open = async (label: string) => {
    await identities.open(label);
    tab.page = await ssoPage(context, tab.page);
    return { page: tab.page, state: await ssoSettled(tab.page) };
  };
  return { open, identities };
}
