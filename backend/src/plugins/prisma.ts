import { PrismaClient } from '@prisma/client';

let singleton: PrismaClient | null = null;

/** Process-wide Prisma singleton (used by server.ts; tests inject their own). */
export function getPrisma(): PrismaClient {
  if (!singleton) {
    singleton = new PrismaClient();
  }
  return singleton;
}

export function createPrismaClient(datasourceUrl?: string): PrismaClient {
  return datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: datasourceUrl } } })
    : new PrismaClient();
}
