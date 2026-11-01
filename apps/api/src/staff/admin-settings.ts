import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { EntityStatus, Prisma, StaffRole, StaffStatus, TariffStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PageQuery } from '../catalog/catalog.dto';
import { DeliveryService } from '../delivery/delivery.service';
import { PrismaService } from '../prisma/prisma.service';
import { manifestOrDefault } from '../settings/home-content';
import { BankTransferDetails, MANUAL_PAYMENT_METHODS, SETTING_KEYS, SettingsService } from '../settings/settings.service';
import { OnlinePaymentsService } from '../payments/online/online-payments.service';
import { ONLINE_MODES, onlineModes, type OnlineMode, type OnlineModes } from '../payments/online/online-providers';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffAuthService, StaffContext, StaffGuard } from './staff-auth';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

// ---------------- DTOs ----------------

export class BankTransferDto implements BankTransferDetails {
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) recipient!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) bank_name!: string;
  @ApiProperty({ example: '20208000000000000001' }) @Transform(trim) @Matches(/^\d{20}$/, { message: 'account: 20 digits' }) account!: string;
  @ApiProperty({ example: '00014' }) @Transform(trim) @Matches(/^\d{5}$/, { message: 'mfo: 5 digits' }) mfo!: string;
  @ApiProperty({ example: '123456789' }) @Transform(trim) @Matches(/^\d{9}$/, { message: 'inn: 9 digits' }) inn!: string;

  @ApiProperty({ example: 'Оплата заказа {order_number}' })
  @Transform(trim)
  @IsString()
  @Matches(/\{order_number\}/, { message: 'purpose_template must contain {order_number}' })
  @MaxLength(200)
  purpose_template!: string;
}

export class LocalizedTextDto {
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(1000) ru!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(1000) uz!: string;
}

export class CardTransferDto {
  @ApiProperty({ example: '8600 1234 5678 9012', description: '16 цифр, пробелы допускаются' })
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\s/g, '') : value))
  @Matches(/^\d{16}$/, { message: 'card_number: 16 digits' })
  card_number!: string;

  /** Release 1 (D-04): the card holder's name is never shown to customers, so it is optional (kept only for staff). */
  @ApiPropertyOptional({ example: 'ALISHER KARIMOV' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) recipient?: string;
}

/** Customer-facing texts editable by the admin. */
export class ShopTextsDto {
  @ApiProperty({ type: LocalizedTextDto, description: 'Пометка внизу карточки товара' })
  @IsObject()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  product_disclaimer!: LocalizedTextDto;

  @ApiProperty({ type: LocalizedTextDto, description: 'Подсказка на экране оплаты переводом' })
  @IsObject()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  payment_hint!: LocalizedTextDto;
}

export class TariffDto {
  @ApiProperty() @IsUUID() region_id!: string;
  @ApiPropertyOptional({ nullable: true, description: 'Пусто — тариф по умолчанию для всего региона' }) @IsOptional() @IsUUID() city_id?: string | null;
  @ApiProperty() @IsInt() @Min(0) tariff_uzs!: number;
  @ApiProperty() @IsInt() @Min(0) free_shipping_threshold_uzs!: number;
  @ApiPropertyOptional({ enum: TariffStatus }) @IsOptional() @IsEnum(TariffStatus) status?: TariffStatus;
  @ApiPropertyOptional({ nullable: true, description: 'Срок доставки от, рабочих дней (пусто у города — берётся срок региона)' }) @IsOptional() @IsInt() @Min(0) @Max(90) min_days?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(0) @Max(90) max_days?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(300) note_ru?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(300) note_uz?: string | null;
  @ApiPropertyOptional({ description: 'Тестовый тариф (подсвечивается в админке)' }) @IsOptional() @IsBoolean() is_test?: boolean;
}

export class CityDto {
  @ApiProperty() @IsUUID() region_id!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name_ru!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name_uz!: string;
}

