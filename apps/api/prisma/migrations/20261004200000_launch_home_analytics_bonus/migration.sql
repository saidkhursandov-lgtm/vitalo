-- Launch, block B. Only ADDS: a new table and settings rows that do not exist yet.

-- B3: internal funnel analytics (no third-party services)
CREATE TABLE IF NOT EXISTS "analytics_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "event" TEXT NOT NULL,
  "props" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "analytics_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "analytics_events_event_created_at_idx" ON "analytics_events"("event", "created_at");
CREATE INDEX IF NOT EXISTS "analytics_events_user_id_created_at_idx" ON "analytics_events"("user_id", "created_at");

-- B1: home page banner, trust tiles and "how to order" (texts and switches edited in the admin panel)
-- B4: "VITALO Bonus — скоро" card in the profile
INSERT INTO "settings" ("key", "value", "updated_at") VALUES
  ('home_content', '{
    "banner": {
      "enabled": true,
      "title": {"ru": "Витамины и БАДы с доставкой по Узбекистану", "uz": "O‘zbekiston bo‘ylab yetkazib beriladigan vitaminlar va BFQlar"},
      "subtitle": {"ru": "Оригинальная продукция, понятные условия и поддержка в Telegram", "uz": "Original mahsulotlar, tushunarli shartlar va Telegramda yordam"},
      "button": {"ru": "Смотреть каталог", "uz": "Katalogni ko‘rish"}
    },
    "trust": [
      {"key": "original", "enabled": true, "title": {"ru": "Оригинальная продукция", "uz": "Original mahsulotlar"}, "text": {"ru": "Только от проверенных производителей", "uz": "Faqat ishonchli ishlab chiqaruvchilardan"}},
      {"key": "delivery", "enabled": true, "title": {"ru": "Доставка по всему Узбекистану", "uz": "Butun O‘zbekiston bo‘ylab yetkazib berish"}, "text": {"ru": "{delivery}", "uz": "{delivery}"}},
      {"key": "documents", "enabled": true, "title": {"ru": "Документы на каждый товар", "uz": "Har bir mahsulotga hujjatlar"}, "text": {"ru": "Состав и документы в карточке товара", "uz": "Tarkib va hujjatlar mahsulot sahifasida"}},
      {"key": "payments", "enabled": true, "title": {"ru": "Подтверждаем платежи ежедневно {from}-{to}", "uz": "To‘lovlarni har kuni {from}-{to} tasdiqlaymiz"}, "text": {"ru": "Перевод на карту или по реквизитам", "uz": "Kartaga yoki rekvizitlar bo‘yicha o‘tkazma"}}
    ],
    "steps": {
      "enabled": true,
      "items": [
        {"ru": "Выберите товары и добавьте их в корзину", "uz": "Mahsulotlarni tanlang va savatga qo‘shing"},
        {"ru": "Оформите заказ и переведите оплату на карту", "uz": "Buyurtma bering va to‘lovni kartaga o‘tkazing"},
        {"ru": "Получите заказ — курьер привезёт его по адресу", "uz": "Buyurtmani oling — kuryer manzilingizga yetkazadi"}
      ]
    }
  }', now()),
  ('bonus_teaser', '{
    "enabled": true,
    "text": {"ru": "Скоро: копите бонусы за покупки и оплачивайте ими часть заказа", "uz": "Tez orada: xaridlar uchun bonus to‘plang va ular bilan buyurtmaning bir qismini to‘lang"}
  }', now())
ON CONFLICT ("key") DO NOTHING;
