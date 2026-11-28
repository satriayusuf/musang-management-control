// bridge.update self-update logic (CONTRACT-10): hash compare, install
// with backup, agent.md refresh, and the failure paths. Fetch and the
// syntax check are injected — no network, no real node --check.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { performBridgeUpdate, sha256Hex } from "../src/updater.js";

let dir: string;

const NEW_BUNDLE = new TextEncoder().encode("// new bundle v2\n");
const OLD_BUNDLE = new TextEncoder().encode("// old bundle v1\n");
const AGENT_MD = "# agent.md terbaru\n";

function fakeFetch(routes: Record<string, Uint8Array | null>): typeof fetch {
  return (async (url: string) => {
    const body = routes[url];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(body as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
}

const okCheck = async () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-updater-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("performBridgeUpdate", () => {
  it("installs a different bundle, keeps a .bak, and refreshes agent.md", async () => {
    writeFileSync(join(dir, "bridge.cjs"), OLD_BUNDLE);
    const outcome = await performBridgeUpdate({
      serverUrl: "https://server.example",
      bridgeDir: dir,
      fetchFn: fakeFetch({
        "https://server.example/bridge.cjs": NEW_BUNDLE,
        "https://server.example/agent.md": new TextEncoder().encode(AGENT_MD),
      }),
      syntaxCheck: okCheck,
    });
    expect(outcome.bundleUpdated).toBe(true);
    expect(outcome.bundleFromSha).toBe(sha256Hex(OLD_BUNDLE));
    expect(outcome.bundleToSha).toBe(sha256Hex(NEW_BUNDLE));
    expect(sha256Hex(readFileSync(join(dir, "bridge.cjs")))).toBe(sha256Hex(NEW_BUNDLE));
    expect(sha256Hex(readFileSync(join(dir, "bridge.cjs.bak")))).toBe(sha256Hex(OLD_BUNDLE));
    expect(outcome.agentMdUpdated).toBe(true);
    expect(readFileSync(join(dir, "agent.md"), "utf8")).toBe(AGENT_MD);
  });

  it("does nothing when the bundle already matches (agent.md still checked)", async () => {
    writeFileSync(join(dir, "bridge.cjs"), NEW_BUNDLE);
    writeFileSync(join(dir, "agent.md"), AGENT_MD);
    const outcome = await performBridgeUpdate({
      serverUrl: "https://server.example",
      bridgeDir: dir,
      fetchFn: fakeFetch({
        "https://server.example/bridge.cjs": NEW_BUNDLE,
        "https://server.example/agent.md": new TextEncoder().encode(AGENT_MD),
      }),
      syntaxCheck: okCheck,
    });
    expect(outcome.bundleUpdated).toBe(false);
    expect(outcome.agentMdUpdated).toBe(false);
    expect(existsSync(join(dir, "bridge.cjs.bak"))).toBe(false);
  });

  it("installs when no bundle exists yet (from = null)", async () => {
    const outcome = await performBridgeUpdate({
      serverUrl: "https://server.example",
      bridgeDir: dir,
      fetchFn: fakeFetch({
        "https://server.example/bridge.cjs": NEW_BUNDLE,
        "https://server.example/agent.md": new TextEncoder().encode(AGENT_MD),
      }),
      syntaxCheck: okCheck,
    });
    expect(outcome.bundleUpdated).toBe(true);
    expect(outcome.bundleFromSha).toBeNull();
    expect(sha256Hex(readFileSync(join(dir, "bridge.cjs")))).toBe(sha256Hex(NEW_BUNDLE));
  });

  it("fails without installing when the syntax check rejects the download", async () => {
    writeFileSync(join(dir, "bridge.cjs"), OLD_BUNDLE);
    await expect(
      performBridgeUpdate({
        serverUrl: "https://server.example",
        bridgeDir: dir,
        fetchFn: fakeFetch({
          "https://server.example/bridge.cjs": NEW_BUNDLE,
          "https://server.example/agent.md": new TextEncoder().encode(AGENT_MD),
        }),
        syntaxCheck: async () => {
          throw new Error("syntax buruk");
        },
      }),
    ).rejects.toThrow("syntax buruk");
    expect(sha256Hex(readFileSync(join(dir, "bridge.cjs")))).toBe(sha256Hex(OLD_BUNDLE));
  });

  it("fails the update when the bundle download fails (404)", async () => {
    writeFileSync(join(dir, "bridge.cjs"), OLD_BUNDLE);
    await expect(
      performBridgeUpdate({
        serverUrl: "https://server.example",
        bridgeDir: dir,
        fetchFn: fakeFetch({}),
        syntaxCheck: okCheck,
      }),
    ).rejects.toThrow("HTTP 404");
    expect(sha256Hex(readFileSync(join(dir, "bridge.cjs")))).toBe(sha256Hex(OLD_BUNDLE));
  });

  it("the default node --check accepts a valid bundle and rejects a broken one", async () => {
    // No syntaxCheck injected: exercises the real `node --check` path,
    // including the temp-file naming (must end in .cjs — Phase 10 E2E bug).
    writeFileSync(join(dir, "bridge.cjs"), OLD_BUNDLE);
    const ok = await performBridgeUpdate({
      serverUrl: "https://server.example",
      bridgeDir: dir,
      fetchFn: fakeFetch({
        "https://server.example/bridge.cjs": new TextEncoder().encode("const x = 1;\n"),
        "https://server.example/agent.md": new TextEncoder().encode(AGENT_MD),
      }),
    });
    expect(ok.bundleUpdated).toBe(true);

    writeFileSync(join(dir, "bridge.cjs"), OLD_BUNDLE);
    await expect(
      performBridgeUpdate({
        serverUrl: "https://server.example",
        bridgeDir: dir,
        fetchFn: fakeFetch({
          "https://server.example/bridge.cjs": new TextEncoder().encode("const = ;\n"),
          "https://server.example/agent.md": new TextEncoder().encode(AGENT_MD),
        }),
      }),
    ).rejects.toThrow();
    // Broken download was cleaned up, installed bundle untouched.
    expect(existsSync(join(dir, ".bridge.cjs.download.cjs"))).toBe(false);
    expect(sha256Hex(readFileSync(join(dir, "bridge.cjs")))).toBe(sha256Hex(OLD_BUNDLE));
  });

  it("agent.md failure is non-fatal and reported", async () => {
    writeFileSync(join(dir, "bridge.cjs"), NEW_BUNDLE);
    const outcome = await performBridgeUpdate({
      serverUrl: "https://server.example",
      bridgeDir: dir,
      fetchFn: fakeFetch({ "https://server.example/bridge.cjs": NEW_BUNDLE }),
      syntaxCheck: okCheck,
    });
    expect(outcome.bundleUpdated).toBe(false);
    expect(outcome.agentMdUpdated).toBe(false);
    expect(outcome.agentMdError).toContain("HTTP 404");
  });
});