export class CityPatch {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name_ru?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name_uz?: string;
  @ApiPropertyOptional({ enum: EntityStatus }) @IsOptional() @IsEnum(EntityStatus) status?: EntityStatus;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export class ShopContactsDto {
  @ApiProperty({ example: '@VITALO_support', description: 'Telegram-контакт поддержки' })
  @Transform(trim)
  @Matches(/^(?:https?:\/\/)?(?:t\.me\/|@)?[A-Za-z0-9_]{5,32}$/, { message: 'support_contact: @username or t.me/username' })
  support_contact!: string;

  @ApiProperty({ example: '08:00' }) @Matches(HHMM, { message: 'payment_check_from: HH:MM' }) payment_check_from!: string;
  @ApiProperty({ example: '22:00' }) @Matches(HHMM, { message: 'payment_check_to: HH:MM' }) payment_check_to!: string;

  @ApiPropertyOptional({ example: 3, description: 'За сколько часов до автоотмены напомнить об оплате' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  payment_reminder_hours?: number;

  @ApiPropertyOptional({ example: 3, description: 'Через сколько часов после «Я оплатил(а)» напомнить менеджерам о непроверенной оплате (1–48)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(48)
  payment_check_reminder_hours?: number;

  @ApiProperty({ type: LocalizedTextDto, description: 'Подпись срока доставки: «рабочих дней»' })
  @IsObject()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  delivery_days_label!: LocalizedTextDto;
}

export class TariffPatch extends PartialType(TariffDto) {}

/** Stage 0.3: how long an unpaid order holds its reservation (card / bank transfer), minutes. */
export class PaymentTimeoutDto {
  @ApiProperty({ example: 720, minimum: 30, maximum: 1440, description: 'Срок резерва неоплаченного заказа, минут (30–1440)' })
  @IsInt()
  @Min(30)
  @Max(1440)
  timeout_minutes!: number;
}

/** 2.1: one mode per online payment system. */
export class OnlineModesDto {
  @ApiProperty({ enum: ONLINE_MODES }) @IsIn(ONLINE_MODES) payme!: OnlineMode;
  @ApiProperty({ enum: ONLINE_MODES }) @IsIn(ONLINE_MODES) click!: OnlineMode;
  @ApiProperty({ enum: ONLINE_MODES }) @IsIn(ONLINE_MODES) uzum!: OnlineMode;
}

/** Release 1: checkout switches (Настройки → Оплата). cod_max_total_uzs: null or empty = no limit. */
export class CheckoutOptionsDto {
  @ApiPropertyOptional({ nullable: true, example: 2000000, description: 'Максимальная сумма заказа для оплаты при получении; пусто = без ограничения' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  cod_max_total_uzs!: number | null;

  /** Release 1 switch, kept for old clients: used only when `online` is not sent (true = all «Скоро», false = all hidden). */
  @ApiPropertyOptional({ description: 'Старый общий переключатель «Скоро» (если не передан online)' }) @IsOptional() @IsBoolean() show_online_soon?: boolean;
  @ApiProperty({ description: 'Бесплатная доставка первого заказа клиента' }) @IsBoolean() first_order_free_delivery!: boolean;

  @ApiPropertyOptional({ description: 'Payme / Click / Uzum: hidden — скрыта, soon — «Скоро», live — работает (только с ключами и модулем)', type: OnlineModesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OnlineModesDto)
  online?: OnlineModesDto;
}

/** Physical ID label paper, mm. XP-365B prints up to 76 mm wide. Default 58×40. */
export class LabelSizeDto {
  @ApiProperty({ example: 58, minimum: 30, maximum: 76 }) @IsInt() @Min(30) @Max(76) width_mm!: number;
  @ApiProperty({ example: 40, minimum: 20, maximum: 120 }) @IsInt() @Min(20) @Max(120) height_mm!: number;
}

/** Short texts (banner, tiles): up to 200 characters, both languages required. */
export class ShortTextDto {
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) ru!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) uz!: string;
}

export class HomeBannerDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty({ type: ShortTextDto }) @IsObject() @ValidateNested() @Type(() => ShortTextDto) title!: ShortTextDto;
  @ApiProperty({ type: ShortTextDto }) @IsObject() @ValidateNested() @Type(() => ShortTextDto) subtitle!: ShortTextDto;
  @ApiProperty({ type: ShortTextDto }) @IsObject() @ValidateNested() @Type(() => ShortTextDto) button!: ShortTextDto;
}

export class TrustTileDto {
  @ApiProperty({ enum: ['original', 'delivery', 'documents', 'payments'] }) @IsIn(['original', 'delivery', 'documents', 'payments']) key!: 'original' | 'delivery' | 'documents' | 'payments';
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty({ type: ShortTextDto }) @IsObject() @ValidateNested() @Type(() => ShortTextDto) title!: ShortTextDto;
  @ApiProperty({ type: ShortTextDto, description: '{delivery} — сроки доставки, {from}/{to} — часы проверки платежей' })
  @IsObject()
  @ValidateNested()
  @Type(() => ShortTextDto)
  text!: ShortTextDto;
}

export class HomeStepsDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty({ type: [ShortTextDto] }) @IsArray() @ArrayMinSize(3) @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => ShortTextDto) items!: ShortTextDto[];
}

/** Home page content (B1). */
export class HomeContentDto {
  @ApiProperty({ type: HomeBannerDto }) @IsObject() @ValidateNested() @Type(() => HomeBannerDto) banner!: HomeBannerDto;
  @ApiProperty({ type: [TrustTileDto] }) @IsArray() @ArrayMinSize(4) @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => TrustTileDto) trust!: TrustTileDto[];
  @ApiProperty({ type: HomeStepsDto }) @IsObject() @ValidateNested() @Type(() => HomeStepsDto) steps!: HomeStepsDto;
}

/** 2.4: «Как VITALO отбирает добавки» (Настройки → Главная → Манифест): every text in RU and UZ, exactly 3 cards. */
/** RU/UZ text that may be left empty (the «Не берём» line of a manifest card is then not shown). */
export class OptionalTextDto {
  @ApiProperty() @Transform(trim) @IsString() @MaxLength(300) ru!: string;
  @ApiProperty() @Transform(trim) @IsString() @MaxLength(300) uz!: string;
}

/** 2.4 patch: a card «Не берём / Стандарт VITALO». */
export class ManifestCardDto {
  @ApiProperty({ type: LocalizedTextDto }) @IsObject() @ValidateNested() @Type(() => LocalizedTextDto) title!: LocalizedTextDto;
  @ApiProperty({ type: OptionalTextDto }) @IsObject() @ValidateNested() @Type(() => OptionalTextDto) bad!: OptionalTextDto;
  @ApiProperty({ type: LocalizedTextDto }) @IsObject() @ValidateNested() @Type(() => LocalizedTextDto) good!: LocalizedTextDto;
}

export class ManifestDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty({ type: LocalizedTextDto }) @IsObject() @ValidateNested() @Type(() => LocalizedTextDto) title!: LocalizedTextDto;
  @ApiProperty({ type: LocalizedTextDto }) @IsObject() @ValidateNested() @Type(() => LocalizedTextDto) subtitle!: LocalizedTextDto;
  @ApiProperty({ type: LocalizedTextDto }) @IsObject() @ValidateNested() @Type(() => LocalizedTextDto) lead!: LocalizedTextDto;
  @ApiProperty({ type: [ManifestCardDto] }) @IsArray() @ArrayMinSize(3) @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => ManifestCardDto) cards!: ManifestCardDto[];
}

