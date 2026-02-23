import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createCronSDK, CronManager } from "../cron.js";
import type { CronSDK, PluginLogger } from "@teleton-agent/sdk";

function createMockLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("CronSDK", () => {
  let db: InstanceType<typeof Database>;
  let sdk: CronSDK;
  let manager: CronManager;
  let log: PluginLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(":memory:");
    log = createMockLogger();
    const result = createCronSDK(db, log);
    sdk = result.sdk;
    manager = result.manager;
  });

  afterEach(() => {
    manager._stopAll();
    vi.useRealTimers();
    db.close();
  });

  // ---------- Registration ----------

  describe("registration", () => {
    it("registers a job and lists it", () => {
      sdk.register("job1", { every: 5000 }, async () => {});
      const jobs = sdk.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe("job1");
      expect(jobs[0].intervalMs).toBe(5000);
      expect(jobs[0].runMissed).toBe(false);
      expect(jobs[0].lastRunAt).toBeNull();
      expect(jobs[0].running).toBe(false);
    });

    it("get returns a registered job", () => {
      sdk.register("job1", { every: 5000 }, async () => {});
      const job = sdk.get("job1");
      expect(job).toBeDefined();
      expect(job!.id).toBe("job1");
    });

    it("get returns undefined for non-existent job", () => {
      expect(sdk.get("nope")).toBeUndefined();
    });

    it("throws on empty id", () => {
      expect(() => sdk.register("", { every: 5000 }, async () => {})).toThrow("non-empty string");
    });

    it("throws on interval < 1000ms", () => {
      expect(() => sdk.register("fast", { every: 500 }, async () => {})).toThrow("at least 1000ms");
    });

    it("re-register preserves persisted lastRunAt", async () => {
      sdk.register("job1", { every: 5000 }, async () => {});
      manager._start();

      // Advance so the job runs
      vi.advanceTimersByTime(5000);
      // Allow the microtask (Promise.resolve().then(...)) to flush
      await vi.advanceTimersByTimeAsync(0);

      const lastRun = sdk.get("job1")!.lastRunAt;
      expect(lastRun).not.toBeNull();

      // Re-register with a new callback
      sdk.register("job1", { every: 10_000 }, async () => {});
      expect(sdk.get("job1")!.lastRunAt).toBe(lastRun);
      expect(sdk.get("job1")!.intervalMs).toBe(10_000);
    });
  });

  // ---------- Unregister ----------

  describe("unregister", () => {
    it("returns true for existing job", () => {
      sdk.register("job1", { every: 5000 }, async () => {});
      expect(sdk.unregister("job1")).toBe(true);
      expect(sdk.list()).toHaveLength(0);
    });

    it("returns false for non-existent job", () => {
      expect(sdk.unregister("nope")).toBe(false);
    });

    it("removes from DB", () => {
      sdk.register("job1", { every: 5000 }, async () => {});
      sdk.unregister("job1");
      const row = db.prepare("SELECT * FROM _cron_jobs WHERE id = ?").get("job1");
      expect(row).toBeUndefined();
    });

    it("clears timer on unregister", async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      sdk.register("job1", { every: 5000 }, callback);
      manager._start();
      sdk.unregister("job1");

      vi.advanceTimersByTime(10_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ---------- Timer lifecycle ----------

  describe("timer lifecycle", () => {
    it("timers do not start before _start()", async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      sdk.register("job1", { every: 1000 }, callback);

      vi.advanceTimersByTime(5000);
      await vi.advanceTimersByTimeAsync(0);
      expect(callback).not.toHaveBeenCalled();
      expect(sdk.get("job1")!.running).toBe(false);
    });

    it("timers start after _start()", async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      sdk.register("job1", { every: 2000 }, callback);
      manager._start();

      expect(sdk.get("job1")!.running).toBe(true);

      vi.advanceTimersByTime(2000);
      await vi.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("callback executes on interval", async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      sdk.register("job1", { every: 1000 }, callback);
      manager._start();

      vi.advanceTimersByTime(3000);
      await vi.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it("lastRunAt is updated and persisted after execution", async () => {
      sdk.register("job1", { every: 2000 }, async () => {});
      manager._start();

      const now = Date.now();
      vi.advanceTimersByTime(2000);
      await vi.advanceTimersByTimeAsync(0);

      const job = sdk.get("job1")!;
      expect(job.lastRunAt).toBe(now + 2000);

      // Check DB persistence
      const row = db.prepare("SELECT last_run_at FROM _cron_jobs WHERE id = ?").get("job1") as {
        last_run_at: number;
      };
      expect(row.last_run_at).toBe(now + 2000);
    });

    it("registering after _start() activates timer immediately", async () => {
      manager._start();
      const callback = vi.fn().mockResolvedValue(undefined);
      sdk.register("late-job", { every: 3000 }, callback);

      expect(sdk.get("late-job")!.running).toBe(true);

      vi.advanceTimersByTime(3000);
      await vi.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- Missed runs ----------

  describe("missed runs", () => {
    it("fires immediately when runMissed=true and overdue", async () => {
      // Simulate a previous run persisted in DB
      const pastTime = Date.now() - 60_000; // 60s ago
      db.exec(`
        CREATE TABLE IF NOT EXISTS _cron_jobs (
          id TEXT PRIMARY KEY, interval_ms INTEGER NOT NULL,
          run_missed INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER
        )
      `);
      db.prepare("INSERT OR REPLACE INTO _cron_jobs VALUES (?, ?, ?, ?)").run(
        "sync",
        5000,
        1,
        pastTime
      );

      // Re-create SDK to pick up persisted state
      const log2 = createMockLogger();
      const { sdk: sdk2, manager: mgr2 } = createCronSDK(db, log2);

      const callback = vi.fn().mockResolvedValue(undefined);
      sdk2.register("sync", { every: 5000, runMissed: true }, callback);
      mgr2._start();

      // The missed run should fire synchronously (via Promise.resolve)
      await vi.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(1);

      mgr2._stopAll();
    });

    it("does not fire immediately when runMissed=false", async () => {
      const pastTime = Date.now() - 60_000;
      db.prepare(
        "INSERT OR REPLACE INTO _cron_jobs (id, interval_ms, run_missed, last_run_at) VALUES (?, ?, ?, ?)"
      ).run("sync", 5000, 0, pastTime);

      const log2 = createMockLogger();
      const { sdk: sdk2, manager: mgr2 } = createCronSDK(db, log2);

      const callback = vi.fn().mockResolvedValue(undefined);
      sdk2.register("sync", { every: 5000, runMissed: false }, callback);
      mgr2._start();

      await vi.advanceTimersByTimeAsync(0);
      expect(callback).not.toHaveBeenCalled();

      mgr2._stopAll();
    });
  });

  // ---------- Stop ----------

  describe("stop", () => {
    it("_stopAll() clears all timers", async () => {
      const cb1 = vi.fn().mockResolvedValue(undefined);
      const cb2 = vi.fn().mockResolvedValue(undefined);
      sdk.register("a", { every: 1000 }, cb1);
      sdk.register("b", { every: 1000 }, cb2);
      manager._start();
      manager._stopAll();

      vi.advanceTimersByTime(5000);
      await vi.advanceTimersByTimeAsync(0);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });

    it("jobs show running=false after stop", () => {
      sdk.register("a", { every: 1000 }, async () => {});
      manager._start();
      expect(sdk.get("a")!.running).toBe(true);
      manager._stopAll();
      expect(sdk.get("a")!.running).toBe(false);
    });

    it("register after stop throws", () => {
      manager._stopAll();
      expect(() => sdk.register("late", { every: 5000 }, async () => {})).toThrow("stopped");
    });
  });

  // ---------- Error handling ----------

  describe("error handling", () => {
    it("callback error is logged but does not crash", async () => {
      const failing = vi.fn().mockRejectedValue(new Error("boom"));
      sdk.register("fail-job", { every: 2000 }, failing);
      manager._start();

      vi.advanceTimersByTime(2000);
      await vi.advanceTimersByTimeAsync(0);

      expect(failing).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });

    it("lastRunAt is still updated after callback failure", async () => {
      sdk.register("fail-job", { every: 2000 }, vi.fn().mockRejectedValue(new Error("oops")));
      manager._start();

      const now = Date.now();
      vi.advanceTimersByTime(2000);
      await vi.advanceTimersByTimeAsync(0);

      expect(sdk.get("fail-job")!.lastRunAt).toBe(now + 2000);
    });
  });

  // ---------- Table creation ----------

  describe("table creation", () => {
    it("auto-creates _cron_jobs table", () => {
      const freshDb = new Database(":memory:");
      createCronSDK(freshDb, createMockLogger());
      const tables = freshDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get("_cron_jobs") as { name: string } | undefined;
      expect(tables).toBeDefined();
      expect(tables!.name).toBe("_cron_jobs");
      freshDb.close();
    });

    it("is idempotent", () => {
      const freshDb = new Database(":memory:");
      const l = createMockLogger();
      expect(() => createCronSDK(freshDb, l)).not.toThrow();
      expect(() => createCronSDK(freshDb, l)).not.toThrow();
      freshDb.close();
    });
  });
});
