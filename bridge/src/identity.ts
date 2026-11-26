import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Identity } from "./types.js";

/**
 * Persistent agent identity storage.
 *
 * Layout inside the bridge dir (default ~/workspace/muse-bridge, the only
 * directory that survives VM replacement):
 *   identity.json — { agent_id, name, worker_name }
 *   token         — raw agent token, file mode 0600, never logged
 */
export class IdentityStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get identityPath(): string {
    return join(this.dir, "identity.json");
  }

  get tokenPath(): string {
    return join(this.dir, "token");
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  loadIdentity(): Identity | null {
    if (!existsSync(this.identityPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.identityPath, "utf8")) as Partial<Identity>;
      if (typeof parsed.agent_id !== "string" || parsed.agent_id === "") return null;
      return {
        agent_id: parsed.agent_id,
        name: typeof parsed.name === "string" ? parsed.name : "",
        worker_name: typeof parsed.worker_name === "string" ? parsed.worker_name : undefined,
      };
    } catch {
      return null;
    }
  }

  saveIdentity(identity: Identity): void {
    this.ensureDir();
    writeFileSync(this.identityPath, JSON.stringify(identity, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o644,
    });
  }

  loadToken(): string | null {
    if (!existsSync(this.tokenPath)) return null;
    try {
      const token = readFileSync(this.tokenPath, "utf8").trim();
      return token === "" ? null : token;
    } catch {
      return null;
    }
  }

  saveToken(token: string): void {
    this.ensureDir();
    writeFileSync(this.tokenPath, token + "\n", { encoding: "utf8", mode: 0o600 });
    // writeFileSync's mode only applies on creation — enforce on existing files too.
    chmodSync(this.tokenPath, 0o600);
  }

  clearToken(): void {
    try {
      unlinkSync(this.tokenPath);
    } catch {
      /* already gone */
    }
  }
}
