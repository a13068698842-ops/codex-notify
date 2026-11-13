import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

export function scopeId(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 24);
}

export async function acquireWindowsPipe(pipe: string, busyCode: string,
  listener: (socket: Socket) => void = socket => socket.destroy()): Promise<Server> {
  if (process.platform !== 'win32') throw new Error('windows_required');
  const server = createServer({ allowHalfOpen: true }, listener);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === 'EADDRINUSE' ? busyCode : 'runtime_pipe_unavailable'));
    };
    server.once('error', onError);
    server.listen(pipe, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  return server;
}

export function acquireFeishuAppLock(appId: string): Promise<Server> {
  // Also excludes the validation runners, which use this same app scope.
  return acquireWindowsPipe('\\\\.\\pipe\\codex-notify-native-' + scopeId('app:' + appId), 'feishu_app_busy');
}

export function releaseServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => {
    if (error) reject(error); else resolve();
  }));
}
