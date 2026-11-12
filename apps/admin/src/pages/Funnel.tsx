import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorBox, Loading } from '../components/ui';
import { api } from '../lib/api';

interface FunnelStep {
  event: string;
  users: number;
  conversion_pct: number | null;
}

const STEP_NAMES: Record<string, string> = {
  app_open: 'Открыли магазин',
  product_view: 'Смотрели товар',
  add_to_cart: 'Добавили в корзину',
  checkout_start: 'Начали оформление',
  order_created: 'Создали заказ',
  payment_marked: 'Нажали «Я оплатил(а)»',
  payment_confirmed: 'Оплата подтверждена',
};
/** Single actions outside the funnel (release 1, 2.1). */
interface ExtraEvent {
  event: string;
  users: number;
  events: number;
  by_system?: { system: string; users: number; events: number }[];
}
const EXTRA_NAMES: Record<string, string> = {
  language_change: 'Сменили язык',
  cod_selected: 'Выбрали «Оплата при получении»',
  payment_soon_click: 'Нажали Payme / Click / Uzum «Скоро»',
  manifest_open: 'Открыли «Как VITALO отбирает добавки»',
  ai_tab_click: 'Нажали «AI-подбор» в меню',
  waitlist_subscribe: 'Записались в лист ожидания',
  waitlist_unsubscribe: 'Отключили «Сообщить о поступлении»',
  waitlist_notified: 'Получили «снова в наличии»',
  upsell_shown: 'Увидели допродажу в корзине',
  upsell_add: 'Добавили товар из допродажи',
  receipt_sent: 'Прислали чек в бот',
  receipt_confirmed: 'Оплата подтверждена по чеку',
  receipt_rejected: 'Чек отклонён',
  notification_open: 'Открыли уведомление',
  notification_read_all: 'Нажали «Прочитать все»',
  active_order_click: 'Нажали плашку заказа на главной',
  intake_guide_sent: 'Получили памятку приёма',
  promo_apply_success: 'Применили промокод',
  promo_apply_fail: 'Промокод не подошёл',
  promo_remove: 'Убрали промокод',
  compat_request: 'Отправили запрос совместимости',
  compat_instant_answer: 'Получили сохранённый ответ о совместимости',
  compat_answered: 'Получили ответ специалиста о совместимости',
  compat_view: 'Увидели ответ о совместимости в корзине',
  map_open: 'Открыли карту (выбор адреса)',
  map_locate_me: 'Нажали «Моё местоположение» на карте',
  map_confirm: 'Подтвердили адрес на карте',
  map_district_auto: 'Район после карты (определился сам / нет)',
  // 3.7: sales
  campaign_view: 'Открыли страницу акции',
  campaign_banner_click: 'Нажали на слайд акции',
  campaign_add_to_cart: 'Добавили в корзину товар акции',
  // аудит 10.11, п. 1.12: подписи для событий, которые раньше показывались сырыми ключами
  support_ask_sent: 'Отправили вопрос специалисту',
  home_banner_view: 'Увидели баннер на главной',
  home_banner_click: 'Нажали на баннер на главной',
  ai_consent: 'Согласились на ответы VITALO AI',
  compat_ai_request: 'Спросили VITALO AI о совместимости',
  compat_ai_cached: 'Получили готовый ответ VITALO AI',
  compat_ai_limit: 'Упёрлись в лимит вопросов VITALO AI',
  compat_ai_fallback: 'VITALO AI не ответил — вопрос ушёл специалисту',
  compat_ai_goal: 'Спросили VITALO AI «Поможет ли набор для цели?»',
};
/** Sub-rows: payment systems of «Скоро» and (3.3) reasons a promo code did not fit. */
const SYSTEM_NAMES: Record<string, string> = {
  payme: 'Payme',
  click: 'Click',
  uzum: 'Uzum',
  district_auto: 'район определился сам',
  district_manual: 'район выбрали вручную',
  locate_ok: 'местоположение найдено',
  locate_denied: 'нет разрешения',
  locate_unavailable: 'не удалось определить',
  not_found: 'нет такого кода',
  disabled: 'код выключен',
  not_started: 'ещё не начался',
  expired: 'срок закончился',
  first_order: 'только на первый заказ',
  already_used: 'клиент уже использовал',
  limit_reached: 'лимит исчерпан',
  min_order: 'мала сумма заказа',
  not_applicable: 'не подходит к товарам',
  delivery_free: 'доставка уже бесплатная',
};
/** аудит 2.13: below this many customers on the previous step a percent says nothing. */
export const FUNNEL_MIN_BASE = 20;
/** аудит 2.13: single actions grouped by topic, each group collapsed. */
const EXTRA_GROUPS: [string, (e: string) => boolean][] = [
  ['Оплата', (e) => /^(cod_|payment_|receipt_)/.test(e)],
  ['Адрес и карта', (e) => e.startsWith('map_')],
  ['Промокоды и акции', (e) => /^(promo_|campaign_|upsell_)/.test(e)],
  ['VITALO AI и совместимость', (e) => /^(ai_|compat_)/.test(e)],
  ['Поддержка и уведомления', (e) => /^(support_|notification_|intake_|active_order_)/.test(e)],
];
export function extraGroup(event: string): string {
  return EXTRA_GROUPS.find(([, test]) => test(event))?.[0] ?? 'Прочее';
}
const GROUP_ORDER = [...EXTRA_GROUPS.map(([g]) => g), 'Прочее'];

