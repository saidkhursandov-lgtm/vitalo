-- Launch, block A. Every statement only ADDS what is missing: existing regions, cities, tariffs,
-- settings and documents are never changed (new tariff columns are filled only where they are still empty).

-- A3: delivery terms and the "test tariff" mark
ALTER TABLE "delivery_tariffs"
  ADD COLUMN IF NOT EXISTS "min_days" INTEGER,
  ADD COLUMN IF NOT EXISTS "max_days" INTEGER,
  ADD COLUMN IF NOT EXISTS "note_ru" TEXT,
  ADD COLUMN IF NOT EXISTS "note_uz" TEXT,
  ADD COLUMN IF NOT EXISTS "is_test" BOOLEAN NOT NULL DEFAULT false;

-- A2: all regions of Uzbekistan (matched by Russian name, case-insensitive)
INSERT INTO "regions" ("id", "name_ru", "name_uz")
SELECT gen_random_uuid(), v.ru, v.uz FROM (VALUES
  ('Республика Каракалпакстан', 'Qoraqalpog‘iston Respublikasi'),
  ('г. Ташкент', 'Toshkent shahri'),
  ('Ташкентская область', 'Toshkent viloyati'),
  ('Андижанская область', 'Andijon viloyati'),
  ('Бухарская область', 'Buxoro viloyati'),
  ('Джизакская область', 'Jizzax viloyati'),
  ('Кашкадарьинская область', 'Qashqadaryo viloyati'),
  ('Навоийская область', 'Navoiy viloyati'),
  ('Наманганская область', 'Namangan viloyati'),
  ('Самаркандская область', 'Samarqand viloyati'),
  ('Сурхандарьинская область', 'Surxondaryo viloyati'),
  ('Сырдарьинская область', 'Sirdaryo viloyati'),
  ('Ферганская область', 'Farg‘ona viloyati'),
  ('Хорезмская область', 'Xorazm viloyati')
) AS v(ru, uz)
WHERE NOT EXISTS (SELECT 1 FROM "regions" r WHERE lower(r."name_ru") = lower(v.ru));

