# Contributing

## Adding a new agent CLI (provider)

Agents run on a *provider*: an adapter for one coding-agent CLI (Claude Code, Codex, Cursor, opencode, ...). Adding one takes a single file and a one-line registration — no changes to the server, routes or UI.

1. Create `src/server/infrastructure/providers/<name>.ts` exporting a `Provider` (see `types.ts`):
   - `id`, `label`, `models` (suggestions only), `binaryNames` (looked up on PATH, or via `<ID>_BIN`).
   - `listModels(bin)` (optional) asks the CLI which models it currently offers; the result replaces `models` for five minutes. Use it when the CLI has a listing command (`opencode models`), so the picker follows the user's installed providers and logins.
   - `buildArgs(ctx)` returns the CLI arguments for one task. Use `ctx.task.prompt`, `ctx.agent.sessionId` (resume), `ctx.agent.model`, `ctx.agent.permissionMode` (`acceptEdits` / `bypassPermissions` / `plan` / `default`, map it to the CLI's own flags) and `ctx.cwd`. If the CLI has no system-prompt flag, prepend `ctx.systemPrompt` with `withSystemPrompt()`.
   - `errors` lists how the CLI reports trouble, as data: `{ kind, pattern, exitCode? }` rules with `kind` one of `limit`, `auth`, `permission`, `other`, first match wins. Put the CLI's own wording first and end with `...COMMON_ERRORS` (`errors.ts`). Add real message samples to `errors.test.ts`.
   - `versionArgs` (optional) is the health check; it must exit 0 and print the version. Defaults to `--version`.
   - `createParser()` returns a per-run function that turns one stdout line into neutral `ProviderEvent`s (`session`, `text`, `tool`, `tool-error`, `result`). It must ignore lines it does not understand. Put the run's total so far in `result.costUsd`, on failed results too, and leave it out when the CLI reports none (the task then shows *cost unknown*, not $0). Prefer the CLI's JSONL/stream-json output.
   - `delegation`: `true` only if the CLI can load the office MCP server (`ctx.mcp`) for a single run, so the agent can use `list_team` / `delegate_task` / `task_status`.
2. Register it in `src/server/infrastructure/providers/index.ts` (`PROVIDERS`).
3. Add fixtures to `src/server/infrastructure/providers/providers.test.ts`: sample output lines for your parser and an args check. The generic contract test already covers every registered provider.
4. Run `npm run typecheck && npm test`, and mention the CLI version you verified against in the PR.

The UI picks the new provider up automatically (provider and model fields in the hiring form).

## Development

`npm run typecheck` and `npm test` must pass. Code identifiers and comments are in English; every user-facing string goes through `src/shared/i18n/` (add the key to both `tr.ts` and `en.ts`; the type checker enforces it).
