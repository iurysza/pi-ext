# Spec-driven workflow: OpenSpec + taskflow

A reproducible pipeline for turning an idea into implemented, verified code inside
Pi. **OpenSpec** owns the spec (propose → specs → tasks → archive); **taskflow**
(`pi-taskflow`) owns the gated implement loop that turns those tasks into code and
only reports back when build/test and an acceptance gate pass.

Both run natively on Pi. The glue is deliberately thin — two OpenSpec CLI calls
(`instructions apply --json`, `validate --strict`) and file pre-reading — so if you
ever drop taskflow, the specs and tasks stay useful and you rewrite only the
orchestration.

## One-time setup

Already done in this repo, but to reproduce elsewhere:

```bash
npm i -g @fission-ai/openspec@latest      # OpenSpec CLI (needs v1.2+ for Pi + JSON)
openspec init --tools pi                  # scaffolds openspec/ + /opsx-* prompts + skills into .pi/
pi install npm:pi-taskflow                # taskflow extension → /tf commands + `taskflow` tool
```

Copy `.pi/taskflows/*.json` into any repo you want the flows in (they're
project-scoped). Optionally run `/tf init` in a Pi session to map taskflow's model
roles (`{{fast}}`, `{{strong}}`, …) to specific models — **not required**: agents
fall back to your Pi default model (Opus 4.8 here) when roles are unset.

## The loop, end to end

1. **Propose** — in a Pi session: `/opsx-propose "add a foo command that …"`.
   OpenSpec (via the agent) writes `openspec/changes/<id>/` with `proposal.md`,
   spec deltas under `specs/`, and a `tasks.md` checklist. Review and edit it —
   this is where you spend your judgment. Nothing is phase-locked; edit artifacts
   any time. (`/opsx-*` commands are pure OpenSpec — installed by `openspec init`,
   fully independent of taskflow.)

   **The change id** is the folder name under `openspec/changes/` — the agent
   picks a kebab-case id (e.g. `add-foo-command`) and reports it. `openspec list`
   shows all active changes with task progress if you forget.

2. **Implement** — `/tf:openspec-implement change=<id>` (or the per-task
   `/tf:openspec-implement-loop`). taskflow implements the tasks, runs your
   build/test command, validates the spec, fans out a **multi-angle, multi-model
   review panel**, and runs an arbiter gate that re-runs implementation on
   `BLOCK` (self-healing). Only the final summary returns to your context —
   intermediate transcripts stay in the runtime.

3. **Human review** — `/plannotator-review` opens the working-tree diff in
   plannotator's code-review UI: annotate lines, switch diff views, send feedback
   back to the agent. This is the human gate before specs get rewritten.

4. **Archive** — when you're satisfied: `openspec archive <id>`. Delta specs
   merge into `openspec/specs/` (the source of truth) and the change moves to
   `openspec/changes/archive/`.

## The two flows

Both live in `.pi/taskflows/` and take the same args.

| | `openspec-implement` | `openspec-implement-loop` |
|---|---|---|
| Shape | One `implement` phase for the whole change, then review panel + arbiter gate with self-healing retry (≤2 rounds) | One task per iteration, **fresh context each time**, then review panel + arbiter gate |
| Best for | Small/medium changes (a handful of tasks) | Large multi-task changes where one context would degrade |
| Cost cap | `budget.maxUSD: 8` | `budget.maxUSD: 12` |
| Mechanism | Archetype 2 (self-healing implement→verify→rework) | `loop` + `reflexion` (each round sees why the last fell short) |

**Args (both):**

- `change` (required) — the OpenSpec change id under `openspec/changes/<id>`.
- `verify` (optional) — the shell command for the build/test gate. Default
  `npm run test:pi-sem 2>&1 | tail -30` suits **this** repo. **Override it per
  project**, e.g.:

  ```
  /tf:openspec-implement change=add-foo verify="npx tsc --noEmit && npm test"
  ```

### Phase map (both flows)

```
load (script: openspec instructions apply --json)
      │
implement / task-loop  (executor-code — reads proposal, design, tasks, spec deltas)
      │
      ├── build-test    (script: your verify command)
      ├── spec-validate (script: openspec validate --strict)
      └── diff          (script: git status + git diff HEAD)
                │
      ┌─────────┼──────────────┐            ← review panel, runs in parallel
review-spec  review-simplicity  review-security
(gpt-5.5)    (glm-5.2)          (kimi k2p7)
      └─────────┼──────────────┘
                │
spec-gate / acceptance-gate  (final-arbiter — consolidates all evidence,
      │                       VERDICT: PASS/BLOCK)
      │   └─ on BLOCK: re-runs implement + panel (≤2 rounds)
      │
summary  (doc-writer — final; suggests /plannotator-review + openspec archive)
```

### Review panel (multi-angle, multi-model)