-- Regional centres, large cities; all 12 districts of Tashkent city
INSERT INTO "cities" ("id", "region_id", "name_ru", "name_uz")
SELECT gen_random_uuid(), r."id", v.ru, v.uz FROM (VALUES
  ('Республика Каракалпакстан', 'Нукус', 'Nukus'),
  ('Республика Каракалпакстан', 'Ходжейли', 'Xo‘jayli'),
  ('Республика Каракалпакстан', 'Турткуль', 'To‘rtko‘l'),
  ('Республика Каракалпакстан', 'Беруни', 'Beruniy'),
  ('Республика Каракалпакстан', 'Кунград', 'Qo‘ng‘irot'),
  ('Республика Каракалпакстан', 'Чимбай', 'Chimboy'),
  ('г. Ташкент', 'Алмазарский район', 'Olmazor tumani'),
  ('г. Ташкент', 'Бектемирский район', 'Bektemir tumani'),
  ('г. Ташкент', 'Мирабадский район', 'Mirobod tumani'),
  ('г. Ташкент', 'Мирзо-Улугбекский район', 'Mirzo Ulug‘bek tumani'),
  ('г. Ташкент', 'Сергелийский район', 'Sergeli tumani'),
  ('г. Ташкент', 'Учтепинский район', 'Uchtepa tumani'),
  ('г. Ташкент', 'Чиланзарский район', 'Chilonzor tumani'),
  ('г. Ташкент', 'Шайхантахурский район', 'Shayxontohur tumani'),
  ('г. Ташкент', 'Юнусабадский район', 'Yunusobod tumani'),
  ('г. Ташкент', 'Яккасарайский район', 'Yakkasaroy tumani'),
  ('г. Ташкент', 'Яшнабадский район', 'Yashnobod tumani'),
  ('г. Ташкент', 'Янгихаётский район', 'Yangihayot tumani'),
  ('Ташкентская область', 'Нурафшан', 'Nurafshon'),
  ('Ташкентская область', 'Алмалык', 'Olmaliq'),
  ('Ташкентская область', 'Ангрен', 'Angren'),
  ('Ташкентская область', 'Чирчик', 'Chirchiq'),
  ('Ташкентская область', 'Бекабад', 'Bekobod'),
  ('Ташкентская область', 'Янгиюль', 'Yangiyo‘l'),
  ('Ташкентская область', 'Газалкент', 'G‘azalkent'),
  ('Андижанская область', 'Андижан', 'Andijon'),
  ('Андижанская область', 'Асака', 'Asaka'),
  ('Андижанская область', 'Ханабад', 'Xonobod'),
  ('Андижанская область', 'Шахрихан', 'Shahrixon'),
  ('Бухарская область', 'Бухара', 'Buxoro'),
  ('Бухарская область', 'Каган', 'Kogon'),
  ('Бухарская область', 'Гиждуван', 'G‘ijduvon'),
  ('Джизакская область', 'Джизак', 'Jizzax'),
  ('Джизакская область', 'Галляарал', 'G‘allaorol'),
  ('Джизакская область', 'Пахтакор', 'Paxtakor'),
  ('Джизакская область', 'Дустлик', 'Do‘stlik'),
  ('Кашкадарьинская область', 'Карши', 'Qarshi'),
  ('Кашкадарьинская область', 'Шахрисабз', 'Shahrisabz'),
  ('Кашкадарьинская область', 'Китаб', 'Kitob'),
  ('Кашкадарьинская область', 'Гузар', 'G‘uzor'),
  ('Навоийская область', 'Навои', 'Navoiy'),
  ('Навоийская область', 'Зарафшан', 'Zarafshon'),
  ('Навоийская область', 'Учкудук', 'Uchquduq'),
  ('Наманганская область', 'Наманган', 'Namangan'),
  ('Наманганская область', 'Чуст', 'Chust'),
  ('Наманганская область', 'Касансай', 'Kosonsoy'),
  ('Наманганская область', 'Учкурган', 'Uchqo‘rg‘on'),
  ('Самаркандская область', 'Самарканд', 'Samarqand'),
  ('Самаркандская область', 'Каттакурган', 'Kattaqo‘rg‘on'),
  ('Самаркандская область', 'Ургут', 'Urgut'),
  ('Самаркандская область', 'Булунгур', 'Bulung‘ur'),
  ('Сурхандарьинская область', 'Термез', 'Termiz'),
  ('Сурхандарьинская область', 'Денау', 'Denov'),
  ('Сурхандарьинская область', 'Шерабад', 'Sherobod'),
  ('Сурхандарьинская область', 'Шурчи', 'Sho‘rchi'),
  ('Сырдарьинская область', 'Гулистан', 'Guliston'),
  ('Сырдарьинская область', 'Янгиер', 'Yangiyer'),
  ('Сырдарьинская область', 'Ширин', 'Shirin'),
  ('Сырдарьинская область', 'Сырдарья', 'Sirdaryo'),
  ('Ферганская область', 'Фергана', 'Farg‘ona'),
  ('Ферганская область', 'Коканд', 'Qo‘qon'),
  ('Ферганская область', 'Маргилан', 'Marg‘ilon'),
  ('Ферганская область', 'Кувасай', 'Quvasoy'),
  ('Ферганская область', 'Риштан', 'Rishton'),
  ('Хорезмская область', 'Ургенч', 'Urganch'),
  ('Хорезмская область', 'Хива', 'Xiva'),
  ('Хорезмская область', 'Ханка', 'Xonqa'),
  ('Хорезмская область', 'Питнак', 'Pitnak')
) AS v(region, ru, uz)
JOIN "regions" r ON lower(r."name_ru") = lower(v.region)
WHERE NOT EXISTS (SELECT 1 FROM "cities" c WHERE c."region_id" = r."id" AND lower(c."name_ru") = lower(v.ru));

-- Test tariff for every active region without an active region-wide tariff (marked "test, check" in the admin)
INSERT INTO "delivery_tariffs" ("id", "region_id", "city_id", "tariff_uzs", "free_shipping_threshold_uzs", "is_test")
SELECT gen_random_uuid(), r."id", NULL, 35000, 500000, true FROM "regions" r
WHERE r."status" = 'active'
  AND NOT EXISTS (SELECT 1 FROM "delivery_tariffs" t WHERE t."region_id" = r."id" AND t."city_id" IS NULL AND t."status" = 'active');

-- Starting delivery terms for region-wide tariffs that have none yet: Tashkent city 2-5, other regions 5-10 working days
UPDATE "delivery_tariffs" t SET
  "min_days" = CASE WHEN r."name_ru" = 'г. Ташкент' THEN 2 ELSE 5 END,
  "max_days" = CASE WHEN r."name_ru" = 'г. Ташкент' THEN 5 ELSE 10 END
