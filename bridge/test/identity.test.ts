import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityStore } from "../src/identity.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-bridge-identity-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("IdentityStore", () => {
  it("returns nulls for an empty dir", () => {
    const store = new IdentityStore(dir);
    expect(store.loadIdentity()).toBeNull();
    expect(store.loadToken()).toBeNull();
  });

  it("round-trips identity and token", () => {
    const store = new IdentityStore(dir);
    store.saveIdentity({ agent_id: "agt_123", name: "rig-1", worker_name: "czx-utama-7d66" });
    store.saveToken("secret-token-value");

    const reloaded = new IdentityStore(dir);
    expect(reloaded.loadIdentity()).toEqual({
      agent_id: "agt_123",
      name: "rig-1",
      worker_name: "czx-utama-7d66",
    });
    expect(reloaded.loadToken()).toBe("secret-token-value");
  });

  it("stores the token file with mode 0600, also when overwriting", () => {
    const store = new IdentityStore(dir);
    store.saveToken("first");
    expect(statSync(store.tokenPath).mode & 0o777).toBe(0o600);
    store.saveToken("second");
    expect(statSync(store.tokenPath).mode & 0o777).toBe(0o600);
    expect(store.loadToken()).toBe("second");
  });

  it("clearToken removes the token but keeps the identity", () => {
    const store = new IdentityStore(dir);
    store.saveIdentity({ agent_id: "agt_9", name: "rig-9" });
    store.saveToken("tok");
    store.clearToken();
    expect(store.loadToken()).toBeNull();
    expect(store.loadIdentity()?.agent_id).toBe("agt_9");
  });

  it("treats a corrupt identity file as missing", () => {
    const store = new IdentityStore(dir);
    store.saveIdentity({ agent_id: "agt_ok", name: "x" });
    // Corrupt it on purpose by overwriting the file with invalid JSON.
    writeFileSync(store.identityPath, "{not json", "utf8");
    expect(store.loadIdentity()).toBeNull();
  });
});
