import { describe, expect, it } from "vitest";

import { loadFixtures, runScenarios } from "./harness.js";

describe("operator scenario harness", () => {
  it("replays every fixture successfully", async () => {
    const fixtures = loadFixtures();
    const results = await runScenarios();

    expect(fixtures).toHaveLength(20);
    expect(results).toHaveLength(fixtures.length);
    expect(results.filter((result) => !result.ok)).toEqual([]);
  });
});