FROM "regions" r
WHERE r."id" = t."region_id" AND t."city_id" IS NULL AND t."min_days" IS NULL AND t."max_days" IS NULL;

-- A3/A4/A5: texts, contacts and hours editable in the admin panel
INSERT INTO "settings" ("key", "value", "updated_at") VALUES
  ('support_contact', '"@VITALO_support"', now()),
  ('payment_check_hours', '{"from": "08:00", "to": "22:00"}', now()),
  ('delivery_days_label', '{"ru": "рабочих дней", "uz": "ish kuni"}', now())
ON CONFLICT ("key") DO NOTHING;

-- A1: Public offer and Privacy policy, test version 0.1-test (the real one is published later from the admin panel)

INSERT INTO "legal_documents" ("id", "code", "version", "text_ru", "text_uz", "status", "published_at")
SELECT gen_random_uuid(), 'offer', '0.1-test', $legal$Настоящая оферта определяет условия, на которых магазин VITALO продаёт товары через Telegram-бот и мини-приложение. Оформляя заказ, вы соглашаетесь с этими условиями.

**1. Общие положения**

1.1. Продавец: \[полное наименование, ИНН, адрес\] (далее: Продавец, VITALO).

1.2. Покупатель: физическое лицо, оформляющее заказ в магазине VITALO (далее: Покупатель).

1.3. Магазин: Telegram-бот @vitalo\_store\_bot и мини-приложение VITALO Store.

1.4. Настоящий документ является публичной офертой. Акцептом оферты считается оформление заказа Покупателем и отметка о согласии с офертой при первом входе в магазин. С этого момента договор купли-продажи считается заключённым.

1.5. Покупатель подтверждает, что ему исполнилось 18 лет и он действует от своего имени.

**2. Предмет договора**

2.1. Продавец передаёт в собственность Покупателя товары, выбранные в магазине, а Покупатель оплачивает их и принимает на условиях оферты.

2.2. Основные характеристики товара, состав, способ применения и противопоказания указаны в карточке товара.

**3. О товарах**

3.1. Товары в магазине являются биологически активными добавками к пище (БАД). БАД не является лекарственным средством и не предназначен для лечения заболеваний.

3.2. Перед применением проконсультируйтесь с врачом, особенно при беременности, кормлении грудью, хронических заболеваниях и приёме лекарств. Используйте товар в соответствии с инструкцией производителя.

3.3. Изображения товаров носят справочный характер, внешний вид упаковки может отличаться у производителя.

3.4. Наличие товара отображается в магазине. Если товара нет в наличии, оформить заказ на него нельзя.

**4. Заказ и цена**

4.1. Цены указаны в узбекских сумах. Цена товара фиксируется в момент создания заказа и не меняется до окончания срока резерва, даже если цена в магазине изменилась.

4.2. После создания заказа товар резервируется на время, отведённое на оплату: \[12 часов\] при оплате переводом. Если заказ не оплачен в этот срок, он отменяется автоматически, а товар возвращается в продажу.

4.3. Итоговая стоимость заказа (товары и доставка) показывается Покупателю до оплаты на экране подтверждения.

**5. Оплата**

5.1. Оплата производится переводом на банковскую карту или по банковским реквизитам Продавца, указанным на экране оплаты. Иные способы оплаты (Payme, Click, Uzum, наличные при получении) могут быть добавлены позже, об этом Продавец сообщит в магазине.

5.2. После перевода Покупатель нажимает кнопку «Я оплатил(а)». Продавец проверяет поступление платежа ежедневно с 8:00 до 22:00. После подтверждения статус заказа меняется на «Оплачен».

5.3. Платёж, переведённый на неверные реквизиты или не соответствующий сумме заказа, может быть не засчитан. В этом случае Покупатель должен обратиться в поддержку: @VITALO\_support.

5.4. Продавец не хранит данные банковских карт Покупателей.

**6. Доставка**

6.1. Доставка осуществляется по всей территории Республики Узбекистан курьером или транспортным партнёром.

6.2. Ориентировочные сроки: по городу Ташкенту 2-5 рабочих дней, по регионам 5-10 рабочих дней с момента подтверждения оплаты. Сроки могут быть увеличены из-за обстоятельств, не зависящих от Продавца.

6.3. Стоимость доставки зависит от региона и города и показывается до оформления заказа. Если сумма заказа достигает порога бесплатной доставки, доставка бесплатна.

6.4. Покупатель обязан указать точный адрес, имя и телефон получателя и быть доступным по телефону. Продавец не отвечает за задержку из-за неверных данных.

