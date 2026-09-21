const FIRST_RUN_KEY = "dialy.web.first-run.v1";

export function hasCompletedFirstRun(): boolean {
  return localStorage.getItem(FIRST_RUN_KEY) === "1";
}

export function markFirstRunComplete(): void {
  localStorage.setItem(FIRST_RUN_KEY, "1");
}
