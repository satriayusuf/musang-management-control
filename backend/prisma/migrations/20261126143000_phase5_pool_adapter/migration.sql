-- Phase 5 (CONTRACT-5 B1): pool_snapshots becomes a per-agent snapshot
-- (upsert), replacing the Phase 1 append-only shape. The table is empty in
-- every environment (the Phase 1 provider was a disabled placeholder), so
-- the reshape is a drop-and-recreate.

DROP TABLE "pool_snapshots";

-- CreateTable
CREATE TABLE "pool_snapshots" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "lookup_param" TEXT NOT NULL,
    "worker_name" TEXT NOT NULL,
    "found" BOOLEAN NOT NULL DEFAULT false,
    "pool_hashrate" DOUBLE PRECISION,
    "pool_accepted" INTEGER,
    "pool_rejected" INTEGER,
    "pool_last_share_at" TIMESTAMP(3),
    "last_known_share_at" TIMESTAMP(3),
    "fetched_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "fetch_ok" BOOLEAN NOT NULL DEFAULT false,
    "fetch_error" TEXT,
    "confirm_kind" TEXT,
    "confirm_count" INTEGER NOT NULL DEFAULT 0,
    "confirm_last_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pool_snapshots_agent_id_key" ON "pool_snapshots"("agent_id");

-- AddForeignKey
ALTER TABLE "pool_snapshots" ADD CONSTRAINT "pool_snapshots_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
