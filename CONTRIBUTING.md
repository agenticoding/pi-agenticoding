# Contributing to pi-agenticoding

Welcome! This project welcomes focused, well-validated contributions. Use coding agents deliberately: research before editing, keep changes small, follow existing patterns, and document the validation you ran.

## Development Principles

- **Use code research first** — understand the surrounding module responsibilities before editing.
- **Make minimal changes** — prefer targeted edits that reuse existing mechanisms.
- **Match existing patterns** — keep naming, lifecycle hooks, tool contracts, and TUI behavior consistent with the current code.
- **Preserve context-management semantics** — changes to `spawn`, `notebook`, or `handoff` should keep the agent workflow predictable across session resets and compaction.
- **Use static imports only for `spawn/renderer.ts`** — it registers the frame scheduler into the singleton container at module evaluation time. Switching to `await import()` will silently break test isolation because the test harness cannot overwrite the singleton before registration.
- **AI-agent generated contributions are welcome** — include enough human intent and validation context in the PR for reviewers to trust the result.

## Suggested Workflow

1. **Research the area**
   - Identify the relevant primitive: spawn, notebook, handoff, watchdog, or extension wiring.
   - Read the relevant suite in `tests/unit/` before changing behavior.

2. **Plan the smallest safe change**
   - Reuse existing state and lifecycle hooks when possible.
   - Avoid adding dependencies unless the change clearly needs them.

3. **Implement with tests or validation**
   - Add or update tests for behavior changes.
   - For documentation-only changes, review rendered links and examples.

4. **Submit a focused PR**
   - Explain why the change is needed.
   - Link the related issue or discussion when one exists.
   - List the validation you ran, or explain why a test command was not applicable.

## Quality Bar

Before submitting, check that your change:

- Keeps public tool names and contracts stable unless the PR explicitly proposes a breaking change.
- Does not introduce hidden context growth, unbounded output, or recursive child-agent spawning.
- Handles reset, cancellation, and stale-session cases where relevant.
- Keeps docs aligned with the package version and installed behavior.

## Tests

- `npm test` — runs the unit suite under `tests/unit/` via the in-repo Node test runner.
- `npm run test:snapshots:check` — runs only the render-snapshot tests; fails on any drift in `tests/__snapshots__/`.
- `npm run test:snapshots:update` — rewrites the golden files in `tests/__snapshots__/` after an intentional render change. Review the diff carefully: snapshot updates are the only signal that catches unintended UI regressions.
- `npm run test:e2e` — runs the process-isolated end-to-end suite under `tests/e2e/`.

## CI

Pull requests are automatically tested via GitHub Actions. The pipeline runs:

1. **Quick-check** (Ubuntu, Node 22): `npm ci`, type check (`npx tsc --noEmit`), and security audit (`npm audit`). Catches trivial failures before the full matrix.
2. **Cross-platform matrix** (depends on quick-check): Unit tests on Ubuntu (Node 22 + 24), macOS (Node 24), and Windows (Node 24). E2E tests on all platforms.

Snapshot golden files in `tests/__snapshots__/` are stored with LF line endings (enforced by `.gitattributes`). The `normalizeEOL` helper in the snapshot test file normalizes `\r\n` to `\n` on read, so Windows developers get correct comparisons even if their working tree has CRLF. If you update snapshots, the CI matrix validates them on all platforms.
The E2E suite runs on all platforms including Windows (verified in issue #12).

## Community

Use GitHub Issues for bug reports and feature requests. Keep discussions concrete: describe the agent workflow you expected, what happened instead, and any reproduction steps.

## License

By contributing to this project, you agree that your contributions will be licensed under the same MIT License as pi-agenticoding.
