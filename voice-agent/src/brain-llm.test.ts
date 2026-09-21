import { describe, expect, it } from "vitest";
import { extractUserText } from "./brain-llm.js";

describe("extractUserText", () => {
  it("returns the last user message", () => {
    expect(
      extractUserText({
        items: [
          { type: "message", role: "assistant", textContent: "hi" },
          { type: "message", role: "user", textContent: "kem cho" },
        ],
      }),
    ).toBe("kem cho");
  });

  it("skips non-message items and returns empty when the user has not spoken", () => {
    expect(
      extractUserText({
        items: [{ type: "function_call", role: undefined, textContent: "x" }],
      }),
    ).toBe("");
    expect(extractUserText({ items: [] })).toBe("");
  });
});