const PERIODS = [
  ['today', 'Сегодня'],
  ['7', '7 дней'],
  ['30', '30 дней'],
] as const;

/** Funnel for the period: unique customers on each step and the share that came from the previous step (B3). */
export function FunnelCard() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number][0]>('7');
  const q = useQuery({ queryKey: ['funnel', period], queryFn: () => api<{ steps: FunnelStep[]; extra?: ExtraEvent[] }>(`/staff/dashboard/funnel?period=${period}`) });
  const top = Math.max(1, ...(q.data?.steps.map((s) => s.users) ?? [1]));
  return (
    <section className="card">
      <div className="section-head">
        <h2>Воронка за период</h2>
        <div className="segmented">
          {PERIODS.map(([p, label]) => (
            <button key={p} className={period === p ? 'is-on' : ''} onClick={() => setPeriod(p)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">Уникальные покупатели на каждом шаге; процент — сколько дошло с предыдущего шага. Если на предыдущем шаге меньше {FUNNEL_MIN_BASE} человек, процент не показываем: он случайный.</p>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <table className="table funnel">
          <tbody>
            {q.data.steps.map((s, i) => (
              <tr key={s.event}>
                <td>{STEP_NAMES[s.event] ?? s.event}</td>
                <td className="funnel-bar-cell">
                  <span className="funnel-bar" style={{ width: `${(s.users / top) * 100}%` }} />
                </td>
                <td className="num strong">{s.users}</td>
                <td className="num muted">{s.conversion_pct == null ? '' : i > 0 && q.data.steps[i - 1].users < FUNNEL_MIN_BASE ? 'мало данных' : `${s.conversion_pct}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {q.data?.extra && q.data.extra.length > 0 && (
        <>
          <h3 className="funnel-extra-title">Отдельные действия</h3>
          <p className="muted small">Покупатели — сколько разных людей; нажатия — сколько раз всего.</p>
          {GROUP_ORDER.map((g) => [g, q.data.extra!.filter((e) => extraGroup(e.event) === g)] as const)
            .filter(([, list]) => list.length > 0)
            .map(([g, list]) => (
          <details key={g} className="funnel-group">
            <summary>
              {g} <span className="muted small">· действий: {list.length}</span>
            </summary>
          <table className="table">
            <thead>
              <tr>
                <th>Действие</th>
                <th className="num">Покупатели</th>
                <th className="num">Нажатия</th>
              </tr>
            </thead>
            <tbody>
              {list.flatMap((e) => [
                <tr key={e.event}>
                  <td>{EXTRA_NAMES[e.event] ?? e.event}</td>
                  <td className="num strong">{e.users}</td>
                  <td className="num">{e.events}</td>
                </tr>,
                ...(e.by_system ?? []).map((b) => (
                  <tr key={`${e.event}-${b.system}`} className="funnel-sub">
                    <td>— {SYSTEM_NAMES[b.system] ?? b.system}</td>
                    <td className="num">{b.users}</td>
                    <td className="num">{b.events}</td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
          </details>
            ))}
        </>
      )}
    </section>
  );
}
