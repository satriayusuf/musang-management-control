-- AlterTable
ALTER TABLE "commands" ADD COLUMN     "batch_id" TEXT,
ADD COLUMN     "template_id" TEXT;

-- AlterTable
ALTER TABLE "workers" ADD COLUMN     "hold_active" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "command_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "description" TEXT NOT NULL DEFAULT '',
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "command_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_batches" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "template_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "requested_by" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "skipped" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_notifications" (
    "id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "agent_id" TEXT,
    "worker_id" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_deliveries" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "command_templates_name_key" ON "command_templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_batches_idempotency_key_key" ON "broadcast_batches"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "alert_notifications_dedupe_key_key" ON "alert_notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "alert_notifications_created_at_idx" ON "alert_notifications"("created_at");

-- CreateIndex
CREATE INDEX "alert_deliveries_notification_id_idx" ON "alert_deliveries"("notification_id");

-- CreateIndex
CREATE INDEX "commands_batch_id_idx" ON "commands"("batch_id");

-- AddForeignKey
ALTER TABLE "commands" ADD CONSTRAINT "commands_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "command_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commands" ADD CONSTRAINT "commands_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "broadcast_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_batches" ADD CONSTRAINT "broadcast_batches_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "command_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_notifications" ADD CONSTRAINT "alert_notifications_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_notifications" ADD CONSTRAINT "alert_notifications_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "alert_notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
