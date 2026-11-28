-- CONTRACT-11: follow-up threading for broadcast questions. Both columns
-- are NULL on existing rows (they are thread roots); a follow-up row
-- points at the previous row of its agent's thread (parent) and at the
-- thread's first row (root).
ALTER TABLE "agent_questions" ADD COLUMN "parent_question_id" TEXT;
ALTER TABLE "agent_questions" ADD COLUMN "root_question_id" TEXT;
CREATE INDEX "agent_questions_parent_question_id_idx" ON "agent_questions"("parent_question_id");
CREATE INDEX "agent_questions_root_question_id_idx" ON "agent_questions"("root_question_id");