6.5. При получении проверьте целостность упаковки и количество товара. О видимых повреждениях сообщите курьеру и в поддержку в день получения.

**7. Отмена заказа**

7.1. Покупатель может сам отменить заказ, пока он не оплачен.

7.2. Заказ, по которому оплата уже отмечена или подтверждена, но он ещё не передан в доставку, отменяется через поддержку (@VITALO\_support). Продавец рассматривает обращение и возвращает деньги в порядке раздела 8.

7.3. После передачи заказа в доставку Покупатель может отправить запрос на отмену в поддержку, решение принимает Продавец.

**8. Возврат и обмен**

8.1. Возврат товара ненадлежащего качества (повреждение, неверный товар, несоответствие описанию) осуществляется в соответствии с законодательством Республики Узбекистан. Обратитесь в поддержку в течение \[7\] дней со дня получения, приложите фото упаковки и товара.

8.2. Возврат товара надлежащего качества: \[ЮРИСТ: уточнить, допускается ли возврат БАД надлежащего качества, и на каких условиях\]. Если возврат допускается, товар должен быть в нераспечатанной заводской упаковке, без следов использования.

8.3. Деньги возвращаются тем же способом, которым была оплата, в течение \[срок\] рабочих дней после одобрения возврата. Стоимость доставки возвращается в случаях, предусмотренных законом.

**9. Ответственность**

9.1. Продавец отвечает за соответствие товара описанию и за качество в рамках законодательства.

9.2. Продавец не отвечает за последствия применения товара с нарушением инструкции или без учёта противопоказаний.

**10. Персональные данные**

10.1. Продавец обрабатывает персональные данные Покупателя в соответствии с Политикой конфиденциальности, размещённой в магазине.

**11. Прочие условия**

11.1. Продавец может изменять оферту. Новая версия вступает в силу с момента публикации в магазине. Для заказов, оформленных ранее, действуют условия на дату оформления.

11.2. Споры решаются путём переговоров, а при недостижении согласия: в суде по месту нахождения Продавца или в порядке, предусмотренном законодательством.

**12. Реквизиты и контакты Продавца**

&#91;Полное наименование\], ИНН \[ \], адрес \[ \].

Банковские реквизиты: \[ \].

Поддержка: Telegram @VITALO\_support, телефон \[ \], e-mail \[ \].

Версия документа: 1.0 (проект). Дата публикации: \[ \].$legal$,
$legal$Ushbu oferta VITALO do‘konining Telegram-bot va mini-ilova orqali tovarlarni sotish shartlarini belgilaydi. Buyurtma berish orqali siz ushbu shartlarga rozilik bildirasiz.

**1. Umumiy qoidalar**

1.1. Sotuvchi: \[to‘liq nomi, STIR, manzili\] (keyingi o‘rinlarda: Sotuvchi, VITALO).

1.2. Xaridor: VITALO do‘konida buyurtma beruvchi jismoniy shaxs (keyingi o‘rinlarda: Xaridor).

1.3. Do‘kon: @vitalo\_store\_bot Telegram-boti va VITALO Store mini-ilovasi.

1.4. Ushbu hujjat ommaviy ofertadir. Xaridorning buyurtma berishi va do‘konga birinchi kirishda oferta shartlariga roziligini bildirishi oferta akseptidir. Shu paytdan e’tiboran oldi-sotdi shartnomasi tuzilgan hisoblanadi.

1.5. Xaridor 18 yoshga to‘lganini va o‘z nomidan harakat qilayotganini tasdiqlaydi.

**2. Shartnoma predmeti**

2.1. Sotuvchi do‘konda tanlangan tovarlarni Xaridorning mulkiga topshiradi, Xaridor esa ularni oferta shartlarida to‘laydi va qabul qiladi.

2.2. Tovarning asosiy xususiyatlari, tarkibi, qo‘llash usuli va qo‘llash mumkin bo‘lmagan holatlar tovar kartochkasida ko‘rsatilgan.

**3. Tovarlar haqida**

3.1. Do‘kondagi tovarlar biologik faol qo‘shimchalar (BFQ)dir. BFQ dori vositasi emas va kasalliklarni davolash uchun mo‘ljallanmagan.

3.2. Qo‘llashdan oldin shifokor bilan maslahatlashing, ayniqsa homiladorlik, emizish davrida, surunkali kasalliklarda va dori vositalarini qabul qilganda. Tovarni ishlab chiqaruvchining yo‘riqnomasiga muvofiq qo‘llang.

