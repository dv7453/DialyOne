import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ZEvalSuite, type EvalSuite, type EvalTask, type VoiceUtterance } from "./types.js";

function here(...parts: string[]): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), ...parts);
}

function fixtureFile(name: string): string {
  const candidates = [
    here("fixtures", name),
    path.join(process.cwd(), "src", "eval", "fixtures", name),
    path.resolve(here("../..", "src", "eval", "fixtures", name)),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Missing eval fixture ${name}. Looked in: ${candidates.join(", ")}`);
  }
  return found;
}

export function loadSuite(filePath = fixtureFile("suite.json")): EvalSuite {
  const parsed = ZEvalSuite.parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
  const ids = new Set<string>();
  for (const task of parsed.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate eval task id: ${task.id}`);
    }
    ids.add(task.id);
  }
  return parsed;
}

export function loadUtterances(filePath = fixtureFile("utterances.json")): VoiceUtterance[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as VoiceUtterance[];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("utterances.json must be a non-empty array.");
  }
  return raw;
}

export function taskById(suite: EvalSuite, id: string): EvalTask {
  const task = suite.tasks.find((entry) => entry.id === id);
  if (!task) {
    throw new Error(`Unknown eval task: ${id}`);
  }
  return task;
}
