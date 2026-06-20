# AGENTS.md

## Project Overview

OpenCowork is an open-source desktop platform for multi-agent AI collaboration. It provides local tools (file I/O, shell, code search), parallel sub-agent orchestration, and workplace messaging integration (Feishu, DingTalk, Discord, QQ, Telegram, WeCom, Weixin, WhatsApp). Built with Electron + React + Node.js.

**Target users:** Developers who want AI agents to work directly in their local codebase with tool access, context awareness, and human-in-the-loop approvals.

## Tech Stack

| Layer    | Technology                       | Version |
| -------- | -------------------------------- | ------- |
| Runtime  | Electron                         | 36.9.5  |
| Frontend | React                            | 19.2.4  |
| Language | TypeScript                       | strict  |
| State    | Zustand                          | -       |
| Styling  | Tailwind CSS v4                  | -       |
| Editor   | Monaco Editor                    | -       |
| Terminal | xterm.js                         | 6.x     |
| Database | better-sqlite3                   | -       |
| i18n     | react-i18next                    | en/zh   |
| Build    | electron-vite + electron-builder | -       |
| Node.js  | >= 18                            | -       |

## Project Structure

```
src/
├── main/              # Electron main process (system layer)
│   ├── index.ts       # App bootstrap, window lifecycle
│   ├── channels/      # 8 messaging platform plugins
│   ├── cron/          # Scheduled task agent runtime
│   ├── db/            # SQLite DAOs (messages, sessions, projects, tasks, plans)
│   ├── ipc/           # IPC handlers (main↔renderer bridge)
│   ├── mcp/           # Model Context Protocol client
│   └── ssh/           # SSH/terminal support
├── preload/           # Secure bridge (narrow API surface)
├── renderer/src/      # React 19 UI
│   ├── components/    # UI components (chat, cowork, settings, ssh, tasks)
│   ├── hooks/         # React hooks
│   ├── lib/           # Agent loop, tools, API clients, utilities
│   ├── locales/       # i18n JSON files (en/zh, 7 namespaces)
│   └── stores/        # Zustand stores
└── shared/            # Cross-process TypeScript contracts
```

**Entry points:** `src/main/index.ts` (main), `src/renderer/src/App.tsx` (renderer)

## Architecture

- **4-layer Electron app:** Main process (system access) → Preload (secure bridge) → Renderer (UI) → Agent runtime (main process)
- **IPC pattern:** Renderer calls `ipcClient.invoke(channel)`, main handles in `src/main/ipc/*-handlers.ts`
- **Agent runtime:** Runs in main process (`js-agent-runtime.ts`), not renderer. Provider-agnostic, accepts generic provider object.
- **Tool system:** Renderer-side tools in `src/renderer/src/lib/tools/`, registered in phases (core → skills → sub-agents → teams)
- **Session modes:** `chat`, `clarify`, `cowork`, `code`, `acp` — each configures different prompts/tools/UI
- **Channel plugins:** Extend `base-plugin-service.ts`, implement `onStart()`, `onStop()`, messaging methods

## Coding Rules

- **Formatting:** Prettier — single quotes, no semicolons, 100-col width, no trailing commas
- **EditorConfig:** UTF-8, LF, 2 spaces, final newline
- **Naming:** React components = PascalCase (`Layout.tsx`), stores/helpers = kebab-case (`chat-store.ts`)
- **Commits:** Conventional — `feat(scope):`, `fix(scope):`, `chore(scope):`
- **Path aliases:** `@renderer/*` → `src/renderer/src/*`
- **i18n:** Use `t('key', { defaultValue: 'English text' })` — never hardcode Chinese in UI
- **No tests:** There is no test suite. Validate with `npm run typecheck` and `npm run lint`

## Key Commands

```bash
npm run dev          # Start Electron + Vite with hot reload
npm run build        # Typecheck then build
npm run build:win    # Full Windows installer
npm run lint         # ESLint with cache
npm run typecheck    # TypeScript check (both main and renderer)
npm run format       # Prettier
```

## Gotchas

- **Native modules:** `better-sqlite3`, `@jitsi/robotjs`, `ssh2`, `node-pty` require rebuild for Electron version via `npm run postinstall`. On Windows, `node-pty` is skipped.
- **Data directory:** `~/.open-cowork/` — contains SQLite DB (`data.db`), config, agents, commands, prompts. Never commit this.
- **SQLite schema:** Evolves via additive `ensureColumn` calls — columns are added if absent, never dropped. No migration files.
- **i18n language:** Detected from OS locale on first launch. Chinese-locale systems default to Chinese. Change in Settings → General → Language.
- **Dev server:** First launch compiles 98+ React modules (~30s). Subsequent launches are fast due to Vite dep caching.
- **Zoom:** Ctrl/Cmd +/- for keyboard zoom (75%-200%), trackpad pinch for visual zoom (1x-5x). Configured in `src/main/index.ts`.
- **Security:** Never commit secrets, private keys, `.env` files, or local runtime data from `~/.open-cowork/`.
