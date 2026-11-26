-- Phase 4 (CONTRACT-4 §1): heartbeat storage becomes pure replace-latest —
-- exactly one row per agent. Collapse existing history FIRST: keep only the
-- latest row (max received_at, id as tie-break) per agent and delete the
-- rest, otherwise the unique index below fails on databases with history.
DELETE FROM "heartbeats" h
USING "heartbeats" o
WHERE h."agent_id" = o."agent_id"
  AND (h."received_at" < o."received_at"
       OR (h."received_at" = o."received_at" AND h."id" < o."id"));

-- DropIndex
DROP INDEX "heartbeats_agent_id_received_at_idx";

-- CreateIndex
CREATE UNIQUE INDEX "heartbeats_agent_id_key" ON "heartbeats"("agent_id");
