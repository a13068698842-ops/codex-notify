import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { transcriptBelongs, type Registration } from './registration.js';

export function registrationFile(): string {
  const base = process.env.LOCALAPPDATA;
  if (!base) throw new Error('LOCALAPPDATA is required for local registrations.');
  return join(base, 'CodexNotify', 'registrations.json');
}

export function registerLocal(registration: Registration, file = registrationFile()): void {
  if (registration.transcriptPath && !transcriptBelongs(registration))
    throw new Error('Transcript metadata does not match the desktop chat.');
  const existing: Registration[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  if (!Array.isArray(existing)) throw new Error('Registration file is invalid.');
  const records = existing.filter(r => r.threadId !== registration.threadId);
  records.push(registration);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(records, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, file);
}
