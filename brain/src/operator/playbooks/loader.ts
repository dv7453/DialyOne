import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { PlaybookSchema, type Playbook } from "../types.js";

type YamlModule = {
  parse: (source: string) => unknown;
};

let parseYaml: YamlModule["parse"] | null = null;

try {
  const yaml = (await import("yaml")) as YamlModule;
  parseYaml = yaml.parse;
} catch {
  parseYaml = null;
}

export type PlaybookLoadError = {
  file: string;
  message: string;
};

let loadedPlaybooks = new Map<string, Playbook>();
let lastLoadErrors: PlaybookLoadError[] = [];

function isPlaybookFile(fileName: string): boolean {
  return [".json", ".yaml", ".yml"].includes(path.extname(fileName).toLowerCase());
}

function parsePlaybookFile(filePath: string): unknown {
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, "utf8");

  if (ext === ".json") {
    return JSON.parse(raw);
  }

  if ((ext === ".yaml" || ext === ".yml") && parseYaml) {
    return parseYaml(raw);
  }

  throw new Error("YAML playbooks require the optional 'yaml' package; JSON playbooks still load.");
}

function describeZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}

export function loadPlaybooksFromDir(dir: string): Playbook[] {
  const nextPlaybooks = new Map<string, Playbook>();
  const errors: PlaybookLoadError[] = [];

  if (!fs.existsSync(dir)) {
    loadedPlaybooks = nextPlaybooks;
    lastLoadErrors = [{ file: dir, message: "Playbook directory does not exist." }];
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isPlaybookFile(entry.name)) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    try {
      const parsed = parsePlaybookFile(filePath);
      const result = PlaybookSchema.safeParse(parsed);
      if (!result.success) {
        errors.push({ file: filePath, message: describeZodError(result.error) });
        continue;
      }

      nextPlaybooks.set(result.data.id, result.data);
    } catch (error) {
      errors.push({ file: filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }

  loadedPlaybooks = nextPlaybooks;
  lastLoadErrors = errors;
  return Array.from(loadedPlaybooks.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function getPlaybook(id: string): Playbook | undefined {
  return loadedPlaybooks.get(id);
}

export function listPlaybooks(): Playbook[] {
  return Array.from(loadedPlaybooks.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function getPlaybookLoadErrors(): PlaybookLoadError[] {
  return [...lastLoadErrors];
}
