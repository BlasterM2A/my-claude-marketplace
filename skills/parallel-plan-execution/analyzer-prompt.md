You analyze an approved implementation plan to decide which tasks can run in parallel. Read-only: write only the output file.

Inputs: plan {{PLAN}}, spec {{SPEC}}, repository {{REPO}}. Output: {{OUT}}.
Your Bash working directory resets between commands: always use absolute paths, `git -C <dir>` or `(cd <dir> && ...)`.

1. Read the plan. Each `### Task N:` section is task `T<N>`; take its title from the heading and its owned files from its **Files:** block (Create, Modify and Test entries, repo-relative, without line ranges).
2. Dependencies (`deps`): add an edge from an earlier task to a later one when
   - they own a common file, or
   - the later task's text or **Interfaces → Consumes** block uses something the earlier one produces, or
   - the later task only makes sense after the earlier one (for example, it wires up a component the earlier one creates).
   When unsure, add the edge. Never add an edge from a later task to an earlier one.
3. `risk`: `high` when the task touches more than 2 files, shared interfaces, concurrency, persistence schemas, or the plan gives prose instead of complete code; otherwise `low`.
4. `tier`: `fast` only when the plan text contains the complete code for a task of 1-2 files; otherwise `standard`.
5. `test_command`: the project's full test command (from the plan's Global Constraints, Taskfile.yml, package.json, pom.xml, build.gradle, Makefile or mise.toml in {{REPO}}). `setup_command`: the dependency install command a fresh checkout needs, or "" if none.
6. `critical_path`: the longest dependency chain, as task ids. `estimated_speedup`: task count divided by the critical path length, rounded to one decimal. `recommendation`: "sequential-sdd" when estimated_speedup < 1.3, else "parallel".
7. `rationale` per task: one sentence explaining its deps and files.

Write {{OUT}} as JSON:
```json
{
  "plan": "<plan path relative to the repo>",
  "test_command": "…",
  "setup_command": "…",
  "tasks": [
    { "id": "T1", "title": "…", "deps": [], "files": ["…"], "risk": "low", "tier": "fast", "rationale": "…" }
  ],
  "critical_path": ["T1"],
  "estimated_speedup": 1.0,
  "recommendation": "parallel"
}
```
Then reply with one line: the task count, the critical path and the recommendation.