dev-loops-style review angles, each a separate phase with its **own model** so
the panel is diverse — different model families catch different failure modes,
and none of them is the model that wrote the code:

| Phase | Angle | Agent | Model |
|---|---|---|---|
| `review-spec` | every requirement/scenario has implementation evidence (file:line); tasks genuinely done | `reviewer` | `openai-codex/gpt-5.5` |
| `review-simplicity` | KISS/YAGNI/DRY — over-engineering, dead code, scope creep | `critic` | `zai/glm-5.2` |
| `review-security` | injection, unsafe exec, path traversal, secret leaks, input validation | `security-reviewer` | `kimi-coding/k2p7` |
| `spec-gate` | consolidates panel + build/test + diff into one verdict | `final-arbiter` | pi default (Opus) |

Notes:

- **Changing models**: edit the phase's `"model"` field in the flow JSON
  (`provider/model-id` form; the model must work in your pi setup — check
  `enabledModels` in `~/.pi/agent/settings.json`).
- **Adding an angle** (dry, srp, docs, …): copy one `review-*` phase, change the
  id/task/model, and add the new id to the gate's `dependsOn` plus a
  `{steps.<id>.output}` section in the gate task.
- Review phases are `optional: true` and read-only (`tools: read/grep/ls`): a
  missing/failing model degrades to a skipped review instead of killing the run.
  The arbiter is told to flag skipped reviews and not treat silence as approval.
- Reviewers get the diff inline; untracked (new) files show only in the status
  list, so reviewer prompts tell them to read those files themselves.

## Command reference

| Command | What |
|---|---|
| `/opsx-propose "<idea>"` | Create a change (proposal + specs + tasks) |
| `/opsx-explore "<question>"` | Investigate before proposing |
| `/opsx-apply` | Interactive, agent-driven implement (no gates) — good for tiny changes |
| `/opsx-sync` | Sync spec deltas into main specs |
| `/opsx-archive` | Archive a completed change |
| `/tf:openspec-implement change=<id> [verify="…"]` | Gated implement, whole-change |
| `/tf:openspec-implement-loop change=<id> [verify="…"]` | Gated implement, one task at a time |
| `/plannotator-review` | Human code-review UI over current git changes (before archive) |
| `/tf verify` | Static-check a flow (cycles, refs, contracts) — zero tokens |
| `/tf runs` / `/tf resume <runId>` | List runs / resume a paused or failed run |
| `/tf peek <runId> [phaseId]` | Inspect a run's intermediate outputs |
| `openspec list [--json]` | List changes + task progress |
| `openspec instructions apply --change <id> --json` | Context files + pending tasks (what `load` runs) |
| `openspec validate <id> --strict` | Structural spec validation |

## When to use which

- **Tiny change, want to watch it live** → `/opsx-apply` in the session. No flow
  overhead, you can steer mid-stream.
- **Normal change, want it verified unattended** → `/tf:openspec-implement`.
- **Large change, many tasks** → `/tf:openspec-implement-loop`.

## Notes & gotchas

- **`verify` default fails on repos without `test:pi-sem`.** It's set for this
  repo. On any other project, pass `verify=` or edit the flow's arg default.
- **Gates fail open on ambiguity** — an unparseable verdict is treated as PASS.
  The gate prompts demand an explicit `VERDICT: PASS/BLOCK` and say "if uncertain,
  BLOCK" to counter this. A false PASS is the one genuinely costly failure mode
  here; everything else just costs a retry.
- **The implement prompt forbids weakening tests** and tells the agent to *stop
  and report* a genuine spec gap rather than silently invent behavior — so the
  spec stays the source of truth, not post-hoc documentation.
- **Detached/headless runs auto-reject `approval` phases.** Neither flow uses
  approval; if you add one, don't run detached.
- **Archiving is manual** (`openspec archive <id>`) — deliberately, so a human
  confirms before specs are rewritten. Run `/plannotator-review` on the diff
  first as the human gate.
- **Runtime state is gitignored, definitions are versioned.** `.pi/taskflows/*.json`,
  `.pi/prompts/opsx-*`, and `.pi/skills/openspec-*` are committed;
  `.pi/taskflows/runs/`, `.pi/tasks/`, sessions, etc. stay ignored (see `.gitignore`).

## Ideas for later

- **Test-first gate**: add a phase before implementation that generates failing
  tests from the change's GIVEN/WHEN/THEN scenarios, plus a `script` gate asserting
  they fail (red) — then the acceptance gate becomes objective (tests are truth,
  not the reviewer's opinion). Add a `git diff --stat` guard so the agent can't
  "pass" by weakening those tests.
- **Batch mode**: `openspec list --json` → queue changes → run flows detached
  overnight → review branches in the morning. Try it only after a few weeks of
  manual runs, once you trust how often the gates lie.
