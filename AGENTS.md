# TUI Safety

**Never use `console.debug/warn/error/log`** — writes to stdout/stderr corrupt pi's TUI ANSI rendering. Extension host runs in the same process.

Use `ctx.ui.notify()` / `setStatus()` / `setWidget()` instead. For diagnostics, remove entirely.
