import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { processSignal } from "../engine.js";
import { InMemoryJournal } from "../journal.js";
import { getPlaybookLoadErrors, loadPlaybooksFromDir } from "../playbooks/loader.js";
import { SignalSchema, type Playbook, type Signal } from "../types.js";

export const CORE_EXAMPLE_PLAYBOOK_IDS = [
  "deploy-sentinel",
  "ci-triage",
  "inbox-draft",
  "morning-brief",
  "calendar-hold",
  "orders-brief",
  "supply-watch",
  "docs-intake",
  "scope-reply",
  "weekly-digest",
  "deal-intake",
  "deadline-stack",
  "family-brief",
  "book-request",
  "lead-qualify",
  "reschedule",
  "dispute-pack",
  "issue-triage",
  "travel-shift",
] as const;

export type ScenarioFixture = {
  signal: Signal;
  expect: {
    playbookId: string;
    triageClass: string;
    actionCapabilities: string[];
  };
};

export type ScenarioResult = {
  name: string;
  ok: boolean;
  error?: string;
  triage?: string;
  actions?: string[];
};

function firstExistingDir(paths: string[]): string {
  const existing = paths.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
  if (!existing) {
    throw new Error(`None of these directories exist: ${paths.join(", ")}`);
  }

  return existing;
}

export function getPlaybooksDir(): string {
  return firstExistingDir([
    fileURLToPath(new URL("../../../../playbooks", import.meta.url)),
    fileURLToPath(new URL("../../../playbooks", import.meta.url)),
  ]);
}

export function getFixturesDir(): string {
  return firstExistingDir([
    fileURLToPath(new URL("./fixtures", import.meta.url)),
    fileURLToPath(new URL("../../../src/operator/testing/fixtures", import.meta.url)),
  ]);
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
}

function parseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a string array.`);
  }

  return value;
}

function parseFixture(raw: unknown): ScenarioFixture {
  assertRecord(raw, "fixture");
  assertRecord(raw.expect, "fixture.expect");

  const playbookId = raw.expect.playbookId;
  const triageClass = raw.expect.triageClass;
  if (typeof playbookId !== "string" || typeof triageClass !== "string") {
    throw new Error("fixture.expect.playbookId and fixture.expect.triageClass must be strings.");
  }

  return {
    signal: SignalSchema.parse(raw.signal),
    expect: {
      playbookId,
      triageClass,
      actionCapabilities: parseStringArray(raw.expect.actionCapabilities, "fixture.expect.actionCapabilities"),
    },
  };
}

export function loadFixtures(fixturesDir = getFixturesDir()): Array<{ name: string; fixture: ScenarioFixture }> {
  return fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".json")
    .map((entry) => {
      const filePath = path.join(fixturesDir, entry.name);
      const parsed = parseFixture(JSON.parse(fs.readFileSync(filePath, "utf8")));
      return { name: path.basename(entry.name, ".json"), fixture: parsed };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function assertSameArray(actual: string[], expected: string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} expected [${expected.join(", ")}], got [${actual.join(", ")}].`);
  }
}

async function runFixture(name: string, fixture: ScenarioFixture, playbooks: Playbook[]): Promise<ScenarioResult> {
  try {
    const journal = new InMemoryJournal();
    const result = await processSignal(fixture.signal, playbooks, {
      journal,
      createActionId: (() => {
        let next = 1;
        return () => `${name}-action-${next++}`;
      })(),
    });
    const match = result.matches.find((candidate) => candidate.playbookId === fixture.expect.playbookId);

    if (!match) {
      throw new Error(`Expected playbook ${fixture.expect.playbookId} to match.`);
    }

    const actions = match.actions.map((action) => action.capability);
    if (match.triage.class !== fixture.expect.triageClass) {
      throw new Error(`Expected triage ${fixture.expect.triageClass}, got ${match.triage.class}.`);
    }

    assertSameArray(actions, fixture.expect.actionCapabilities, "actionCapabilities");

    return {
      name,
      ok: true,
      triage: match.triage.class,
      actions,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runScenarios(): Promise<ScenarioResult[]> {
  const playbooks = loadPlaybooksFromDir(getPlaybooksDir());
  const loadErrors = getPlaybookLoadErrors();
  if (loadErrors.length > 0) {
    return loadErrors.map((error) => ({
      name: path.basename(error.file),
      ok: false,
      error: error.message,
    }));
  }

  const fixtures = loadFixtures();
  return Promise.all(fixtures.map(({ name, fixture }) => runFixture(name, fixture, playbooks)));
}
