import { describe, expect, it } from "vitest";
import { DemoMiner } from "../src/miner-demo.js";

describe("DemoMiner state machine", () => {
  it("starts active by default with a plausible snapshot", async () => {
    const miner = new DemoMiner({ seed: 42 });
    const snap = await miner.snapshot();
    expect(snap.service_state).toBe("active");
    expect(snap.pid).toBeGreaterThan(0);
    expect(snap.session_no).toBe(1);
    expect(snap.hashrate_hs).not.toBeNull();
    expect(snap.hashrate_hs!).toBeGreaterThanOrEqual(1.4);
    expect(snap.hashrate_hs!).toBeLessThanOrEqual(1.91);
  });

  it("starts inactive when DEMO_MINER_START=inactive", async () => {
    const miner = new DemoMiner({ startState: "inactive" });
    const snap = await miner.snapshot();
    expect(snap.service_state).toBe("inactive");
    expect(snap.pid).toBeNull();
    expect(snap.hashrate_hs).toBe(0);
    expect(snap.session_no).toBe(0);
  });

  it("does not produce shares while inactive", async () => {
    const miner = new DemoMiner({ startState: "inactive" });
    for (let i = 0; i < 20; i++) miner.tick();
    const snap = await miner.snapshot();
    expect(snap.shares_local).toBe(0);
    expect(snap.last_share_at).toBeNull();
  });

  it("hashrate stays inside 1.4–1.91 H/s and shares/job advance while active", async () => {
    const miner = new DemoMiner({ seed: 7 });
    for (let i = 0; i < 300; i++) {
      miner.tick();
      const snap = await miner.snapshot();
      expect(snap.hashrate_hs!).toBeGreaterThanOrEqual(1.4);
      expect(snap.hashrate_hs!).toBeLessThanOrEqual(1.91);
    }
    const snap = await miner.snapshot();
    expect(snap.shares_local!).toBeGreaterThan(0);
    expect(snap.job_height!).toBeGreaterThanOrEqual(800);
    expect(snap.last_share_at).not.toBeNull();
  });

  it("run() starts an inactive miner and begins a new session", async () => {
    const miner = new DemoMiner({ startState: "inactive" });
    const outcome = await miner.run();
    expect(outcome.ok).toBe(true);
    const snap = await miner.snapshot();
    expect(snap.service_state).toBe("active");
    expect(snap.session_no).toBe(1);
  });

  it("run() on an active miner is a no-op (same session)", async () => {
    const miner = new DemoMiner({ seed: 1 });
    const before = (await miner.snapshot()).session_no;
    const outcome = await miner.run();
    expect(outcome.ok).toBe(true);
    expect((await miner.snapshot()).session_no).toBe(before);
  });

  it("restart() and reinstall() begin new sessions and reset shares", async () => {
    const miner = new DemoMiner({ seed: 3 });
    for (let i = 0; i < 30; i++) miner.tick();
    const s1 = (await miner.snapshot()).session_no;
    await miner.restart();
    let snap = await miner.snapshot();
    expect(snap.session_no).toBe(s1! + 1);
    expect(snap.shares_local).toBe(0);
    await miner.reinstall();
    snap = await miner.snapshot();
    expect(snap.session_no).toBe(s1! + 2);
    expect(snap.service_state).toBe("active");
  });

  it("stop() takes the miner inactive", async () => {
    const miner = new DemoMiner();
    miner.stop();
    const snap = await miner.snapshot();
    expect(snap.service_state).toBe("inactive");
    expect(snap.pid).toBeNull();
  });

  it("reports the configured simulated memory", async () => {
    await expect(new DemoMiner({ memGib: 2.4 }).memAvailableGib()).resolves.toBe(2.4);
    await expect(new DemoMiner().memAvailableGib()).resolves.toBe(6.8);
  });
});
