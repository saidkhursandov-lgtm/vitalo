-- UX update. Every statement only ADDS what is missing (ON CONFLICT DO NOTHING): existing rows,
-- admin edits and real data are never changed.

-- Top-level "need" categories (Сердце и сосуды may already exist).
INSERT INTO "categories" ("id", "parent_id", "tree_type", "name_ru", "name_uz", "slug", "sort_order", "status") VALUES
  (gen_random_uuid(), NULL, 'need', 'Сердце и сосуды',        'Yurak va qon tomirlar', 'heart',  60,  'active'),
  (gen_random_uuid(), NULL, 'need', 'Память и концентрация',  'Xotira va diqqat',      'memory', 70,  'active'),
  (gen_random_uuid(), NULL, 'need', 'Женское здоровье',       'Ayollar salomatligi',   'women',  80,  'active'),
  (gen_random_uuid(), NULL, 'need', 'Мужское здоровье',       'Erkaklar salomatligi',  'men',    90,  'active'),
  (gen_random_uuid(), NULL, 'need', 'Спорт и восстановление', 'Sport va tiklanish',    'sport',  100, 'active')
ON CONFLICT ("slug") DO NOTHING;

-- Second manual payment method: transfer to a card (same flow as bank transfer: "Я оплатил(а)" + manager check).
INSERT INTO "payment_methods" ("id", "code", "name_ru", "name_uz", "status", "timeout_minutes") VALUES
  (gen_random_uuid(), 'card_transfer', 'Перевод на карту', 'Kartaga o‘tkazma', 'enabled', 720)
ON CONFLICT ("code") DO NOTHING;

-- Texts editable in the admin panel (Настройки). Card details are TEST values until the admin enters real ones.
INSERT INTO "settings" ("key", "value", "updated_at") VALUES
  ('product_disclaimer',
   '{"ru": "БАД. НЕ ЯВЛЯЕТСЯ ЛЕКАРСТВЕННЫМ СРЕДСТВОМ.", "uz": "BFQ. DORI VOSITASI EMAS."}', now()),
  ('card_transfer_details',
   '{"card_number": "8600000000000000", "recipient": "ТЕСТОВЫЙ ПОЛУЧАТЕЛЬ (ТЕСТОВЫЕ ДАННЫЕ)"}', now()),
  ('payment_hint',
   '{"ru": "Переведите сумму заказа на карту, затем нажмите «Я оплатил(а)». После проверки платежа менеджером статус заказа изменится на «Оплачен», и мы начнём сборку.", "uz": "Buyurtma summasini kartaga o‘tkazing, so‘ng «To‘ladim» tugmasini bosing. Menejer to‘lovni tekshirgach, buyurtma holati «To‘langan»ga o‘zgaradi va biz yig‘ishni boshlaymiz."}', now())
ON CONFLICT ("key") DO NOTHING;
