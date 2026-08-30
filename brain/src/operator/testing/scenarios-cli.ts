import { CORE_EXAMPLE_PLAYBOOK_IDS, getPlaybooksDir, runScenarios } from "./harness.js";
import { loadPlaybooksFromDir } from "../playbooks/loader.js";

function pad(value: string, length: number): string {
  return value.padEnd(length, " ");
}

function printResults(results: Awaited<ReturnType<typeof runScenarios>>): void {
  const nameWidth = Math.max("Scenario".length, ...results.map((result) => result.name.length));
  const triageWidth = Math.max("Triage".length, ...results.map((result) => (result.triage ?? "-").length));

  console.log(`${pad("Result", 6)} ${pad("Scenario", nameWidth)} ${pad("Triage", triageWidth)} Actions`);
  console.log(`${pad("------", 6)} ${pad("-".repeat(nameWidth), nameWidth)} ${pad("-".repeat(triageWidth), triageWidth)} -------`);

  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL";
    const actions = result.ok ? (result.actions ?? []).join(", ") : (result.error ?? "Unknown error");
    console.log(`${pad(status, 6)} ${pad(result.name, nameWidth)} ${pad(result.triage ?? "-", triageWidth)} ${actions}`);
  }
}

function printExtras(): void {
  const coreIds = new Set<string>(CORE_EXAMPLE_PLAYBOOK_IDS);
  const extras = loadPlaybooksFromDir(getPlaybooksDir())
    .map((playbook) => playbook.id)
    .filter((id) => !coreIds.has(id))
    .sort((a, b) => a.localeCompare(b));

  if (extras.length === 0) {
    return;
  }

  console.log("");
  console.log("Extras beyond core examples:");
  for (const id of extras) {
    console.log(`- ${id}`);
  }
}

const results = await runScenarios();
printResults(results);
printExtras();

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
