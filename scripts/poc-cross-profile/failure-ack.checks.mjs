import assert from "node:assert/strict";
import { test } from "node:test";
import { shells } from "./lab.mjs";
import { EX_BOOTSTRAP_FAILED, EX_NO_ACK, OTHER_TOKEN, open, request, scene } from "./open-lab.mjs";

for (const shell of shells) {
  await test(`${shell}: a failure ack of the token exits 71 and logs the step and the error`, (context) => {
    const { record, env } = scene(context);
    const result = open(shell, request(record), env({ STUB_SHAPE: "failure" }));
    assert.equal(result.code, EX_BOOTSTRAP_FAILED, result.err);
    assert.equal(result.out, "");
    assert.match(
      result.err,
      /bootstrap failed at publish: The offscreen document did not answer\./,
    );
  });

  const unreadable = [
    { title: "a step outside the closed set", extra: { STUB_STEP: "launch" } },
    { title: "an error with a quote", extra: { STUB_ERROR: 'say "hi"' } },
    { title: "an error with a backslash", extra: { STUB_ERROR: "a\\b" } },
    { title: "an error with a dollar sign", extra: { STUB_ERROR: "$(id)" } },
    { title: "an empty error", extra: { STUB_ERROR: "" } },
    { title: "an error over 200 characters", extra: { STUB_ERROR: "e".repeat(201) } },
    { title: "a failure ack of another token", extra: { STUB_TOKEN: OTHER_TOKEN } },
    { title: "a failure ack behind a symbolic link", extra: { STUB_KIND: "symlink" } },
  ];
  for (const { title, extra } of unreadable) {
    await test(`${shell}: ${title} is ignored and the wait times out`, (context) => {
      const { record, env } = scene(context);
      const result = open(shell, request(record), env({ STUB_SHAPE: "failure", ...extra }));
      assert.equal(result.code, EX_NO_ACK, result.err);
      assert.equal(result.out, "");
    });
  }
}
