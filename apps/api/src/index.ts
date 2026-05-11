/**
 * @v3/api bootstrap. Loads env, creates the Express app, listens.
 */

import { createApp } from './server.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const app = createApp();

const server = app.listen(env.PORT, () => {
  process.env.SERVER_STARTED_AT = new Date().toISOString();
  console.log(
    `[@v3/api] listening on http://localhost:${env.PORT} (NODE_ENV=${env.NODE_ENV})`,
  );
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[@v3/api] received ${signal}, closing server...`);
  server.close((err) => {
    if (err) {
      console.error('[@v3/api] error during shutdown:', err);
      process.exit(1);
    }
    process.exit(0);
  });
  // Force-exit if shutdown stalls.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
