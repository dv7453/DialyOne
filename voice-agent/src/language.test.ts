import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  languageFromAttributes,
  languageFromMetadata,
  parseLanguageCode,
  resolveSessionLanguage,
} from "./language.js";

describe("parseLanguageCode", () => {
  it("accepts canonical BCP-47 values", () => {
    expect(parseLanguageCode("gu-IN")).toBe("gu-IN");
    expect(parseLanguageCode("hi-IN")).toBe("hi-IN");
    expect(parseLanguageCode("en-IN")).toBe("en-IN");
  });

  it("normalizes aliases without restructuring the pipeline", () => {
    expect(parseLanguageCode("gu")).toBe("gu-IN");
    expect(parseLanguageCode("Gujarati")).toBe("gu-IN");
    expect(parseLanguageCode("HI")).toBe("hi-IN");
    expect(parseLanguageCode("english")).toBe("en-IN");
    expect(parseLanguageCode("en-US")).toBe("en-IN");
  });

  it("returns undefined for unknown values", () => {
    expect(parseLanguageCode("fr-FR")).toBeUndefined();
    expect(parseLanguageCode("")).toBeUndefined();
    expect(parseLanguageCode(undefined)).toBeUndefined();
  });
});

describe("languageFromAttributes", () => {
  it("reads language before user.language", () => {
    expect(
      languageFromAttributes({
        language: "hi-IN",
        "user.language": "en-IN",
      }),
    ).toBe("hi-IN");
  });

  it("falls back to the LiveKit docs key user.language", () => {
    expect(languageFromAttributes({ "user.language": "en-IN" })).toBe("en-IN");
  });

  it("accepts languageCode", () => {
    expect(languageFromAttributes({ languageCode: "gu" })).toBe("gu-IN");
  });
});

describe("languageFromMetadata", () => {
  it("accepts a bare code", () => {
    expect(languageFromMetadata("hi-IN")).toBe("hi-IN");
  });

  it("parses JSON language and languageCode fields", () => {
    expect(languageFromMetadata(JSON.stringify({ language: "en-IN" }))).toBe("en-IN");
    expect(languageFromMetadata(JSON.stringify({ languageCode: "gu-IN" }))).toBe("gu-IN");
  });

  it("ignores unrelated JSON", () => {
    expect(languageFromMetadata(JSON.stringify({ foo: "bar" }))).toBeUndefined();
  });
});

describe("resolveSessionLanguage", () => {
  it("defaults to Gujarati", () => {
    expect(resolveSessionLanguage({})).toBe(DEFAULT_LANGUAGE);
    expect(DEFAULT_LANGUAGE).toBe("gu-IN");
  });

  it("prefers participant attributes over room and job metadata", () => {
    expect(
      resolveSessionLanguage({
        participantAttributes: { language: "en-IN" },
        roomMetadata: JSON.stringify({ language: "hi-IN" }),
        jobMetadata: JSON.stringify({ language: "gu-IN" }),
      }),
    ).toBe("en-IN");
  });

  it("prefers room metadata over job metadata", () => {
    expect(
      resolveSessionLanguage({
        roomMetadata: JSON.stringify({ language: "hi-IN" }),
        jobMetadata: JSON.stringify({ language: "en-IN" }),
      }),
    ).toBe("hi-IN");
  });

  it("uses job metadata when nothing else is set", () => {
    expect(
      resolveSessionLanguage({
        jobMetadata: JSON.stringify({ language: "en-IN" }),
      }),
    ).toBe("en-IN");
  });
});
