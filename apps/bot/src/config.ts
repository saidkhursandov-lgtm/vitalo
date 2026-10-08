import { config as loadDotenv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Repo root (apps/bot/src -> ../../..). */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** The bot shares apps/api/.env: the token lives only there. */
export const API_ENV_FILE = `${ROOT}apps/api/.env`;
/** Current public URLs written by the dev tunnel (gitignored). */
export const RUNTIME_DIR = `${ROOT}.runtime/`;
export const MINIAPP_URL_FILE = `${RUNTIME_DIR}miniapp-url.txt`;
export const ADMIN_URL_FILE = `${RUNTIME_DIR}admin-url.txt`;
/** The addresses last announced to staff with «Новые адреса VITALO» (so the same pair is never sent twice). */
export const NOTIFIED_URLS_FILE = `${RUNTIME_DIR}notified-urls.json`;

export interface BotConfig {
  token: string;
  apiUrl: string;
  botApiSecret: string;
}

/** Reads apps/api/.env (without overriding real environment variables). Never prints values. */
export function loadConfig(): BotConfig {
  loadDotenv({ path: API_ENV_FILE, quiet: true } as Parameters<typeof loadDotenv>[0]);
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const botApiSecret = process.env.BOT_API_SECRET?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is empty in apps/api/.env');
  if (!botApiSecret) throw new Error('BOT_API_SECRET is empty in apps/api/.env');
  return { token, botApiSecret, apiUrl: (process.env.API_INTERNAL_URL ?? `http://localhost:${process.env.PORT ?? 3000}/api`).replace(/\/$/, '') };
}

/** Only https URLs are accepted by Telegram for Mini App buttons. */
export function httpsOrNull(url: string | undefined | null): string | null {
  const u = url?.trim();
  return u && /^https:\/\/[^\s]+$/.test(u) ? u.replace(/\/$/, '') : null;
}

/** Production: env MINIAPP_URL / ADMIN_URL. Dev: whatever the tunnel wrote last (re-read on every use). */
export function currentUrl(kind: 'miniapp' | 'admin'): string | null {
  const fromEnv = httpsOrNull(kind === 'miniapp' ? process.env.MINIAPP_URL : process.env.ADMIN_URL);
  if (fromEnv) return fromEnv;
  const file = kind === 'miniapp' ? MINIAPP_URL_FILE : ADMIN_URL_FILE;
  return existsSync(file) ? httpsOrNull(readFileSync(file, 'utf8')) : null;
}

export function saveUrl(kind: 'miniapp' | 'admin', url: string) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(kind === 'miniapp' ? MINIAPP_URL_FILE : ADMIN_URL_FILE, `${url}\n`);
}

export function readNotifiedUrls(): { miniapp: string | null; admin: string | null } | null {
  if (!existsSync(NOTIFIED_URLS_FILE)) return null;
  const v = JSON.parse(readFileSync(NOTIFIED_URLS_FILE, 'utf8')) as { miniapp?: unknown; admin?: unknown };
  const str = (x: unknown) => (typeof x === 'string' ? x : null);
  return { miniapp: str(v.miniapp), admin: str(v.admin) };
}

export function writeNotifiedUrls(urls: { miniapp: string | null; admin: string | null }) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(NOTIFIED_URLS_FILE, `${JSON.stringify({ ...urls, notified_at: new Date().toISOString() }, null, 2)}\n`);
}
