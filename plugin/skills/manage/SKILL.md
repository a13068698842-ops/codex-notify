---
name: manage-codex-notify
description: Manage Codex Notify on Windows, inspect its connections, or register and unregister a local Codex Desktop chat.
---

Use the installed CLI at `%LOCALAPPDATA%\Programs\CodexNotify\codex-notify.cmd`. In PowerShell:

```powershell
$notify = Join-Path $env:LOCALAPPDATA 'Programs\CodexNotify\codex-notify.cmd'
& $notify status
```

Use `status` to distinguish the background process from the Desktop and Feishu connections. Use `doctor` for compatibility, local data and Feishu REST checks. When requested, use `watch <chat UUID or codex://threads/...>` for a local desktop chat already open, and `unwatch` to stop following it.

Use `init` to open the local Feishu setup window. On first setup, the user scans with Feishu, confirms creation in Feishu, and clicks the test card; this starts the background process. The user can also enter their own credentials in manual setup. Use `start` to resume, `stop` to stop until the next explicit or scheduled start, or `disable` to pause and remove login startup. The user manages plugin enablement and hook trust in the Codex desktop UI. Never include Feishu credentials in commands, chat or logs.
