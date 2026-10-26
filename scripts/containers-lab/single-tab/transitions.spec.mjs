// The transition itself: pending requests keep their identity, queued switches run in order, a
// failed reconfiguration blocks the tab until a switch succeeds, a lost debugger session is
// re-established before the app loads, the identity provider's redirect stays with one identity,
// and a cached private response never crosses identities.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as lab from "./harness.mjs";

const HOME = `${lab.APP}/home`;
const late = (jar) => jar.find(({ name }) => name === "late")?.value ?? null;

const handle = await lab.launchSingleTab();
const evidence = {};

await test("switch transitions", async (t) => {
  t.after(async () => {
    lab.writeEvidence(`single-tab-transitions-${lab.MODE}`, {
      mode: lab.MODE,
      chromium: handle.version,
      ...evidence,
    });
    await handle.close();
  });
  await lab.activate(handle, "A", { url: HOME });
  await lab.signIn(handle, "Admin");
  await lab.activate(handle, "B", { url: HOME });
  await lab.signIn(handle, "Requester");

  await t.test("a request pending across the switch keeps the identity that made it", async () => {
    await lab.activate(handle, "A", { url: HOME });
    const since = Date.now();
    await handle.page.evaluate(() => {
      // keepalive: the request outlives its document, as a beacon would.
      void fetch("/slow?ms=1500&tag=pending", { keepalive: true }).catch(() => {});
    });
    const receipt = await lab.activate(handle, "B", { url: HOME });
    await handle.page.waitForTimeout(2500);
    const pending = lab.requestsSince(handle, since).find(({ tag }) => tag === "pending");
    const jars = { a: await handle.lab.jar("a"), b: await handle.lab.jar("b") };
    const events = await lab.eventsMatching(
      handle,
      /set-cookie-dropped|request-blocked|request-gone/,
    );
    evidence.pending = {
      request: pending,
      receipt,
      late: { a: late(jars.a), b: late(jars.b) },
      events,
    };
    assert.equal(pending?.user, "Admin");
    assert.equal(late(jars.b), null);
    assert.equal(await lab.whoAmI(handle.page), "Requester");
    // Debugger: the late Set-Cookie reached the jar of the identity that made the request. Swap: A's
    // jar was saved before the response, so the cookie fell into the store B now uses (out of scope).
    assert.equal(late(jars.a), lab.SWAP ? null : "Admin");
    if (lab.SWAP) assert.ok((await lab.realCookieNames(handle)).includes("late"));
  });

  await t.test("queued switches run in order and the last one wins", async () => {
    const started = Date.now();
    const receipts = await Promise.all([
      handle.lab.activate(handle.tabId, "A", { url: HOME }),
      handle.lab.activate(handle.tabId, "B", { url: HOME }),
      handle.lab.activate(handle.tabId, "A", { url: HOME }),
    ]);
    await handle.page.waitForLoadState("domcontentloaded");
    evidence.queued = { receipts, ms: Date.now() - started };
    assert.deepEqual(
      receipts.map(({ from, to }) => `${from}→${to}`),
      ["B→A", "A→B", "B→A"],
    );
    const documents = receipts.flatMap(({ neutral, document }) => [
      neutral.documentId,
      document.documentId,
    ]);
    assert.equal(new Set(documents).size, 6);
    assert.equal(await lab.whoAmI(handle.page), "Admin");
    assert.deepEqual(await lab.eventsMatching(handle, /switch-failed/), []);
  });

  await t.test(
    "a failed reconfiguration blocks the tab until the next switch succeeds",
    async () => {
      await handle.lab.failNext("reconfigure");
      await assert.rejects(
        handle.lab.activate(handle.tabId, "B", { url: HOME }),
        /Injected failure/,
      );
      const sessions = await handle.lab.sessions();
      const blocked = await handle.page.goto(HOME).then(
        (response) => ({ ok: response?.ok() ?? null, url: handle.page.url() }),
        (error) => ({ error: error.message.split("\n")[0] }),
      );
      const rules = (await handle.lab.sessionRules()).filter(
        ({ action }) => action.type === "block",
      );
      const recovered = await lab.activate(handle, "B", { url: HOME });
      const user = await lab.whoAmI(handle.page);
      evidence.reconfigure = { tab: sessions.tabs[0], blocked, rules, recovered, user };
      assert.equal(sessions.tabs[0].phase, "failed");
      assert.equal(rules.length, 1);
      assert.match(blocked.error ?? "", /ERR_BLOCKED_BY_CLIENT/);
      assert.equal(recovered.to, "B");
      assert.equal(user, "Requester");
      assert.equal(
        (await handle.lab.sessionRules()).some(({ action }) => action.type === "block"),
        false,
      );
    },
  );

  await t.test(
    "a lost debugger session is re-established before the app document loads",
    { skip: lab.SWAP && "the swap mode has no debugger session" },
    async () => {
      await handle.lab.clearEvents();
      await handle.lab.failNext("detach");
      const receipt = await lab.activate(handle, "A", { url: HOME });
      const events = await lab.eventsMatching(handle, /n2-attached|n2-request|switch-/);
      const firstRequest = events.find(({ type }) => type === "n2-request");
      evidence.detach = { receipt, events: events.slice(0, 8) };
      assert.equal(events.filter(({ type }) => type === "n2-attached").length, 1);
      assert.equal(firstRequest?.url, HOME);
      assert.equal(/sid=/.test(firstRequest?.cookie ?? ""), true);
      assert.equal(await handle.page.textContent("#user"), "Admin");
    },
  );

  await t.test(
    "a sign-in through the identity provider's redirects stays with one identity",
    async () => {
      await lab.activate(handle, "C", { url: HOME });
      const rendered = await lab.signIn(handle, "Approver", { idp: true });
      // C's jar is complete once C is suspended (the swap mode saves it then).
      await lab.activate(handle, "A", { url: HOME });
      const jars = { a: await handle.lab.jar("a"), c: await handle.lab.jar("c") };
      const names = (jar) => jar.map(({ name }) => name).toSorted((x, y) => x.localeCompare(y));
      evidence.idp = { rendered, jars: { a: names(jars.a), c: names(jars.c) } };
      assert.equal(rendered, "Approver");
      // Chrome's own store refuses the Secure cookie over http://idp.localhost; the lab's jar took it.
      const expected = lab.SWAP ? ["idp_user", "sid"] : ["idp_embed", "idp_user", "sid"];
      assert.deepEqual(names(jars.c), expected);
      assert.deepEqual(
        names(jars.a).filter((name) => name.startsWith("idp")),
        [],
      );
      assert.equal(await lab.whoAmI(handle.page), "Admin");
      assert.deepEqual(await lab.realCookieNames(handle), lab.SWAP ? ["__rnr", "sid"] : []);
      // Swap: the late cookie of the pending case fell into the store B used, so it is in B's jar now.
      if (lab.SWAP) assert.equal(late(await handle.lab.jar("b")), "Admin");
    },
  );

  await t.test("a cacheable private response is not reused by the next identity", async () => {
    const cached = (page) =>
      page.evaluate(async () => (await (await fetch("/me-cached")).json()).user);
    await lab.activate(handle, "A", { url: HOME });
    const first = await cached(handle.page);
    await lab.activate(handle, "C", { url: HOME });
    const second = await cached(handle.page);
    const hits = handle.fixture.state.log.filter(({ path }) => path === "/me-cached").length;
    evidence.cache = { first, second, hits };
    assert.equal(first, "Admin");
    assert.equal(second, "Approver");
    assert.equal(hits, 2);
  });
});
