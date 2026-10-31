import { useI18n } from '../lib/i18n';
import { useShopTexts } from '../lib/queries';
import { copyText, openSupport } from '../lib/shop';
import { telegram } from '../lib/telegram';
import { SupportIcon } from './Icons';
import { useToast } from './Toast';

/** Support chat from Настройки (default @VITALO_support). */
export const DEFAULT_SUPPORT_URL = 'https://t.me/VITALO_support';

export function useSupportUrl(): string {
  return useShopTexts().data?.support_url ?? DEFAULT_SUPPORT_URL;
}

/** Telegram fills the chat box from ?text= for public usernames; just in case, the text is also copied. */
export function supportLinkWithText(url: string, text: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}text=${encodeURIComponent(text)}`;
}

/** Time to read «Текст скопирован…» before Telegram opens the chat and folds the Mini App. */
export const ASK_OPEN_DELAY_MS = 900;

/**
 * «Спросить специалиста» (product card, manifest, «Подбор»): copies the ready text, shows the hint, then opens the support
 * chat with the same text in ?text=. Inside Telegram the chat opens a moment later, so the hint is seen before the Mini
 * App folds; in a browser at once (a delayed window.open would be blocked).
 */
export function useAskSpecialist() {
  const { t } = useI18n();
  const url = useSupportUrl();
  const toast = useToast();
  return (text: string) => {
    void copyText(text).then((ok) => ok && toast(t('card.askCopied')));
    const open = () => openSupport(supportLinkWithText(url, text));
    if (telegram()) setTimeout(open, ASK_OPEN_DELAY_MS);
    else open();
  };
}

export function SupportButton({ className = 'btn btn-secondary btn-block' }: { className?: string }) {
  const { t } = useI18n();
  const url = useSupportUrl();
  return (
    <button type="button" className={className} onClick={() => openSupport(url)}>
      <SupportIcon width={20} height={20} /> {t('support.button')}
    </button>
  );
}
