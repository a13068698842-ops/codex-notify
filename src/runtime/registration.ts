import { basename, isAbsolute } from 'node:path';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { THREAD_RE, threadIdFrom } from '../desktop/protocol.js';
import { localTranscriptPath, sameLocalPath } from '../desktop/transcript.js';

export type Registration = { threadId: string; cwd: string; transcriptPath: string | null };

export function fromControl(input: unknown): (Registration & { source: 'hook' | 'manual' }) | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { threadId, cwd, transcriptPath, source } = input as Record<string, unknown>;
  if (typeof threadId !== 'string' || !THREAD_RE.test(threadId) || typeof cwd !== 'string' ||
      !isAbsolute(cwd) || cwd.includes('\0') || cwd.length > 32767 ||
      (source !== undefined && source !== 'manual')) return null;
  const id = threadId.toLowerCase();
  if (transcriptPath !== null && (!localTranscriptPath(transcriptPath, id) || transcriptPath.includes('\0')))
    return null;
  return { threadId: id, cwd, transcriptPath, source: source === 'manual' ? 'manual' : 'hook' };
}

export function fromHook(input: unknown): Registration | null {
  if (!input || typeof input !== 'object') return null;
  const data = input as Record<string, unknown>;
  if (!['SessionStart', 'UserPromptSubmit'].includes(String(data.hook_event_name))) return null;
  if (typeof data.session_id !== 'string' || typeof data.cwd !== 'string' || !isAbsolute(data.cwd)) return null;
  let threadId: string;
  try { threadId = threadIdFrom(data.session_id); } catch { return null; }
  const path = typeof data.transcript_path === 'string' && data.transcript_path ? data.transcript_path : null;
  if (path && (!isAbsolute(path) || !basename(path).toLowerCase().includes(threadId))) return null;
  return { threadId, cwd: data.cwd, transcriptPath: path };
}

export function transcriptBelongs(registration: Registration): boolean {
  if (!localTranscriptPath(registration.transcriptPath, registration.threadId)) return false;
  let fd: number | undefined;
  try {
    fd = openSync(registration.transcriptPath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytes).indexOf(10);
    if (end < 0) return false;
    const first = JSON.parse(buffer.toString('utf8', 0, end));
    return first.type === 'session_meta' && first.payload?.id === registration.threadId &&
      typeof first.payload?.cwd === 'string' && sameLocalPath(first.payload.cwd, registration.cwd);
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function verifiedTranscript(registration: Registration): unknown[] | null {
  if (!transcriptBelongs(registration) || !registration.transcriptPath) return null;
  try {
    const text = readFileSync(registration.transcriptPath, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!text.endsWith('\n')) lines.pop(); // Writer may still be appending the last record.
    return lines.map(line => JSON.parse(line));
  } catch { return null; }
}