/** Profile card "VITALO Bonus — скоро" (B4). */
/** 3.1: «Настройки → Корзина». Up to 12 hand-picked products; an empty list = picked automatically. */
export class CartUpsellDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(12) @IsUUID('all', { each: true }) product_ids!: string[];
}

export class BonusTeaserDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty({ type: LocalizedTextDto }) @IsObject() @ValidateNested() @Type(() => LocalizedTextDto) text!: LocalizedTextDto;
}

export class StaffUserDto {
  @ApiProperty({ example: '123456789', description: 'Telegram ID сотрудника' })
  @Transform(({ value }) => String(value).trim())
  @Matches(/^\d{5,15}$/, { message: 'telegram_user_id: digits only' })
  telegram_user_id!: string;

  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @ApiProperty({ enum: StaffRole }) @IsEnum(StaffRole) role!: StaffRole;
}

export class StaffUserPatch {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @ApiPropertyOptional({ enum: StaffRole }) @IsOptional() @IsEnum(StaffRole) role?: StaffRole;
  @ApiPropertyOptional({ enum: StaffStatus }) @IsOptional() @IsEnum(StaffStatus) status?: StaffStatus;
  /** 3.4: answers «Проверить совместимость» (any role; an admin answers anyway) */
  @ApiPropertyOptional() @IsOptional() @IsBoolean() is_specialist?: boolean;
}

export class AuditQuery extends PageQuery {
  @ApiPropertyOptional({ example: 'order' }) @IsOptional() @IsString() @MaxLength(50) entity_type?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() entity_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() staff_id?: string;
  @ApiPropertyOptional({ example: 'order.' , description: 'Начало названия действия' }) @IsOptional() @IsString() @MaxLength(50) action?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() date_from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() date_to?: string;
}

// ---------------- services ----------------

