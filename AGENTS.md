# Repository Guidelines

## Project Structure & Module Organization

This repository currently contains planning documents only; source code, tests, assets, and package configuration have not been added.

- `docs/plan.md`: overall scope, architecture, and acceptance criteria.
- `docs/feature/*.md`: nine feature specifications, named in Korean by feature.
- When implementing, place TypeScript modules in `src/` and tests in `tests/`, organized by feature.

Read the relevant feature document before making changes. Keep Mattermost transport, task management, mail collection, GMS summarization, scheduling, and SQLite persistence separate. The target is a single Node.js process serving one authorized user through DM.

## Build, Test, and Development Commands

No build or runtime commands are available yet. During scaffolding, define and document these package scripts before relying on them:

- `npm run dev`: run the bot locally during development.
- `npm run build`: compile TypeScript.
- `npm run typecheck`: check types without emitting files.
- `npm test`: run automated tests with mocked external services.

For documentation changes, run `git diff --check` and verify relative Markdown links.

## Coding Style & Naming Conventions

Use TypeScript with strict type checking, two-space indentation, `camelCase` variables and functions, and `PascalCase` types. Use descriptive module names such as `newsletter-collector.ts`. Preserve Korean user-facing commands and documentation terminology. No formatter or linter is configured; document any tooling introduced with scaffolding.

## Testing Guidelines

No test framework or coverage threshold is established. Name tests `*.test.ts` and mirror source features under `tests/`. Mock Mattermost, IMAP, GMS, and time. Cover authorization, task operations, duplicate events, restart recovery, `Asia/Seoul` scheduling, malformed mail, and API failures. Keep live integration checks separate from automated tests; never require real credentials for unit tests.

## Commit & Pull Request Guidelines

There are no commits yet, so no historical convention exists. Use concise imperative subjects, optionally prefixed with `docs:`, `feat:`, or `fix:`. Keep changes focused. PRs should explain the behavior changed, reference relevant feature documents and issues, and report validation results and remaining limitations.

## Security & Configuration

Keep credentials in `.env`; commit only placeholders in `.env.example`. Extend ignore rules before adding SQLite files or build artifacts. Never log tokens or private mail bodies. Treat newsletter content as untrusted data, preserve mailbox state, and restrict bot commands to the configured user. Keep task management available during mail or GMS failures.
