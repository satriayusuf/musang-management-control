-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "enrolled_via" TEXT NOT NULL DEFAULT 'pairing';

-- AlterTable
ALTER TABLE "commands" ADD COLUMN     "rule_id" TEXT,
ADD COLUMN     "schedule_id" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "disabled_at" TIMESTAMP(3),
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'ADMIN';

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "condition" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "target" JSONB NOT NULL,
    "cooldown_sec" INTEGER NOT NULL DEFAULT 3600,
    "max_per_day" INTEGER NOT NULL DEFAULT 5,
    "last_fired_at" TIMESTAMP(3),
    "fire_count_today" INTEGER NOT NULL DEFAULT 0,
    "fire_count_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "cron" TEXT NOT NULL,
    "action" JSONB NOT NULL,
    "target" JSONB NOT NULL,
    "broadcast" BOOLEAN NOT NULL DEFAULT false,
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);