@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: DeliveryService,
    private readonly audit: AuditService,
    private readonly staffAuth: StaffAuthService,
    private readonly settings: SettingsService,
    private readonly online: OnlinePaymentsService,
  ) {}

  /** Saves one settings row and writes before/after to the audit log. */
  private async saveSetting(staffId: string, key: string, value: object, action: string) {
    const json = value as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.settings.findUnique({ where: { key } });
      await tx.settings.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
      await this.audit.log({ staffId, action, entityType: 'settings', before: before?.value, after: { key, value: json } }, tx);
    });
  }

  cardTransfer() {
    return this.settings.getOrDefault('card_transfer_details');
  }

  async setCardTransfer(staffId: string, dto: CardTransferDto) {
    await this.saveSetting(staffId, SETTING_KEYS.cardTransferDetails, { card_number: dto.card_number, recipient: dto.recipient ?? '' }, 'settings.card_transfer_updated');
    return this.cardTransfer();
  }

  async shopTexts() {
    return { product_disclaimer: await this.settings.getOrDefault('product_disclaimer'), payment_hint: await this.settings.getOrDefault('payment_hint') };
  }

  async setShopTexts(staffId: string, dto: ShopTextsDto) {
    await this.saveSetting(staffId, SETTING_KEYS.productDisclaimer, { ru: dto.product_disclaimer.ru, uz: dto.product_disclaimer.uz }, 'settings.texts_updated');
    await this.saveSetting(staffId, SETTING_KEYS.paymentHint, { ru: dto.payment_hint.ru, uz: dto.payment_hint.uz }, 'settings.texts_updated');
    return this.shopTexts();
  }

  async shopContacts() {
    const hours = await this.settings.getOrDefault('payment_check_hours');
    return {
      support_contact: await this.settings.getOrDefault('support_contact'),
      payment_check_from: hours.from,
      payment_check_to: hours.to,
      delivery_days_label: await this.settings.getOrDefault('delivery_days_label'),
      payment_reminder_hours: Number(await this.settings.getOrDefault('payment_reminder_hours')),
      payment_check_reminder_hours: Number(await this.settings.getOrDefault('payment_check_reminder_hours')),
    };
  }

  async setShopContacts(staffId: string, dto: ShopContactsDto) {
    await this.saveSetting(staffId, SETTING_KEYS.supportContact, dto.support_contact as unknown as object, 'settings.contacts_updated');
    await this.saveSetting(staffId, SETTING_KEYS.paymentCheckHours, { from: dto.payment_check_from, to: dto.payment_check_to }, 'settings.contacts_updated');
    await this.saveSetting(staffId, SETTING_KEYS.deliveryDaysLabel, { ru: dto.delivery_days_label.ru, uz: dto.delivery_days_label.uz }, 'settings.contacts_updated');
    if (dto.payment_reminder_hours !== undefined) {
      await this.saveSetting(staffId, SETTING_KEYS.paymentReminderHours, dto.payment_reminder_hours as unknown as object, 'settings.contacts_updated');
    }
    if (dto.payment_check_reminder_hours !== undefined) {
      await this.saveSetting(staffId, SETTING_KEYS.paymentCheckReminderHours, dto.payment_check_reminder_hours as unknown as object, 'settings.contacts_updated');
    }
    return this.shopContacts();
  }

  /** Stage 0.3: reservation time of the manual payment methods (card / bank transfer). */
  paymentTimeouts() {
    return this.prisma.payment_methods.findMany({
      where: { code: { in: [...MANUAL_PAYMENT_METHODS] } },
      select: { code: true, name_ru: true, status: true, timeout_minutes: true },
      orderBy: { code: 'asc' },
    });
  }

  /**
   * Only new orders get the new time: reserved_until of existing orders was fixed when they were created.
   * Must not be shorter than the customer's payment reminder (it comes N hours before the cancellation).
   */
  async setPaymentTimeout(staffId: string, code: string, dto: PaymentTimeoutDto) {
    if (!(MANUAL_PAYMENT_METHODS as readonly string[]).includes(code)) throw new NotFoundException('Unknown payment method');
    const reminderHours = Number(await this.settings.getOrDefault('payment_reminder_hours'));
    if (dto.timeout_minutes < reminderHours * 60) {
      throw new BadRequestException({
        code: 'TIMEOUT_SHORTER_THAN_REMINDER',
        message: `The reservation must last at least ${reminderHours * 60} minutes: the payment reminder is sent ${reminderHours} h before the cancellation`,
      });
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.payment_methods.findUnique({ where: { code } });
      if (!before) throw new NotFoundException('Unknown payment method');
      await tx.payment_methods.update({ where: { code }, data: { timeout_minutes: dto.timeout_minutes } });
      await this.audit.log(
        {
          staffId,
          action: 'settings.payment_timeout_updated',
          entityType: 'payment_method',
          entityId: before.id,
          before: { code, timeout_minutes: before.timeout_minutes },
          after: { code, timeout_minutes: dto.timeout_minutes },
        },
        tx,
      );
    });
    return this.paymentTimeouts();
  }

  homeContent() {
    return this.settings.getOrDefault('home_content');
  }

  async setHomeContent(staffId: string, dto: HomeContentDto) {
    if (new Set(dto.trust.map((t) => t.key)).size !== dto.trust.length) {
      throw new ConflictException({ code: 'INVALID_TILES', message: 'Each trust tile appears once' });
    }
    await this.saveSetting(staffId, SETTING_KEYS.homeContent, JSON.parse(JSON.stringify(dto)), 'settings.home_updated');
    return this.homeContent();
  }

  bonusTeaser() {
    return this.settings.getOrDefault('bonus_teaser');
  }

  async manifest() {
    return manifestOrDefault(await this.settings.get('home_manifest'));
  }

  async setManifest(staffId: string, dto: ManifestDto) {
    const lt = (t: { ru: string; uz: string }) => ({ ru: t.ru, uz: t.uz });
    const value = {
      enabled: dto.enabled,
      title: lt(dto.title),
      subtitle: lt(dto.subtitle),
      lead: lt(dto.lead),
      cards: dto.cards.map((c) => ({ title: lt(c.title), bad: lt(c.bad), good: lt(c.good) })),
    };
    await this.saveSetting(staffId, SETTING_KEYS.manifest, value, 'settings.manifest_updated');
    return this.manifest();
  }

  /** The saved switch and list, with each listed product's name, price and stock (so the admin sees what is offered). */
  async cartUpsell() {
    const saved = await this.settings.getOrDefault('cart_upsell');
    const rows = saved.product_ids.length
      ? await this.prisma.products.findMany({ where: { id: { in: saved.product_ids } }, select: { id: true, sku: true, name_ru: true, short_name_ru: true, price_uzs: true, status: true, inventory: { select: { actual_qty: true, reserved_qty: true } } } })
      : [];
    const products = saved.product_ids
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is (typeof rows)[number] => !!r)
      .map((r) => ({
        id: r.id,
        sku: r.sku,
        name: r.short_name_ru || r.name_ru,
        price_uzs: Number(r.price_uzs),
        active: r.status === 'active',
        in_stock: r.inventory.some((i) => i.actual_qty - i.reserved_qty > 0),
      }));
    return { enabled: saved.enabled, product_ids: products.map((p) => p.id), products };
  }

  async setCartUpsell(staffId: string, dto: CartUpsellDto) {
    const ids = [...new Set(dto.product_ids)];
    const known = await this.prisma.products.count({ where: { id: { in: ids } } });
    if (known !== ids.length) throw new BadRequestException({ code: 'UNKNOWN_PRODUCT', message: 'Some products do not exist' });
    await this.saveSetting(staffId, SETTING_KEYS.cartUpsell, { enabled: dto.enabled, product_ids: ids }, 'settings.cart_upsell_updated');
    return this.cartUpsell();
  }

  async setBonusTeaser(staffId: string, dto: BonusTeaserDto) {
    await this.saveSetting(staffId, SETTING_KEYS.bonusTeaser, { enabled: dto.enabled, text: { ru: dto.text.ru, uz: dto.text.uz } }, 'settings.texts_updated');
    return this.bonusTeaser();
  }

  /** All regions and cities, inactive included (customers only see active ones). */
  labelSize() {
    return this.settings.getOrDefault('label_size');
  }

  async setLabelSize(staffId: string, dto: LabelSizeDto) {
    await this.saveSetting(staffId, SETTING_KEYS.labelSize, { width_mm: dto.width_mm, height_mm: dto.height_mm }, 'settings.label_size_updated');
    return this.labelSize();
  }

  /** Saved switches plus, per online system, whether «Работает» is possible (keys in .env and a module; no key values). */
  async checkoutOptions() {
    const saved = await this.settings.getOrDefault('checkout_options');
    const online = onlineModes(saved);
    return { ...saved, online, show_online_soon: Object.values(online).includes('soon'), online_status: this.online.providersStatus() };
  }

  async setCheckoutOptions(staffId: string, dto: CheckoutOptionsDto) {
    const legacy = dto.show_online_soon === false ? 'hidden' : 'soon';
    const online: OnlineModes = dto.online ? { payme: dto.online.payme, click: dto.online.click, uzum: dto.online.uzum } : { payme: legacy, click: legacy, uzum: legacy };
    this.online.assertModesAllowed(online);
    const value = {
      cod_max_total_uzs: dto.cod_max_total_uzs ?? null,
      show_online_soon: Object.values(online).includes('soon'),
      first_order_free_delivery: dto.first_order_free_delivery,
      online,
    };
    await this.saveSetting(staffId, SETTING_KEYS.checkoutOptions, value, 'settings.checkout_options_updated');
    return this.checkoutOptions();
  }

  async regions() {
    const regions = await this.prisma.regions.findMany({ orderBy: { name_ru: 'asc' }, include: { cities: { orderBy: { name_ru: 'asc' } } } });
    return regions.map((r) => ({
      id: r.id,
      name_ru: r.name_ru,
      name_uz: r.name_uz,
      status: r.status,
      cities: r.cities.map((c) => ({ id: c.id, name_ru: c.name_ru, name_uz: c.name_uz, status: c.status })),
    }));
  }

  async createCity(staffId: string, dto: CityDto) {
    if (!(await this.prisma.regions.count({ where: { id: dto.region_id } }))) throw new NotFoundException('Region not found');
    const dup = await this.prisma.cities.count({ where: { region_id: dto.region_id, name_ru: { equals: dto.name_ru, mode: 'insensitive' } } });
    if (dup) throw new ConflictException({ code: 'CITY_EXISTS', message: 'This city already exists in the region' });
    const c = await this.prisma.cities.create({ data: dto });
    await this.audit.log({ staffId, action: 'city.created', entityType: 'city', entityId: c.id, after: c });
    return this.regions();
  }

  async updateCity(staffId: string, id: string, dto: CityPatch) {
    const before = await this.prisma.cities.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('City not found');
    const after = await this.prisma.cities.update({ where: { id }, data: dto });
    await this.audit.log({ staffId, action: 'city.updated', entityType: 'city', entityId: id, before, after });
    return this.regions();
  }

  async bankTransfer() {
    const row = await this.prisma.settings.findUnique({ where: { key: SETTING_KEYS.bankTransferDetails } });
    return (row?.value as BankTransferDetails | undefined) ?? null;
  }

  async setBankTransfer(staffId: string, dto: BankTransferDto) {
    const value = { ...dto } as unknown as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.settings.findUnique({ where: { key: SETTING_KEYS.bankTransferDetails } });
      await tx.settings.upsert({ where: { key: SETTING_KEYS.bankTransferDetails }, create: { key: SETTING_KEYS.bankTransferDetails, value }, update: { value } });
      await this.audit.log({ staffId, action: 'settings.bank_transfer_updated', entityType: 'settings', before: before?.value, after: value }, tx);
    });
    return this.bankTransfer();
  }

  async tariffs() {
    const rows = await this.prisma.delivery_tariffs.findMany({ include: { region: true, city: true }, orderBy: [{ region: { name_ru: 'asc' } }] });
    return rows.map((t) => ({
      id: t.id,
      region: { id: t.region.id, name_ru: t.region.name_ru },
      city: t.city ? { id: t.city.id, name_ru: t.city.name_ru } : null,
      tariff_uzs: Number(t.tariff_uzs),
      free_shipping_threshold_uzs: Number(t.free_shipping_threshold_uzs),
      status: t.status,
      min_days: t.min_days,
      max_days: t.max_days,
      note_ru: t.note_ru,
      note_uz: t.note_uz,
      is_test: t.is_test,
    }));
  }

  async createTariff(staffId: string, dto: TariffDto) {
    await this.prisma.$transaction(async (tx) => {
      await this.validateTariff(tx, dto.region_id, dto.city_id ?? null, dto.status ?? 'active', undefined, { min: dto.min_days ?? null, max: dto.max_days ?? null });
      const t = await tx.delivery_tariffs.create({ data: this.tariffData(dto) as Prisma.delivery_tariffsUncheckedCreateInput });
      await this.audit.log({ staffId, action: 'tariff.created', entityType: 'delivery_tariff', entityId: t.id, after: t }, tx);
    });
    return this.tariffs();
  }

  async updateTariff(staffId: string, id: string, dto: TariffPatch) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.delivery_tariffs.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Tariff not found');
      const regionId = dto.region_id ?? before.region_id;
      const cityId = dto.city_id === undefined ? before.city_id : dto.city_id;
      await this.validateTariff(tx, regionId, cityId, dto.status ?? before.status, id, {
        min: dto.min_days === undefined ? before.min_days : dto.min_days,
        max: dto.max_days === undefined ? before.max_days : dto.max_days,
      });
      const after = await tx.delivery_tariffs.update({ where: { id }, data: this.tariffData(dto) });
      await this.audit.log({ staffId, action: 'tariff.updated', entityType: 'delivery_tariff', entityId: id, before, after }, tx);
    });
    return this.tariffs();
  }

  async staffList() {
    const rows = await this.prisma.staff_users.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { sessions: { where: { revoked_at: null, expires_at: { gt: new Date() } } } } } },
    });
    return rows.map((s) => ({
      id: s.id,
      telegram_user_id: Number(s.telegram_user_id),
      name: s.name,
      role: s.role,
      status: s.status,
      is_specialist: s.is_specialist,
      active_sessions: s._count.sessions,
      created_at: s.created_at,
    }));
  }

  async createStaff(staffId: string, dto: StaffUserDto) {
    try {
      const s = await this.prisma.staff_users.create({ data: { telegram_user_id: BigInt(dto.telegram_user_id), name: dto.name, role: dto.role } });
      await this.audit.log({ staffId, action: 'staff.created', entityType: 'staff_user', entityId: s.id, after: s });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'STAFF_EXISTS', message: 'An employee with this Telegram ID already exists' });
      }
      throw e;
    }
    return this.staffList();
  }

  /** An admin cannot demote or block themselves (otherwise nobody may be left to manage staff). */
  async updateStaff(me: StaffContext, id: string, dto: StaffUserPatch) {
    if (id === me.staff.id && ((dto.role && dto.role !== me.staff.role) || dto.status === 'blocked')) {
      throw new ConflictException({ code: 'CANNOT_CHANGE_SELF', message: 'You cannot change your own role or block yourself' });
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.staff_users.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Employee not found');
      const after = await tx.staff_users.update({ where: { id }, data: dto });
      // Blocking or a role change signs the employee out, so new rights apply at once.
      if (dto.status === 'blocked' || (dto.role && dto.role !== before.role)) {
        await tx.staff_sessions.updateMany({ where: { staff_user_id: id, revoked_at: null }, data: { revoked_at: new Date() } });
      }
      await this.audit.log({ staffId: me.staff.id, action: 'staff.updated', entityType: 'staff_user', entityId: id, before, after }, tx);
    });
    return this.staffList();
  }

  async revokeSessions(staffId: string, id: string) {
    const exists = await this.prisma.staff_users.count({ where: { id } });
    if (!exists) throw new NotFoundException('Employee not found');
    const revoked = await this.staffAuth.revokeAll(id);
    await this.audit.log({ staffId, action: 'staff.sessions_revoked', entityType: 'staff_user', entityId: id, after: { revoked } });
    return { revoked };
  }

  async auditLog(q: AuditQuery) {
    const where: Prisma.audit_logsWhereInput = {
      ...(q.entity_type && { entity_type: q.entity_type }),
      ...(q.entity_id && { entity_id: q.entity_id }),
      ...(q.staff_id && { staff_user_id: q.staff_id }),
      ...(q.action && { action: { startsWith: q.action } }),
      ...((q.date_from || q.date_to) && {
        created_at: {
          ...(q.date_from && { gte: new Date(`${q.date_from}T00:00:00+05:00`) }),
          ...(q.date_to && { lt: new Date(new Date(`${q.date_to}T00:00:00+05:00`).getTime() + 86_400_000) }),
        },
      }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.audit_logs.count({ where }),
      this.prisma.audit_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (q.page - 1) * 50,
        take: 50,
        include: { staff: { select: { name: true, role: true } } },
      }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        staff: r.staff ? { id: r.staff_user_id, name: r.staff.name, role: r.staff.role } : null,
        action: r.action,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        before: r.before_json,
        after: r.after_json,
      })),
      page: q.page,
      page_size: 50,
      total,
      total_pages: Math.ceil(total / 50),
    };
  }

  private tariffData(dto: TariffPatch): Prisma.delivery_tariffsUncheckedUpdateInput {
    return {
      ...(dto.region_id && { region_id: dto.region_id }),
      ...(dto.city_id !== undefined && { city_id: dto.city_id }),
      ...(dto.tariff_uzs !== undefined && { tariff_uzs: BigInt(dto.tariff_uzs) }),
      ...(dto.free_shipping_threshold_uzs !== undefined && { free_shipping_threshold_uzs: BigInt(dto.free_shipping_threshold_uzs) }),
      ...(dto.status && { status: dto.status }),
      ...(dto.min_days !== undefined && { min_days: dto.min_days }),
      ...(dto.max_days !== undefined && { max_days: dto.max_days }),
      ...(dto.note_ru !== undefined && { note_ru: dto.note_ru }),
      ...(dto.note_uz !== undefined && { note_uz: dto.note_uz }),
      ...(dto.is_test !== undefined && { is_test: dto.is_test }),
    };
  }

  /** City must be in the region; only one active tariff per region (default) or per city. */
  private async validateTariff(tx: Prisma.TransactionClient, regionId: string, cityId: string | null, status: TariffStatus, exceptId?: string, days?: { min?: number | null; max?: number | null }) {
    if (days && days.min != null && days.max != null && days.min > days.max) {
      throw new ConflictException({ code: 'INVALID_DAYS', message: 'min_days must not be greater than max_days' });
    }
    if (days && (days.min == null) !== (days.max == null)) {
      throw new ConflictException({ code: 'INVALID_DAYS', message: 'Set both min_days and max_days, or neither' });
    }
    if (cityId) await this.delivery.assertCityInRegion(regionId, cityId, tx);
    else if (!(await tx.regions.count({ where: { id: regionId } }))) {
      throw new ConflictException({ code: 'INVALID_ADDRESS', message: 'Unknown region' });
    }
    if (status !== 'active') return;
    const clash = await tx.delivery_tariffs.count({
      where: { region_id: regionId, city_id: cityId, status: 'active', ...(exceptId && { id: { not: exceptId } }) },
    });
    if (clash) throw new ConflictException({ code: 'TARIFF_EXISTS', message: 'An active tariff for this region/city already exists' });
  }
}

