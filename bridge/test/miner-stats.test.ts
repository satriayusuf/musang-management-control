import { describe, expect, it, vi } from "vitest";
import { fetchMinerStats, parseMinerStats } from "../src/miner-stats.js";
import { RealMiner } from "../src/miner-real.js";

describe("parseMinerStats", () => {
  it("reads the canonical field names", () => {
    const s = parseMinerStats({
      hashrate_hs: 1.9,
      shares_local: 173,
      accepted_shares: 170,
      rejected_shares: 3,
      last_share_at: 1795700000,
      job_height: 813,
      difficulty: 2,
    });
    expect(s.hashrate_hs).toBe(1.9);
    expect(s.shares_local).toBe(173);
    expect(s.accepted_shares).toBe(170);
    expect(s.rejected_shares).toBe(3);
    expect(s.last_share_at).toBe(new Date(1795700000 * 1000).toISOString());
    expect(s.job_height).toBe(813);
    expect(s.difficulty).toBe(2);
  });

  it("accepts aliases, numeric strings and one container level", () => {
    const s = parseMinerStats({
      result: {
        hashrate: "1.32 H/s",
        shares: "25",
        accepted: "20",
        rejected: "1",
        last_share: "2026-11-26T15:40:00.000Z",
        height: 900,
        diff: "2.5",
      },
    });
    expect(s.hashrate_hs).toBe(1.32);
    expect(s.shares_local).toBe(25);
    expect(s.accepted_shares).toBe(20);
    expect(s.rejected_shares).toBe(1);
    expect(s.last_share_at).toBe("2026-11-26T15:40:00.000Z");
    expect(s.job_height).toBe(900);
    expect(s.difficulty).toBe(2.5);
  });

  it("returns all nulls for garbage", () => {
    expect(parseMinerStats(null).hashrate_hs).toBeNull();
    expect(parseMinerStats("nope").shares_local).toBeNull();
    expect(parseMinerStats({ unrelated: true }).difficulty).toBeNull();
    expect(parseMinerStats({ hashrate_hs: "abc" }).hashrate_hs).toBeNull();
  });
});

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

describe("fetchMinerStats", () => {
  it("fetches and parses", async () => {
    const fn = vi.fn(async () => jsonResponse({ hashrate_hs: 1.5, shares_local: 7 }));
    const s = await fetchMinerStats("http://127.0.0.1:9999/stats", fn as never);
    expect(s?.hashrate_hs).toBe(1.5);
    expect(s?.shares_local).toBe(7);
  });

  it("returns null on HTTP error, invalid JSON, empty stats and network failure", async () => {
    const httpErr = vi.fn(async () => jsonResponse("err", false));
    expect(await fetchMinerStats("http://x", httpErr as never)).toBeNull();
    const badJson = vi.fn(async () => jsonResponse("{not json"));
    expect(await fetchMinerStats("http://x", badJson as never)).toBeNull();
    const empty = vi.fn(async () => jsonResponse({ hello: "world" }));
    expect(await fetchMinerStats("http://x", empty as never)).toBeNull();
    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await fetchMinerStats("http://x", boom as never)).toBeNull();
  });
});

describe("RealMiner snapshot with a stats source (CONTRACT-6)", () => {
  it("merges real stats numbers when the endpoint answers", async () => {
    const fn = vi.fn(async () =>
      jsonResponse({
        hashrate_hs: 1.61,
        shares_local: 37,
        accepted_shares: 35,
        rejected_shares: 2,
        job_height: 813,
        difficulty: 2,
      }),
    );
    const miner = new RealMiner("", undefined, "http://127.0.0.1:9999/stats", fn as never);
    const snap = await miner.snapshot();
    expect(snap.hashrate_hs).toBe(1.61);
    expect(snap.shares_local).toBe(37);
    expect(snap.accepted_shares).toBe(35);
    expect(snap.rejected_shares).toBe(2);
    expect(snap.job_height).toBe(813);
    expect(snap.difficulty).toBe(2);
  });

  it("falls back to 0 (not reported) when the endpoint is unreachable", async () => {
    const fn = vi.fn(async () => {
      throw new Error("down");
    });
    const miner = new RealMiner("", undefined, "http://127.0.0.1:9999/stats", fn as never);
    const snap = await miner.snapshot();
    expect(snap.hashrate_hs).toBe(0);
    expect(snap.shares_local).toBe(0);
    expect(snap.accepted_shares).toBeNull();
    expect(snap.rejected_shares).toBeNull();
    expect(snap.last_share_at).toBeNull();
  });

  it("never fetches when no stats URL is configured", async () => {
    const fn = vi.fn(async () => jsonResponse({ hashrate_hs: 9 }));
    const miner = new RealMiner("", undefined, undefined, fn as never);
    const snap = await miner.snapshot();
    expect(fn).not.toHaveBeenCalled();
    expect(snap.hashrate_hs).toBe(0);
  });
});
