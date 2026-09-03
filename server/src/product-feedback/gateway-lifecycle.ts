import type { Server } from "node:http";

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export async function drainHttpServer(
  server: Server,
  timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, timeoutMs);
    timer.unref();
    server.close((error) => {
      finish(error ?? undefined);
    });
    server.closeIdleConnections();
  });
}
