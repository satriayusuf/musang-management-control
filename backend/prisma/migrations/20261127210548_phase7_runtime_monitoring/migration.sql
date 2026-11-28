-- CreateTable
CREATE TABLE "agent_runtime_states" (
    "agent_id" TEXT NOT NULL,
    "runtime_token_hash" TEXT,
    "runtime_token_issued_at" TIMESTAMP(3),
    "last_transition_type" TEXT,
    "last_transition_at" TIMESTAMP(3),
    "last_transition_payload" JSONB,
    "boot_time" TIMESTAMP(3),
    "last_snapshot_at" TIMESTAMP(3),
    "snapshot_hashrate_hs" DOUBLE PRECISION,
    "snapshot_shares_local" INTEGER,
    "snapshot_pool_accepted" INTEGER,
    "snapshot_pool_last_share_at" TIMESTAMP(3),
    "snapshot_mem_available_gib" DOUBLE PRECISION,
    "last_contact_at" TIMESTAMP(3),
    "last_event_type" TEXT,
    "last_event_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runtime_states_pkey" PRIMARY KEY ("agent_id")
);

-- AddForeignKey
ALTER TABLE "agent_runtime_states" ADD CONSTRAINT "agent_runtime_states_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
