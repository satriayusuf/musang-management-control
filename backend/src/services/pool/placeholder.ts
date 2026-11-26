import type { PoolProvider, PoolWorkerData } from './types';

/**
 * Placeholder provider: always unconfigured in Phase 1. Plug the real
 * bntpool.com adapter in here later (env: POOL_API_BASE_URL, POOL_API_KEY,
 * POOL_LOOKUP_PARAM) without touching callers.
 */
export class PlaceholderPoolProvider implements PoolProvider {
  readonly name = 'placeholder';

  isConfigured(): boolean {
    return false;
  }

  async fetchWorkers(): Promise<PoolWorkerData[]> {
    return [];
  }
}
