-- CreateTable
CREATE TABLE "agent_questions" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "asked_by" TEXT NOT NULL,
    "asked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "answer" TEXT,
    "answered_at" TIMESTAMP(3),

    CONSTRAINT "agent_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_questions_agent_id_status_idx" ON "agent_questions"("agent_id", "status");

-- CreateIndex
CREATE INDEX "agent_questions_broadcast_id_idx" ON "agent_questions"("broadcast_id");

-- AddForeignKey
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