3.3. Tovar rasmlari ma’lumot xarakteriga ega, qadoqning tashqi ko‘rinishi ishlab chiqaruvchida farq qilishi mumkin.

3.4. Tovarning mavjudligi do‘konda ko‘rsatiladi. Tovar mavjud bo‘lmasa, unga buyurtma berib bo‘lmaydi.

**4. Buyurtma va narx**

4.1. Narxlar o‘zbek so‘mida ko‘rsatilgan. Tovar narxi buyurtma yaratilgan paytda qayd etiladi va rezerv muddati tugaguncha, do‘kondagi narx o‘zgargan bo‘lsa ham, o‘zgarmaydi.

4.2. Buyurtma yaratilgach, tovar to‘lov uchun ajratilgan vaqtga zahiraga olinadi: o‘tkazma bilan to‘lashda \[12 soat\]. Buyurtma shu muddatda to‘lanmasa, u avtomatik bekor qilinadi va tovar yana sotuvga qaytadi.

4.3. Buyurtmaning yakuniy narxi (tovarlar va yetkazib berish) to‘lovdan oldin tasdiqlash ekranida ko‘rsatiladi.

**5. To‘lov**

5.1. To‘lov bank kartasiga yoki Sotuvchining to‘lov ekranida ko‘rsatilgan bank rekvizitlari bo‘yicha o‘tkazma orqali amalga oshiriladi. Boshqa to‘lov usullari (Payme, Click, Uzum, qabul qilganda naqd pul) keyinroq qo‘shilishi mumkin, bu haqda Sotuvchi do‘konda xabar beradi.

5.2. O‘tkazmadan so‘ng Xaridor «To‘ladim» tugmasini bosadi. Sotuvchi to‘lov kelib tushganini har kuni soat 8:00 dan 22:00 gacha tekshiradi. Tasdiqlangandan so‘ng buyurtma holati «To‘langan»ga o‘zgaradi.

5.3. Noto‘g‘ri rekvizitlarga yoki buyurtma summasiga mos kelmaydigan to‘lov hisobga olinmasligi mumkin. Bunday holda Xaridor qo‘llab-quvvatlash xizmatiga murojaat qilishi kerak: @VITALO\_support.

5.4. Sotuvchi Xaridorlarning bank kartasi ma’lumotlarini saqlamaydi.

**6. Yetkazib berish**

6.1. Yetkazib berish butun O‘zbekiston Respublikasi hududi bo‘ylab kuryer yoki transport hamkori orqali amalga oshiriladi.

6.2. Taxminiy muddatlar: Toshkent shahri bo‘yicha 2-5 ish kuni, viloyatlar bo‘yicha 5-10 ish kuni (to‘lov tasdiqlangan paytdan boshlab). Sotuvchiga bog‘liq bo‘lmagan holatlar tufayli muddatlar uzayishi mumkin.

6.3. Yetkazib berish narxi viloyat va shaharga bog‘liq bo‘lib, buyurtma berishdan oldin ko‘rsatiladi. Buyurtma summasi bepul yetkazib berish chegarasiga yetsa, yetkazib berish bepul bo‘ladi.

6.4. Xaridor aniq manzil, qabul qiluvchining ismi va telefon raqamini ko‘rsatishi va telefon orqali bog‘lanishga tayyor bo‘lishi shart. Noto‘g‘ri ma’lumotlar sababli kechikish uchun Sotuvchi javob bermaydi.

6.5. Qabul qilganda qadoq butunligini va tovar sonini tekshiring. Ko‘rinadigan shikastlanishlar haqida olingan kuni kuryerga va qo‘llab-quvvatlash xizmatiga xabar bering.

**7. Buyurtmani bekor qilish**

7.1. Xaridor buyurtma to‘lanmaguncha uni o‘zi bekor qilishi mumkin.

7.2. To‘lovi belgilangan yoki tasdiqlangan, lekin hali yetkazib berishga topshirilmagan buyurtma qo‘llab-quvvatlash xizmati (@VITALO\_support) orqali bekor qilinadi. Sotuvchi murojaatni ko‘rib chiqadi va pulni 8-bo‘lim tartibida qaytaradi.

7.3. Buyurtma yetkazib berishga topshirilgandan so‘ng Xaridor qo‘llab-quvvatlash xizmatiga bekor qilish so‘rovini yuborishi mumkin, qarorni Sotuvchi qabul qiladi.

**8. Qaytarish va almashtirish**