// ---------------- controllers ----------------

@ApiTags('staff: settings')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@RequirePermission('settings.manage')
@Controller('staff/settings')
export class AdminSettingsController {
  constructor(private readonly settings: AdminSettingsService) {}

  @Get('bank-transfer')
  bankTransfer() {
    return this.settings.bankTransfer();
  }

  @Put('bank-transfer')
  setBankTransfer(@CurrentStaff() me: StaffContext, @Body() dto: BankTransferDto) {
    return this.settings.setBankTransfer(me.staff.id, dto);
  }

  @Get('card-transfer')
  cardTransfer() {
    return this.settings.cardTransfer();
  }

  @Put('card-transfer')
  setCardTransfer(@CurrentStaff() me: StaffContext, @Body() dto: CardTransferDto) {
    return this.settings.setCardTransfer(me.staff.id, dto);
  }

  @Get('payment-methods')
  paymentTimeouts() {
    return this.settings.paymentTimeouts();
  }

  @Put('payment-methods/:code')
  setPaymentTimeout(@CurrentStaff() me: StaffContext, @Param('code') code: string, @Body() dto: PaymentTimeoutDto) {
    return this.settings.setPaymentTimeout(me.staff.id, code, dto);
  }

  @Get('texts')
  texts() {
    return this.settings.shopTexts();
  }

