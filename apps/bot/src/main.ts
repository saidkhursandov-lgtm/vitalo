import { HttpVitaloApi } from './api-client';
import { commandsFor, createBot } from './bot';
import { currentUrl, loadConfig } from './config';
import { setMenuButton } from './menu-button';

/** Long polling bot. Start: npm run dev (apps/bot). The token comes from apps/api/.env and is never printed. */
async function main() {
  const cfg = loadConfig();
  const bot = createBot({
    token: cfg.token,
    api: new HttpVitaloApi(cfg.apiUrl, cfg.botApiSecret),
    urls: { miniApp: () => currentUrl('miniapp'), admin: () => currentUrl('admin') },
  });

  // Errors are logged by type and description only (grammY errors never contain the token).
  bot.catch((err) => {
    const e = err.error as Error;
    console.error(`[bot] update ${err.ctx.update.update_id} failed: ${e?.name ?? 'Error'}: ${e?.message ?? e}`);
  });

  await bot.api.setMyCommands(commandsFor('ru'));
  await bot.api.setMyCommands(commandsFor('uz'), { language_code: 'uz' });
  const miniApp = currentUrl('miniapp');
  if (miniApp) await setMenuButton(bot.api, miniApp);

  const stop = () => void bot.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await bot.start({
    onStart: (me) =>
      console.log(`[bot] @${me.username} is running. Mini App: ${miniApp ?? 'not set yet (start the tunnel)'}. Stop: Ctrl+C or stop.bat`),
  });
}

main().catch((e: Error) => {
  console.error(`[bot] cannot start: ${e.name}: ${e.message}`);
  process.exitCode = 1;
});
