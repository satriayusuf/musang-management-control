// Production entrypoint: build the app, listen, and run the periodic
// sweeper (15s) + pool monitor (60s, only when a provider is configured).

import 'dotenv/config';
import { buildApp } from './app';
import { getPrisma } from './plugins/prisma';
import { runSweep } from './services/sweeper';

async function main(): Promise<void> {
  const prisma = getPrisma();
  const { app, poolMonitor } = await buildApp({ prisma, logger: true });

  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '127.0.0.1';

  const sweepTimer = setInterval(() => {
    void runSweep(prisma, new Date(), { poolConfigured: poolMonitor.isConfigured() }).catch((err) =>
      app.log.error({ err }, 'sweep failed'),
    );
  }, 15_000);
  sweepTimer.unref?.();

  poolMonitor.start(60_000);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    clearInterval(sweepTimer);
    poolMonitor.stop();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port, host });
}

main().catch((err) => {
  console.error('fatal: failed to start backend', err);
  process.exit(1);
});
