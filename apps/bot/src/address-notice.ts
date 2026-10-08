import { InlineKeyboard, type Api } from 'grammy';

/**
 * Dev tunnel: when the quick-tunnel addresses change (after stop.bat / a reboot), every active admin and manager
 * gets one message «Новые адреса VITALO» with fresh buttons, so nobody has to find a working button by hand.
 * Customers never get it. The same addresses are never announced twice: the last announced pair is kept in
 * .runtime/notified-urls.json.
 */
export interface TunnelUrls {
  miniapp: string | null;
  admin: string | null;
}

export interface Recipient {
  telegram_id: string;
  role: string;
}

/** Roles that open the admin panel and get the notice. Anything else (customers included) is dropped. */
export const NOTICE_ROLES = ['admin', 'manager'] as const;

export const NOTICE_TITLE = 'Новые адреса VITALO';

/** True when there is something to announce: a Mini App address, and it or the admin address differs from the last notice. */
export function urlsChanged(last: TunnelUrls | null, current: TunnelUrls): boolean {
  if (!current.miniapp) return false;
  return !last || last.miniapp !== current.miniapp || last.admin !== current.admin;
}

/** Only admins and managers with a numeric Telegram id, each once. */
export function pickRecipients(list: Recipient[]): string[] {
  const ids = list
    .filter((r) => (NOTICE_ROLES as readonly string[]).includes(r.role) && /^\d{1,20}$/.test(r.telegram_id))
    .map((r) => r.telegram_id);
  return [...new Set(ids)];
}

export function noticeText(urls: TunnelUrls): string {
  return [
    `🔄 ${NOTICE_TITLE}`,
    '',
    'Туннель перезапущен, адреса сменились. Старые кнопки в чате больше не работают — пользуйтесь кнопками под этим сообщением.',
    '',
    ...(urls.admin ? [`Админка: ${urls.admin}`] : []),
    `Магазин: ${urls.miniapp}`,
  ].join('\n');
}

export function noticeKeyboard(urls: TunnelUrls): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (urls.admin) kb.webApp('Открыть админку', `${urls.admin}/`).row();
  if (urls.miniapp) kb.webApp('Открыть магазин', `${urls.miniapp}/`);
  return kb;
}

export interface NoticeDeps {
  api: Pick<Api, 'sendMessage'>;
  /** Active admins and managers from the VITALO API (GET /internal/bot/staff-notify). */
  recipients: () => Promise<Recipient[]>;
  readLast: () => TunnelUrls | null;
  writeLast: (urls: TunnelUrls) => void;
  log: (line: string) => void;
  /** The API may still be starting together with the tunnel: tries and the pause between them. */
  tries?: number;
  waitMs?: number;
}

/** Sends the notice if the addresses changed. Never throws: failures go to the log. */
export async function notifyNewAddresses(current: TunnelUrls, deps: NoticeDeps): Promise<void> {
  const { log, tries = 12, waitMs = 10_000 } = deps;
  let last: TunnelUrls | null = null;
  try {
    last = deps.readLast();
  } catch {
    /* unreadable file: treat as never announced */
  }
  if (!urlsChanged(last, current)) {
    log('[tunnel] Адреса не изменились — сообщение сотрудникам не отправляется.');
    return;
  }

  let ids: string[] | null = null;
  for (let i = 1; i <= tries && !ids; i++) {
    try {
      ids = pickRecipients(await deps.recipients());
    } catch (e) {
      if (i === tries) log(`[tunnel] Не удалось получить список сотрудников из API (${(e as Error).message}). Сообщение «${NOTICE_TITLE}» не отправлено.`);
      else await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  if (!ids) return; // nothing was sent: the next address change will try again

  let sent = 0;
  for (const id of ids) {
    try {
      await deps.api.sendMessage(id, noticeText(current), { reply_markup: noticeKeyboard(current), link_preview_options: { is_disabled: true } });
      sent++;
    } catch (e) {
      // Telegram refuses users who never wrote to the bot (or blocked it): logged, not fatal.
      log(`[tunnel] Не удалось отправить «${NOTICE_TITLE}» сотруднику ${id}: ${(e as Error).message}`);
    }
  }
  try {
    deps.writeLast(current);
  } catch (e) {
    log(`[tunnel] Не удалось сохранить отправленные адреса: ${(e as Error).message}`);
  }
  log(`[tunnel] «${NOTICE_TITLE}» отправлено: ${sent} из ${ids.length} (администраторы и менеджеры).`);
}
