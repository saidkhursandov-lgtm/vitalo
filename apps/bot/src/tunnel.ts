import { Api } from 'grammy';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { notifyNewAddresses, type TunnelUrls } from './address-notice';
import { HttpVitaloApi } from './api-client';
import { loadConfig, readNotifiedUrls, saveUrl, writeNotifiedUrls } from './config';
import { setMenuButton } from './menu-button';

/**
 * Dev only: public HTTPS addresses for testing from a phone, via Cloudflare quick tunnels (free, no domain).
 * - Mini App (localhost:5173) -> https://<random>.trycloudflare.com; the bot's menu button is pointed at it.
 * - Admin panel (localhost:5174), if apps/admin exists -> second tunnel; employees open it with /admin in the bot.
 * When cloudflared restarts and the address changes, the menu button and .runtime files are updated again, and
 * admins and managers get «Новые адреса VITALO» with fresh buttons (only when the addresses really changed).
 * Run: npm run tunnel (apps/bot), or start.bat.
 */

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** The quick-tunnel address printed by cloudflared (it is in a log line on stderr). */
export function extractTunnelUrl(line: string): string | null {
  const m = line.match(TUNNEL_URL_RE);
  return m && !m[0].startsWith('https://api.') ? m[0] : null;
}

export function findCloudflared(): string {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\cloudflared.exe`,
  ];
  return candidates.find((p) => p && existsSync(p)) ?? 'cloudflared'; // else rely on PATH
}

function runTunnel(name: string, port: number, onUrl: (url: string) => Promise<void>) {
  const exe = findCloudflared();
  const start = () => {
    console.log(`[tunnel] ${name}: starting cloudflared for http://localhost:${port} ...`);
    const child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
    let announced = false;
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const url = extractTunnelUrl(line);
        if (url && !announced) {
          announced = true;
          onUrl(url).catch((e: Error) => console.error(`[tunnel] ${name}: could not apply ${url}: ${e.message}`));
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      console.error(`[tunnel] cannot run cloudflared (${e.message}). Install it: winget install --id Cloudflare.cloudflared`);
      process.exitCode = 1;
    });
    child.on('exit', (code) => {
      if (process.exitCode === 1) return;
      console.warn(`[tunnel] ${name}: cloudflared exited (code ${code}), restarting in 5 s — the address will change`);
      setTimeout(start, 5_000);
    });
    process.once('exit', () => child.kill());
  };
  start();
}

async function main() {
  const { token, apiUrl, botApiSecret } = loadConfig();
  const api = new Api(token);
  const vitalo = new HttpVitaloApi(apiUrl, botApiSecret);
  const adminDir = fileURLToPath(new URL('../../admin/package.json', import.meta.url));
  const withAdmin = existsSync(adminDir);

  // «Новые адреса VITALO»: once both addresses of this run are known (and again if cloudflared restarts and one
  // changes). Notices run one after another, so two quick changes never send overlapping messages.
  const current: TunnelUrls = { miniapp: null, admin: null };
  let queue = Promise.resolve();
  const announce = () => {
    if (!current.miniapp || (withAdmin && !current.admin)) return;
    const urls = { ...current };
    queue = queue.then(() =>
      notifyNewAddresses(urls, {
        api,
        recipients: async () => (await vitalo.staffNotify()).recipients,
        readLast: readNotifiedUrls,
        writeLast: writeNotifiedUrls,
        log: (line) => console.log(line),
      }),
    );
  };

  runTunnel('Mini App', 5173, async (url) => {
    saveUrl('miniapp', url);
    current.miniapp = url;
    announce(); // even if setting the menu button fails below
    await setMenuButton(api, url);
    console.log(`\n[tunnel] Mini App: ${url}\n[tunnel] Menu button of the bot now opens this address. Open the bot in Telegram and tap "🛍 VITALO".\n`);
  });

  if (withAdmin) {
    runTunnel('Admin', 5174, async (url) => {
      saveUrl('admin', url);
      current.admin = url;
      console.log(`\n[tunnel] Admin panel: ${url}\n[tunnel] Employees: send /admin to the bot to open it inside Telegram.\n`);
      announce();
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: Error) => {
    console.error(`[tunnel] ${e.name}: ${e.message}`);
    process.exitCode = 1;
  });
}