  @Put('texts')
  setTexts(@CurrentStaff() me: StaffContext, @Body() dto: ShopTextsDto) {
    return this.settings.setShopTexts(me.staff.id, dto);
  }

  @Get('contacts')
  contacts() {
    return this.settings.shopContacts();
  }

  @Put('contacts')
  setContacts(@CurrentStaff() me: StaffContext, @Body() dto: ShopContactsDto) {
    return this.settings.setShopContacts(me.staff.id, dto);
  }

  @Get('home')
  home() {
    return this.settings.homeContent();
  }

  @Put('home')
  setHome(@CurrentStaff() me: StaffContext, @Body() dto: HomeContentDto) {
    return this.settings.setHomeContent(me.staff.id, dto);
  }

  @Get('manifest')
  manifest() {
    return this.settings.manifest();
  }

  @Put('manifest')
  setManifest(@CurrentStaff() me: StaffContext, @Body() dto: ManifestDto) {
    return this.settings.setManifest(me.staff.id, dto);
  }

  @Get('bonus-teaser')
  bonusTeaser() {
    return this.settings.bonusTeaser();
  }

  @Put('bonus-teaser')
  setBonusTeaser(@CurrentStaff() me: StaffContext, @Body() dto: BonusTeaserDto) {
    return this.settings.setBonusTeaser(me.staff.id, dto);
  }

