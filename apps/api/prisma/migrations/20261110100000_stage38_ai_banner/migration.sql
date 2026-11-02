-- 3.8: the third built-in slide of the home banner, «Соберите свой сет в корзине и проверьте совместимость за пару
-- секунд» (VITALO AI). The Mini App draws it; Настройки → Главная → Баннеры switches it off. Additive only: added once,
-- after the banners already there, and only while the list has room (up to 5).
INSERT INTO "home_banners" ("id", "kind", "enabled", "sort_order", "updated_at")
SELECT '00000000-0000-4000-8000-00000000b003', 'ai', true, COALESCE((SELECT MAX("sort_order") FROM "home_banners"), 0) + 1, CURRENT_TIMESTAMP
WHERE (SELECT COUNT(*) FROM "home_banners") < 5
ON CONFLICT ("id") DO NOTHING;
