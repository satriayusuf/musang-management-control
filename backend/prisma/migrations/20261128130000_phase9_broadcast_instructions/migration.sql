-- CONTRACT-9: broadcast instructions. Existing rows default to 'question'
-- (CONTRACT-8 read-only behaviour); 'instruction' rows are executed by
-- the agent runtimes and answered with an execution report.
ALTER TABLE "agent_questions" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'question';
