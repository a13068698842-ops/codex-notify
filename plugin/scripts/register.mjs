import net from 'node:net';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 64 * 1024) process.exit(0);
}
try {
  if (!process.env.LOCALAPPDATA) process.exit(0);
  const control = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, 'CodexNotify', 'control.json'), 'utf8'));
  if (control.version !== 1 || typeof control.pipe !== 'string' || !control.pipe.startsWith('\\\\.\\pipe\\') ||
      typeof control.token !== 'string' || !control.token || control.token.length > 256) process.exit(0);
  // Windows PowerShell's redirected child stdin may start with a UTF-8 BOM.
  const event = JSON.parse(input.replace(/^\uFEFF/, ''));
  const id = event.session_id?.toLowerCase();
  if (!['SessionStart', 'UserPromptSubmit'].includes(event.hook_event_name) || !uuid.test(id) ||
      !isAbsolute(event.cwd)) process.exit(0);
  const path = typeof event.transcript_path === 'string' ? event.transcript_path : null;
  if (path && (!isAbsolute(path) || !basename(path).toLowerCase().includes(id))) process.exit(0);
  const socket = net.connect(control.pipe);
  socket.setTimeout(350);
  socket.on('connect', () => socket.write(JSON.stringify({
    token: control.token, command: 'register', registration: { threadId: id, cwd: event.cwd, transcriptPath: path },
  }) + '\n'));
  socket.resume();
  socket.on('error', () => {});
  socket.on('timeout', () => socket.destroy());
  await new Promise(resolve => {
    const timer = setTimeout(() => socket.destroy(), 500);
    socket.on('close', () => { clearTimeout(timer); resolve(); });
  });
} catch { /* Hooks must never interrupt the Codex turn. */ }
