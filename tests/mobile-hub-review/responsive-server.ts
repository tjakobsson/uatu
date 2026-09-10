/** Isolate Bun's synthetic HTTP/SSE event loop from Playwright's driver IPC. */
import { startReviewServer } from './server';
const server = await startReviewServer({ port: 0 });
console.info(JSON.stringify({ url: server.url }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.stop(); process.exit(0); });