8.1. Sifatsiz tovarni (shikastlangan, noto‘g‘ri tovar, tavsifga mos kelmaslik) qaytarish O‘zbekiston Respublikasi qonunchiligiga muvofiq amalga oshiriladi. Tovar olingan kundan boshlab \[7\] kun ichida qo‘llab-quvvatlash xizmatiga murojaat qiling, qadoq va tovar suratini ilova qiling.

8.2. Sifatli tovarni qaytarish: \[YURIST: sifatli BFQni qaytarishga ruxsat berilishi va qanday shartlarda ekanini aniqlash\]. Qaytarishga ruxsat berilsa, tovar ochilmagan zavod qadog‘ida, foydalanish izlarisiz bo‘lishi kerak.

8.3. Pul to‘lov amalga oshirilgan usulda, qaytarish tasdiqlangandan so‘ng \[muddat\] ish kuni ichida qaytariladi. Yetkazib berish narxi qonunda nazarda tutilgan hollarda qaytariladi.

**9. Mas’uliyat**

9.1. Sotuvchi tovarning tavsifga mosligi va sifati uchun qonunchilik doirasida javob beradi.

9.2. Sotuvchi tovarni yo‘riqnomani buzgan holda yoki qo‘llash mumkin bo‘lmagan holatlarni hisobga olmasdan qo‘llash oqibatlari uchun javob bermaydi.

**10. Shaxsga doir ma’lumotlar**

10.1. Sotuvchi Xaridorning shaxsga doir ma’lumotlarini do‘konda joylashtirilgan Maxfiylik siyosatiga muvofiq qayta ishlaydi.

**11. Boshqa shartlar**

11.1. Sotuvchi ofertani o‘zgartirishi mumkin. Yangi tahrir do‘konda e’lon qilingan paytdan kuchga kiradi. Avval berilgan buyurtmalar uchun buyurtma berilgan sanadagi shartlar amal qiladi.

11.2. Nizolar muzokaralar yo‘li bilan, kelishuvga erishilmasa Sotuvchi joylashgan joydagi sudda yoki qonunchilikda belgilangan tartibda hal qilinadi.

**12. Sotuvchining rekvizitlari va aloqa**

&#91;To‘liq nomi\], STIR \[ \], manzil \[ \].

Bank rekvizitlari: \[ \].

Qo‘llab-quvvatlash: Telegram @VITALO\_support, telefon \[ \], e-mail \[ \].

Hujjat versiyasi: 1.0 (loyiha). E’lon qilingan sana: \[ \].$legal$,
  'active'::"LegalStatus", now()
WHERE NOT EXISTS (SELECT 1 FROM "legal_documents" d WHERE d."code" = 'offer' AND (d."version" = '0.1-test' OR d."status" = 'active'));

INSERT INTO "legal_documents" ("id", "code", "version", "text_ru", "text_uz", "status", "published_at")
SELECT gen_random_uuid(), 'privacy', '0.1-test', $legal$Эта политика объясняет, какие данные о вас собирает магазин VITALO, зачем, как долго хранит и как вы можете ими управлять.

**1. Кто обрабатывает данные**

Оператор персональных данных: \[полное наименование, ИНН, адрес\] (далее: VITALO). Контакты по вопросам данных: Telegram @VITALO\_support, e-mail \[ \].

**2. Какие данные мы собираем**

- Данные профиля Telegram: идентификатор (ID), имя, фамилия, username, язык интерфейса.
- Контактные данные: номер телефона, который вы передаёте через Telegram или вводите вручную.
- Данные доставки: имя получателя, телефон, регион, город, адрес, при желании геопозиция.
- Данные заказов: состав заказа, суммы, статусы, способ оплаты, история обращений в поддержку.
- Технические данные использования магазина: открытие приложения, просмотр товаров, добавление в корзину, оформление заказа. Это внутренний счётчик событий для улучшения магазина, без передачи сторонним рекламным сервисам.
- Согласия: версия оферты и политики, которую вы приняли, дата и источник согласия.

Мы не собираем и не храним данные банковских карт. Мы не запрашиваем у вас пароли.

**3. Зачем мы используем данные**

- Принять, обработать и доставить заказ, подтвердить оплату.
- Связаться с вами по заказу и отправлять сервисные уведомления в Telegram (о статусах заказа, оплате, доставке). Их нельзя отключить, пока у вас есть активные заказы.
- Отвечать на обращения в поддержку.
- Вести учёт заказов и выполнять требования законодательства.
- Улучшать работу магазина (по обобщённой статистике).
- Отправлять акции и новости, только если вы дали на это отдельное согласие. Отказаться можно в любой момент в профиле магазина.

