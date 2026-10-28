import type { Page } from "@playwright/test";
import { IDP } from "../apps/sso-pages.ts";
import type { SsoState } from "../apps/sso-pages.ts";
import { APP } from "./workspace.ts";

export { IDP };

/** The SSO client app's page for `run`, where it settles after every sign-in round trip. */
export const ssoAppUrl = (run: string) => `${APP}/sso-app/?run=${encodeURIComponent(run)}`;

/** Signs `user` in at the provider, as its login form would, and returns to the app. */
export async function ssoSignIn(page: Page, run: string, user: string): Promise<SsoState> {
  const query = new URLSearchParams({ run, user, redirect_uri: ssoAppUrl(run) });
  await page.goto(`${IDP}/sso/login?${query.toString()}`);
  return ssoSettled(page);
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
