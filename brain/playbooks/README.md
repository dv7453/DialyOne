# Dialy Operator playbooks

These files are example playbooks for the Dialy Operator. They are a starter library, not a closed set or a product boundary.

Add a new `.json`, `.yaml`, or `.yml` playbook in this directory to cover a new scenario without changing TypeScript. The loader validates each file with `PlaybookSchema`, and the scenario harness replays fixtures offline so examples stay reliable before live accounts are connected.

For each new playbook:

1. Pick a stable `id`.
2. Add deterministic `triage.rules` before relying on a model.
3. Configure `minor`, `needs_human`, and `ignore` policy classes.
4. Keep consequential actions approval-gated.
5. Add a matching fixture in `src/operator/testing/fixtures/`.