**4. Основание обработки**

Мы обрабатываем данные на основании вашего согласия, которое вы даёте при первом входе в магазин, и для исполнения договора купли-продажи, заключённого с вами.

**5. Кому мы можем передавать данные**

- Курьерам и транспортным партнёрам: только имя получателя, телефон и адрес, необходимые для доставки.
- Сотрудникам VITALO в пределах их ролей (менеджеры, склад).
- Поставщикам технических услуг (хостинг, уведомления), которые обрабатывают данные по нашему поручению.
- Государственным органам по их законному требованию.

Мы не продаём ваши данные.

**6. Где хранятся данные**

Данные хранятся на серверах, расположенных на территории Республики Узбекистан: \[наименование хостинг-провайдера, подтвердить\]. Мы принимаем технические и организационные меры защиты: шифрованное соединение (HTTPS), разграничение доступа сотрудников, журнал действий, резервное копирование.

**7. Сроки хранения**

Данные профиля и заказов хранятся, пока у вас есть аккаунт, и далее в течение срока, необходимого по закону для финансового учёта. Когда вы удаляете аккаунт, персональные данные удаляются, а история заказов остаётся в обезличенном виде для финансовой отчётности. В течение 30 дней после удаления профиль и история заказов могут быть восстановлены по вашему обращению; сохранённые адреса, избранное и бонусный баланс в этом случае не восстанавливаются.

**8. Ваши права**

Вы можете: узнать, какие данные о вас обрабатываются; потребовать исправить или удалить их; отозвать согласие; отказаться от маркетинговых сообщений; удалить аккаунт в профиле магазина или через поддержку. Отзыв согласия может сделать невозможным оформление новых заказов. Обратиться можно в @VITALO\_support, ответим в разумный срок, не позднее установленного законом.

**9. Дети**

Магазин предназначен для лиц старше 18 лет. Если вам стало известно, что несовершеннолетний передал нам данные, сообщите в поддержку, и мы их удалим.

**10. Изменения политики**

Мы можем обновлять политику. При существенных изменениях мы покажем новую версию в магазине и попросим подтвердить согласие.

**11. Контакты**

&#91;Полное наименование\], адрес \[ \], Telegram @VITALO\_support, e-mail \[ \].

Версия документа: 1.0 (проект). Дата публикации: \[ \].$legal$,
$legal$Ushbu siyosat VITALO do‘koni siz haqingizda qanday ma’lumotlarni yig‘ishi, nima uchun, qancha vaqt saqlashi va ularni qanday boshqarishingiz mumkinligini tushuntiradi.

**1. Ma’lumotlarni kim qayta ishlaydi**

Shaxsga doir ma’lumotlar operatori: \[to‘liq nomi, STIR, manzili\] (keyingi o‘rinlarda: VITALO). Ma’lumotlar bo‘yicha aloqa: Telegram @VITALO\_support, e-mail \[ \].

**2. Qanday ma’lumotlarni yig‘amiz**

- Telegram profili ma’lumotlari: identifikator (ID), ism, familiya, username, interfeys tili.
- Aloqa ma’lumotlari: Telegram orqali yuborgan yoki qo‘lda kiritgan telefon raqamingiz.
- Yetkazib berish ma’lumotlari: qabul qiluvchining ismi, telefoni, viloyat, shahar, manzil, xohlasangiz geolokatsiya.
- Buyurtma ma’lumotlari: buyurtma tarkibi, summalar, holatlar, to‘lov usuli, qo‘llab-quvvatlashga murojaatlar tarixi.
- Do‘kondan foydalanish texnik ma’lumotlari: ilovani ochish, tovarlarni ko‘rish, savatga qo‘shish, buyurtma rasmiylashtirish. Bu do‘konni yaxshilash uchun ichki hodisalar hisoblagichi bo‘lib, uchinchi tomon reklama xizmatlariga uzatilmaydi.
- Rozilik ma’lumotlari: siz qabul qilgan oferta va siyosat versiyasi, rozilik sanasi va manbasi.

Biz bank kartasi ma’lumotlarini yig‘maymiz va saqlamaymiz. Parollaringizni so‘ramaymiz.

**3. Ma’lumotlardan nima uchun foydalanamiz**

