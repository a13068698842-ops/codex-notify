import { open } from 'node:fs/promises';
import { basename, isAbsolute, normalize } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { NativeResultMatcher, type NativeReceiptExpectation } from './receipts.js';

const maxRecordLength = 8 * 1024 * 1024;
const windowsDrivePath = /^(?:\\\\\?\\)?[a-z]:[\\/]/i;

export function localTranscriptPath(value: unknown, threadId: string): value is string {
  return typeof value === 'string' && (process.platform === 'win32' ? windowsDrivePath.test(value) : isAbsolute(value)) &&
    basename(value).toLowerCase().endsWith(`-${threadId.toLowerCase()}.jsonl`);
}

export function sameLocalPath(left: string, right: string): boolean {
  // The Desktop owner can report a local Windows path with the long-path prefix.
  const comparable = (p: string) => normalize(p.startsWith('\\\\?\\') && windowsDrivePath.test(p) ? p.slice(4) : p);
  const a = comparable(left);
  const b = comparable(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Read one local rollout. Hold only the target call state and an unfinished line between polls. */
export class NativeTranscriptCursor {
  private identity: string | null = null;
  private offset = 0;
  private decoder = new StringDecoder('utf8');
  private partial = '';
  private skipping = false;
  private header: 'unread' | 'verified' | 'invalid' = 'unread';
  private matcher: NativeResultMatcher;

  constructor(readonly path: string, readonly cwd: string, private readonly threadId: string,
    private readonly expected: NativeReceiptExpectation) {
    this.matcher = new NativeResultMatcher(expected);
  }

  private reset(identity: string): void {
    this.identity = identity;
    this.offset = 0;
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
    this.skipping = false;
    this.header = 'unread';
    this.matcher = new NativeResultMatcher(this.expected);
  }

  private consume(chunk: string): void {
    const lines = chunk.split('\n');
    for (const line of lines.slice(0, -1)) {
      const whole = this.partial + line;
      this.partial = '';
      try {
        if (this.skipping || whole.length > maxRecordLength) throw new Error('Record too long.');
        const row = JSON.parse(whole);
        if (this.header === 'unread') {
          const p = row?.payload;
          this.header = row?.type === 'session_meta' && p?.id === this.threadId && typeof p.cwd === 'string' &&
            sameLocalPath(p.cwd, this.cwd) ? 'verified' : 'invalid';
        } else this.matcher.accept(row);
      } catch {
        if (this.header === 'unread') this.header = 'invalid';
        this.matcher.resetTurn();
      }
      this.skipping = false;
      if (this.header === 'invalid') return;
    }
    if (this.skipping) return;
    this.partial += lines.at(-1)!;
    if (this.partial.length > maxRecordLength) {
      this.partial = '';
      this.skipping = true;
    }
  }

  async matches(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !localTranscriptPath(this.path, this.threadId)) return false;
    const file = await open(this.path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || !Number.isSafeInteger(info.size)) return false;
      const identity = `${info.dev}:${info.ino}`;
      if (this.identity !== identity || info.size < this.offset) this.reset(identity);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (!signal.aborted && this.header !== 'invalid' && !this.matcher.matched && this.offset < info.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.consume(this.decoder.write(buffer.subarray(0, bytesRead)));
      }
      return !signal.aborted && this.header === 'verified' && this.matcher.matched;
    } finally { await file.close(); }
  }
}
