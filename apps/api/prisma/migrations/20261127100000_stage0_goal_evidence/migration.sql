-- Шаг 0б (D-69, архитектура 3.6): таблица доказательности «вещество → цель → уровень → когда помогает / когда нет».
-- Заполняет и одобряет врач в админке («База знаний AI → Цели»); VITALO AI видит только одобренные строки.
-- Только добавляющая: новая пустая таблица, существующие данные не меняются.
CREATE TABLE IF NOT EXISTS "goal_evidence" (
  "id" UUID NOT NULL,
  "substance_id" UUID NOT NULL,
  "goal" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "helps_ru" TEXT NOT NULL,
  "helps_uz" TEXT NOT NULL,
  "not_helps_ru" TEXT NOT NULL,
  "not_helps_uz" TEXT NOT NULL,
  "source" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "approved_by" UUID,
  "approved_at" TIMESTAMP(3),
  "created_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "goal_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "goal_evidence_substance_id_fkey" FOREIGN KEY ("substance_id") REFERENCES "substances"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "goal_evidence_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "goal_evidence_substance_id_goal_key" ON "goal_evidence"("substance_id", "goal");
CREATE INDEX IF NOT EXISTS "goal_evidence_goal_status_idx" ON "goal_evidence"("goal", "status");