- Buyurtmani qabul qilish, qayta ishlash va yetkazib berish, to‘lovni tasdiqlash.
- Buyurtma bo‘yicha siz bilan bog‘lanish va Telegramda xizmat xabarnomalarini yuborish (buyurtma holati, to‘lov, yetkazib berish haqida). Faol buyurtmalaringiz bor ekan, ularni o‘chirib bo‘lmaydi.
- Qo‘llab-quvvatlash xizmatiga murojaatlarga javob berish.
- Buyurtmalar hisobini yuritish va qonunchilik talablarini bajarish.
- Do‘kon ishini yaxshilash (umumlashtirilgan statistika asosida).
- Aksiya va yangiliklarni faqat siz buning uchun alohida rozilik bergan bo‘lsangiz yuborish. Xohlagan vaqtda do‘kon profilida rad etishingiz mumkin.

**4. Qayta ishlash asosi**

Ma’lumotlarni do‘konga birinchi kirishda bergan roziligingiz asosida va siz bilan tuzilgan oldi-sotdi shartnomasini bajarish uchun qayta ishlaymiz.

**5. Ma’lumotlarni kimga uzatishimiz mumkin**

- Kuryerlar va transport hamkorlariga: faqat yetkazib berish uchun zarur bo‘lgan qabul qiluvchi ismi, telefoni va manzili.
- VITALO xodimlariga ularning rollari doirasida (menejerlar, ombor).
- Bizning topshirig‘imiz bilan ma’lumotlarni qayta ishlaydigan texnik xizmat ko‘rsatuvchilarga (xosting, xabarnomalar).
- Davlat organlariga ularning qonuniy talabi bo‘yicha.

Ma’lumotlaringizni sotmaymiz.

**6. Ma’lumotlar qayerda saqlanadi**

Ma’lumotlar O‘zbekiston Respublikasi hududida joylashgan serverlarda saqlanadi: \[xosting provayderi nomi, aniqlash\]. Biz texnik va tashkiliy himoya choralarini ko‘ramiz: shifrlangan ulanish (HTTPS), xodimlar kirish huquqlarini cheklash, harakatlar jurnali, zaxira nusxalash.

**7. Saqlash muddatlari**

Profil va buyurtma ma’lumotlari akkauntingiz mavjud ekan va undan keyin moliyaviy hisob uchun qonunda talab etilgan muddat davomida saqlanadi. Akkauntni o‘chirsangiz, shaxsga doir ma’lumotlar o‘chiriladi, buyurtmalar tarixi esa moliyaviy hisobot uchun shaxsiz ko‘rinishda qoladi. O‘chirilgandan keyin 30 kun ichida profil va buyurtmalar tarixi murojaatingiz bo‘yicha tiklanishi mumkin; saqlangan manzillar, sevimlilar va bonus balansi bunda tiklanmaydi.

**8. Sizning huquqlaringiz**

Siz: o‘zingiz haqingizdagi qaysi ma’lumotlar qayta ishlanayotganini bilishingiz; ularni tuzatishni yoki o‘chirishni talab qilishingiz; rozilikni qaytarib olishingiz; marketing xabarlaridan voz kechishingiz; do‘kon profilida yoki qo‘llab-quvvatlash xizmati orqali akkauntni o‘chirishingiz mumkin. Rozilikni qaytarib olish yangi buyurtmalar berishni imkonsiz qilishi mumkin. Murojaat uchun: @VITALO\_support, qonunda belgilangan muddatdan kechikmay, oqilona muddatda javob beramiz.

**9. Bolalar**

Do‘kon 18 yoshdan oshgan shaxslar uchun mo‘ljallangan. Voyaga yetmagan shaxs bizga ma’lumot berganini bilsangiz, qo‘llab-quvvatlash xizmatiga xabar bering, biz ularni o‘chiramiz.

**10. Siyosatdagi o‘zgarishlar**

Siyosatni yangilashimiz mumkin. Muhim o‘zgarishlarda yangi versiyani do‘konda ko‘rsatamiz va rozilikni tasdiqlashni so‘raymiz.

**11. Aloqa**

&#91;To‘liq nomi\], manzil \[ \], Telegram @VITALO\_support, e-mail \[ \].

Hujjat versiyasi: 1.0 (loyiha). E’lon qilingan sana: \[ \].$legal$,
  'active'::"LegalStatus", now()
WHERE NOT EXISTS (SELECT 1 FROM "legal_documents" d WHERE d."code" = 'privacy' AND (d."version" = '0.1-test' OR d."status" = 'active'));
