import http from 'node:http';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { connectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { attachSockets } from './sockets/index.js';
import { startRetentionJob } from './jobs/retention.js';
import { auditIndexes } from './services/indexAudit.js';
import { logger } from './utils/logger.js';
import dns from "node:dns";

const app = createApp();
const server = http.createServer(app);
const io = attachSockets(server, app);


dns.setServers([
  "8.8.8.8",
  "8.8.4.4"
]);

console.log("Custom DNS configured");

await connectDatabase();
await Promise.all(Object.values(mongoose.models).map(m => m.init())); // make sure indexes exist before serving traffic
// Warn (never auto-drop) when the database contains unique indexes the schemas do not declare.
auditIndexes().then(found => found.filter(f => f.unique).forEach(f =>
  logger.warn(`Stale UNIQUE index ${f.collection}.${f.name} ${JSON.stringify(f.key)} can reject new records. Run: npm run indexes:check`)
)).catch(err => logger.warn('index audit skipped', err));
const retentionTimer = startRetentionJob();

server.listen(env.PORT, () => logger.info(`Lingua Meet API listening on http://localhost:${env.PORT}`, { env: env.NODE_ENV }));

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info(`${signal}: shutting down`);
  clearInterval(retentionTimer);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  io.close();                                   // disconnect sockets
  server.close(async () => {                    // stop accepting HTTP, wait for in-flight requests
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', err => logger.error('unhandledRejection', err instanceof Error ? err : new Error(String(err))));
