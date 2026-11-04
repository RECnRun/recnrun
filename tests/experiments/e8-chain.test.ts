import { describe, expect, test } from "vite-plus/test";
import { chainProblems, chainSeen, labelled, triedOf } from "./e8-chain.ts";
import type { ChainExpected, ChainObserved } from "./e8-chain.ts";

const labels = new Map([
  ["/h/Downloads", "<OS default>"],
  ["/r/custom", "<custom folder>"],
]);

describe("E8 chain output", () => {
  test("labels the folder the chain printed and keeps an unknown one anonymous", () => {
    expect(chainSeen({ code: 0, stdout: "/r/custom\n", stderr: "" }, labels)).toEqual({
      code: 0,
      found: "<custom folder>",
      tried: [],
    });
    expect(labelled("/elsewhere\n\n/h/Downloads\n", labels)).toEqual([
      "<another folder>",
      "<OS default>",
    ]);
  });

  test("reads the candidates of a not-found line, in order", () => {
    const stderr = "discovery.sh: not found: tried /r/custom, /h/Downloads, /x/y\n";
    expect(triedOf(stderr, labels)).toEqual([
      "<custom folder>",
      "<OS default>",
      "<another folder>",
    ]);
    expect(chainSeen({ code: 66, stdout: "", stderr }, labels).found).toBeNull();
  });

  test("reads no candidate from an empty list or another message", () => {
    expect(triedOf("discovery.sh: not found: tried no candidate\n", labels)).toEqual([]);
    expect(triedOf("discovery.sh: wrong arguments\n", labels)).toEqual([]);
  });
});

const steps = { preferences: null, record: [], find: [] };
const found: ChainObserved = {
  chain: { code: 0, found: "<custom folder>", tried: [] },
  candidates: ["<OS default>", "<custom folder>"],
  steps: { ...steps, record: ["<custom folder>"] },
};
const expectedFound: ChainExpected = {
  found: "<custom folder>",
  candidates: found.candidates,
  steps: found.steps,
};

describe("E8 judgement", () => {
  test("holds when the chain ended on the expected root through the expected steps", () => {
    expect(chainProblems(found, expectedFound)).toEqual([]);
  });

  test("names each thing that differs", () => {
    const wrong: ChainObserved = {
      ...found,
      chain: { code: 66, found: null, tried: ["<OS default>"] },
      steps: { ...steps, find: ["<custom folder>"] },
    };
    const problems = chainProblems(wrong, expectedFound);
    expect(problems).toHaveLength(5);
    expect(problems.join("|")).toContain("exit code was 66, expected 0");
    expect(problems.join("|")).toContain("find step");
  });

  test("a missing root needs exit 66 and every candidate listed", () => {
    const expected: ChainExpected = {
      found: null,
      candidates: found.candidates,
      steps: found.steps,
    };
    const seen: ChainObserved = {
      ...found,
      chain: { code: 66, found: null, tried: found.candidates },
    };
    expect(chainProblems(seen, expected)).toEqual([]);
    const short = { ...seen, chain: { ...seen.chain, tried: ["<OS default>"] } };
    expect(chainProblems(short, expected)[0]).toContain("tried candidates");
  });
});