  @Get('cart-upsell')
  cartUpsell() {
    return this.settings.cartUpsell();
  }

  @Put('cart-upsell')
  setCartUpsell(@CurrentStaff() me: StaffContext, @Body() dto: CartUpsellDto) {
    return this.settings.setCartUpsell(me.staff.id, dto);
  }

  @Get('label-size')
  labelSize() {
    return this.settings.labelSize();
  }

  @Put('label-size')
  setLabelSize(@CurrentStaff() me: StaffContext, @Body() dto: LabelSizeDto) {
    return this.settings.setLabelSize(me.staff.id, dto);
  }

  @Get('checkout-options')
  checkoutOptions() {
    return this.settings.checkoutOptions();
  }

  @Put('checkout-options')
  setCheckoutOptions(@CurrentStaff() me: StaffContext, @Body() dto: CheckoutOptionsDto) {
    return this.settings.setCheckoutOptions(me.staff.id, dto);
  }

  @Get('regions')
  regions() {
    return this.settings.regions();
  }

  @Post('cities')
  createCity(@CurrentStaff() me: StaffContext, @Body() dto: CityDto) {
    return this.settings.createCity(me.staff.id, dto);
  }

  @Patch('cities/:id')
  updateCity(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CityPatch) {
    return this.settings.updateCity(me.staff.id, id, dto);
  }

