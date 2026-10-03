import { useI18n } from '../lib/i18n';
import { useShopTexts } from '../lib/queries';
import { openSupport } from '../lib/shop';
import { SupportIcon } from './Icons';

/** Support chat from Настройки (default @VITALO_support). */
export const DEFAULT_SUPPORT_URL = 'https://t.me/VITALO_support';

export function useSupportUrl(): string {
  return useShopTexts().data?.support_url ?? DEFAULT_SUPPORT_URL;
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
