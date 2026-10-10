# typescript-native-lsp

Code intelligence for TypeScript and JavaScript in Claude Code (diagnostics, hover, go to definition, references, document symbols) through the native language server that ships with TypeScript 7: `tsc --lsp --stdio`.

It replaces `typescript-lsp@claude-plugins-official`. That plugin runs `typescript-language-server`, which needs `lib/tsserver.js`; TypeScript 7 is the native (Go) compiler and no longer includes it, so the server fails to initialize with "Could not find a valid TypeScript installation".

## Install

```bash
claude plugin install typescript-native-lsp@blasterm2a
claude plugin disable typescript-lsp@claude-plugins-official
```

Disable the official plugin so only one server handles the same file extensions. Restart Claude Code afterwards (or run `/reload-plugins`).

## Requirements

- TypeScript 7.0 or later with `tsc` on the `PATH` of the process that launches Claude Code, for example `npm install -g typescript` or `bun add -g typescript`. Check with `tsc --version`.
- The `PATH` matters when Claude Code is started by another program (a desktop app, an agent manager, a service): it may not read your shell profile, so add the directory of the global `tsc` to the environment of that program.

## Covered files

`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs`, the same set as the official plugin.
