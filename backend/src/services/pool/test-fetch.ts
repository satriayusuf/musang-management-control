// One-shot pool configuration test fetch (Phase 5, CONTRACT-5 B5; owner
// spec §2). Runs once after pool settings are saved: the save itself never
// fails because of this fetch — a failure is reported in the result as a
// warning, because an outage may be momentary.

import type { PrismaClient } from '@prisma/client';
import { getSettings } from '../settings';
import { fetchAddressWorkers } from './bntpool';

export interface PoolTestAgentResult {
  agent_id: string;
  agent_name: string;
  worker_name: string;
  outcome: 'found' | 'not_found';
  pool_last_share_at?: string;
  pool_hashrate?: number;
}

export interface PoolTestResult {
  fetch_ok: boolean;
  error?: string;
  results: PoolTestAgentResult[];
}

export interface PoolTestFetchDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function runPoolTestFetch(
  prisma: PrismaClient,
  deps: PoolTestFetchDeps = {},
): Promise<PoolTestResult> {
  const settings = await getSettings(prisma);
  const agents = await prisma.agent.findMany({
    where: { workerName: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
  const fetchResult = await fetchAddressWorkers({
    baseUrl: settings.pool_api_base_url,
    lookupParam: settings.pool_lookup_param,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  if (fetchResult.kind === 'error') {
    return { fetch_ok: false, error: fetchResult.reason, results: [] };
  }
  const results: PoolTestAgentResult[] = agents.map((agent) => {
    const entry = fetchResult.workers.get(agent.workerName as string);
    if (!entry) {
      return {
        agent_id: agent.id,
        agent_name: agent.name,
        worker_name: agent.workerName as string,
        outcome: 'not_found' as const,
      };
    }
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      worker_name: agent.workerName as string,
      outcome: 'found' as const,
      ...(entry.lastShareAt ? { pool_last_share_at: entry.lastShareAt.toISOString() } : {}),
      ...(entry.hashrate !== null ? { pool_hashrate: entry.hashrate } : {}),
    };
  });
  return { fetch_ok: true, results };
}
