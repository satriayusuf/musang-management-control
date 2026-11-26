/**
 * Minimal ambient declarations so `tsc --noEmit` stays clean without
 * @types/node (the bridge intentionally has zero runtime dependencies and a
 * minimal dev footprint). Node builtins are typed as `any`; the bundled
 * runtime is real Node 20+, so behavior is unaffected.
 */
declare module "node:*";

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  pid: number;
  on(event: string, listener: (...args: never[]) => void): void;
  exit(code?: number): never;
  getuid?: () => number;
};
