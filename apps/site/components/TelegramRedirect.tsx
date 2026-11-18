'use client';

import { useEffect } from 'react';
import { miniAppPath } from '@/lib/paths';

/**
 * Release 6.6: the Mini App moved to app.vitalo.uz. A Telegram button made before the move still opens vitalo.uz —
 * Telegram adds #tgWebAppData=… to the address; such a visit goes on to the same screen of the Mini App.
 */
export function TelegramRedirect({ appUrl }: { appUrl: string | null }) {
  useEffect(() => {
    if (!appUrl || !/tgWebApp(Data|Platform)=/.test(window.location.hash)) return;
    let app: URL;
    try {
      app = new URL(appUrl);
    } catch {
      return;
    }
    if (app.host === window.location.host) return;
    window.location.replace(app.origin + miniAppPath(window.location.pathname, window.location.search) + window.location.hash);
  }, [appUrl]);
  return null;
}