  @Get('tariffs')
  tariffs() {
    return this.settings.tariffs();
  }

  @Post('tariffs')
  createTariff(@CurrentStaff() me: StaffContext, @Body() dto: TariffDto) {
    return this.settings.createTariff(me.staff.id, dto);
  }

  @Patch('tariffs/:id')
  updateTariff(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: TariffPatch) {
    return this.settings.updateTariff(me.staff.id, id, dto);
  }
}

@ApiTags('staff: employees')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@RequirePermission('staff.manage')
@Controller('staff/users')
export class StaffUsersController {
  constructor(private readonly settings: AdminSettingsService) {}

  @Get()
  list() {
    return this.settings.staffList();
  }

  @Post()
  create(@CurrentStaff() me: StaffContext, @Body() dto: StaffUserDto) {
    return this.settings.createStaff(me.staff.id, dto);
  }

  @Patch(':id')
  update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: StaffUserPatch) {
    return this.settings.updateStaff(me, id, dto);
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  revoke(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.settings.revokeSessions(me.staff.id, id);
  }
}

@ApiTags('staff: audit')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/audit')
export class AuditController {
  constructor(private readonly settings: AdminSettingsService) {}

  @Get()
  @RequirePermission('audit.view')
  list(@Query() q: AuditQuery) {
    return this.settings.auditLog(q);
  }
}
