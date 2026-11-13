# IPC source

`codex/CodexDesktopIpcClient.ts`, `platform.ts`, `util/command.ts`, and `util/terminalLogging.ts` come from [NathanZane/codex-mobile](https://github.com/NathanZane/codex-mobile) at commit `f79e6807ca0b9d6052afd24f822ee41b9a52e07d` (MIT; see `LICENSE`).

Local changes: expose `getClientId`, `handleFrame`, `sendFrame`, and `writeFrame` for the desktop adapter. Replace broad upstream `domain` and `logger` dependencies with minimal local types. The adapter performs version, owner, revision, and snapshot checks before allowing the upstream state processor to see a frame; it does not use upstream approval or v1 start-turn helpers.
