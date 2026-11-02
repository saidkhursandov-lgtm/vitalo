-- Stage 3.8: VITALO AI core + compatibility check in the cart (D-45). Only ADDS things (rules for the production
-- database): two defaulted/nullable columns, five new tables, indexes, foreign keys and the starting dictionary of
-- substances (ON CONFLICT DO NOTHING — an edit made in the admin panel is never overwritten). Safe to run twice.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ai_consent_at" TIMESTAMP(3);
ALTER TABLE "compat_requests" ADD COLUMN IF NOT EXISTS "ai_answer_id" UUID;

CREATE TABLE IF NOT EXISTS "substances" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'substance',
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT NOT NULL,
    "synonyms" TEXT[],
    "parent_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "substances_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "product_substances" (
    "product_id" UUID NOT NULL,
    "substance_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_substances_pkey" PRIMARY KEY ("product_id","substance_id")
);

CREATE TABLE IF NOT EXISTS "compat_rules" (
    "id" UUID NOT NULL,
    "substance_a_id" UUID NOT NULL,
    "substance_b_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "interval_hours" INTEGER,
    "when_a" TEXT,
    "when_b" TEXT,
    "text_ru" TEXT NOT NULL,
    "text_uz" TEXT NOT NULL,
    "source" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'admin',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "compat_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ai_requests" (
    "id" UUID NOT NULL,
    "scenario" TEXT NOT NULL,
    "user_id" UUID,
    "set_key" TEXT,
    "lang" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ai_compat_answers" (
    "id" UUID NOT NULL,
    "set_key" TEXT NOT NULL,
    "product_ids" UUID[],
    "items" JSONB NOT NULL,
    "lang" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "timing" JSONB,
    "suggested_ids" UUID[],
    "model" TEXT NOT NULL,
    "ai_request_id" UUID,
    "review" TEXT NOT NULL DEFAULT 'new',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMP(3),
    "saved_answer_id" UUID,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_compat_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "substances_code_key" ON "substances"("code");
CREATE INDEX IF NOT EXISTS "compat_rules_status_idx" ON "compat_rules"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "compat_rules_substance_a_id_substance_b_id_key" ON "compat_rules"("substance_a_id", "substance_b_id");
CREATE INDEX IF NOT EXISTS "ai_requests_created_at_idx" ON "ai_requests"("created_at");
CREATE INDEX IF NOT EXISTS "ai_requests_user_id_scenario_created_at_idx" ON "ai_requests"("user_id", "scenario", "created_at");
CREATE INDEX IF NOT EXISTS "ai_compat_answers_set_key_lang_idx" ON "ai_compat_answers"("set_key", "lang");
CREATE INDEX IF NOT EXISTS "ai_compat_answers_review_created_at_idx" ON "ai_compat_answers"("review", "created_at");

DO $$ BEGIN
  ALTER TABLE "compat_requests" ADD CONSTRAINT "compat_requests_ai_answer_id_fkey" FOREIGN KEY ("ai_answer_id") REFERENCES "ai_compat_answers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "substances" ADD CONSTRAINT "substances_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "substances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "product_substances" ADD CONSTRAINT "product_substances_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "product_substances" ADD CONSTRAINT "product_substances_substance_id_fkey" FOREIGN KEY ("substance_id") REFERENCES "substances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "compat_rules" ADD CONSTRAINT "compat_rules_substance_a_id_fkey" FOREIGN KEY ("substance_a_id") REFERENCES "substances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "compat_rules" ADD CONSTRAINT "compat_rules_substance_b_id_fkey" FOREIGN KEY ("substance_b_id") REFERENCES "substances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "compat_rules" ADD CONSTRAINT "compat_rules_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ai_compat_answers" ADD CONSTRAINT "ai_compat_answers_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ai_compat_answers" ADD CONSTRAINT "ai_compat_answers_saved_answer_id_fkey" FOREIGN KEY ("saved_answer_id") REFERENCES "compat_answers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The starting dictionary (D-45). Synonyms are lower case; both Latin and Cyrillic letters are listed for «C», «D3», «B6»…
INSERT INTO "substances" ("id", "code", "kind", "name_ru", "name_uz", "synonyms", "sort_order") VALUES
  (gen_random_uuid(), 'vitamin_d3', 'substance', 'Витамин D3', 'D3 vitamini', ARRAY['витамин d3','витамин д3','витамин d','витамин д','вит. d3','вит d3','d3','д3','холекальциферол','cholecalciferol','vitamin d3','d3 vitamini'], 10),
  (gen_random_uuid(), 'vitamin_k2', 'substance', 'Витамин K2', 'K2 vitamini', ARRAY['витамин k2','витамин к2','k2','к2','mk-7','мк-7','менахинон','menaquinone','vitamin k2','k2 vitamini'], 20),
  (gen_random_uuid(), 'vitamin_c', 'substance', 'Витамин C', 'C vitamini', ARRAY['витамин c','витамин с','вит. c','вит c','вит. с','вит с','аскорбиновая кислота','l-аскорбиновая кислота','аскорбат','ascorbic acid','vitamin c','c vitamini'], 30),
  (gen_random_uuid(), 'vitamin_b6', 'substance', 'Витамин B6', 'B6 vitamini', ARRAY['витамин b6','витамин в6','b6','в6','пиридоксин','пиридоксина гидрохлорид','pyridoxine','vitamin b6','b6 vitamini'], 40),
  (gen_random_uuid(), 'p5p', 'form', 'P-5-P (активная форма B6)', 'P-5-P (B6 ning faol shakli)', ARRAY['p-5-p','p5p','пиридоксаль-5-фосфат','пиридоксаль 5 фосфат','pyridoxal-5-phosphate'], 41),
  (gen_random_uuid(), 'vitamin_b12', 'substance', 'Витамин B12', 'B12 vitamini', ARRAY['витамин b12','витамин в12','b12','в12','цианокобаламин','метилкобаламин','кобаламин','vitamin b12','b12 vitamini'], 50),
  (gen_random_uuid(), 'folate', 'substance', 'Фолиевая кислота (B9)', 'Foliy kislotasi (B9)', ARRAY['фолиевая кислота','фолат','метилфолат','b9','в9','витамин b9','folic acid','folat'], 55),
  (gen_random_uuid(), 'b_complex', 'substance', 'Витамины группы B', 'B guruhi vitaminlari', ARRAY['группа b','группа в','витамины группы b','витамины группы в','b-комплекс','в-комплекс','b kompleks','b guruhi'], 60),
  (gen_random_uuid(), 'vitamin_a', 'substance', 'Витамин A', 'A vitamini', ARRAY['витамин a','витамин а','ретинол','бета-каротин','vitamin a','a vitamini'], 70),
  (gen_random_uuid(), 'vitamin_e', 'substance', 'Витамин E', 'E vitamini', ARRAY['витамин e','витамин е','токоферол','vitamin e','e vitamini'], 80),
  (gen_random_uuid(), 'multivitamin', 'substance', 'Мультивитаминный комплекс', 'Multivitamin kompleks', ARRAY['мультивитамины','мультивитамин','комплекс витаминов и минералов','витамины и минералы','multivitamin'], 90),
  (gen_random_uuid(), 'magnesium', 'substance', 'Магний', 'Magniy', ARRAY['магний','магния','цитрат магния','магния цитрат','магний цитрат','бисглицинат магния','глицинат магния','лактат магния','магния лактат','органический магний','magnesium','magniy'], 100),
  (gen_random_uuid(), 'calcium', 'substance', 'Кальций', 'Kalsiy', ARRAY['кальций','кальция','карбонат кальция','цитрат кальция','calcium','kalsiy'], 110),
  (gen_random_uuid(), 'iron', 'substance', 'Железо', 'Temir', ARRAY['железо','железа','бисглицинат железа','фумарат железа','iron','temir'], 120),
  (gen_random_uuid(), 'zinc', 'substance', 'Цинк', 'Sink', ARRAY['цинк','цинка','пиколинат цинка','цитрат цинка','цинк хелат','zinc','sink','rux'], 130),
  (gen_random_uuid(), 'copper', 'substance', 'Медь', 'Mis', ARRAY['медь','меди','copper','mis'], 140),
  (gen_random_uuid(), 'selenium', 'substance', 'Селен', 'Selen', ARRAY['селен','селена','селенометионин','selenium','selen'], 150),
  (gen_random_uuid(), 'iodine', 'substance', 'Йод', 'Yod', ARRAY['йод','йода','калия йодат','калия йодид','йодид калия','iodine','yod'], 160),
  (gen_random_uuid(), 'omega3', 'substance', 'Омега-3', 'Omega-3', ARRAY['омега-3','омега 3','omega-3','omega 3','рыбий жир','эпк','дгк','epa','dha','триглицерид','tg'], 200),
  (gen_random_uuid(), 'collagen', 'substance', 'Коллаген', 'Kollagen', ARRAY['коллаген','коллагена','гидролизат коллагена','гидролизованный коллаген','морской коллаген','пептиды коллагена','пептидный коллаген','collagen','kollagen'], 210),
  (gen_random_uuid(), 'hyaluronic', 'substance', 'Гиалуроновая кислота', 'Gialuron kislotasi', ARRAY['гиалуроновая кислота','гиалуронат','гиалуронат натрия','гиалурон','hyaluronic acid','gialuron'], 220),
  (gen_random_uuid(), 'creatine', 'substance', 'Креатин', 'Kreatin', ARRAY['креатин','креатин моногидрат','моногидрат креатина','creatine','creatine monohydrate','kreatin'], 300),
  (gen_random_uuid(), 'protein', 'substance', 'Протеин', 'Protein', ARRAY['протеин','белок','сывороточный протеин','изолят белка','растительный белок','гороховый белок','protein','oqsil'], 310),
  (gen_random_uuid(), 'drugs_anticoagulants', 'drug_group', 'Лекарства: антикоагулянты (разжижающие кровь)', 'Dorilar: antikoagulyantlar (qon suyultiruvchi)', ARRAY['антикоагулянты','разжижающие кровь','варфарин','аспирин','антиагреганты'], 900),
  (gen_random_uuid(), 'drugs_thyroid', 'drug_group', 'Лекарства: гормоны щитовидной железы (L-тироксин)', 'Dorilar: qalqonsimon bez gormonlari (L-tiroksin)', ARRAY['гормоны щитовидной железы','l-тироксин','левотироксин','эутирокс','тиреоидные гормоны'], 910),
  (gen_random_uuid(), 'drugs_antibiotics', 'drug_group', 'Лекарства: антибиотики (тетрациклины, фторхинолоны)', 'Dorilar: antibiotiklar (tetratsiklinlar, ftorxinolonlar)', ARRAY['антибиотики','тетрациклины','тетрациклин','фторхинолоны','ципрофлоксацин','доксициклин'], 920)
ON CONFLICT ("code") DO NOTHING;

-- P-5-P is a form of B6: the B6 rules apply to it (set once; an admin may change it later)
UPDATE "substances" SET "parent_id" = (SELECT "id" FROM "substances" WHERE "code" = 'vitamin_b6')
WHERE "code" = 'p5p' AND "parent_id" IS NULL;
