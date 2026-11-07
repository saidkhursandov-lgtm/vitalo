import { useSearchParams } from 'react-router-dom';
import { PageHead } from '../components/ui';
import { BannersSettings } from './settings/Banners';
import { CartUpsellSettings } from './settings/CartUpsell';
import { BonusTeaserForm, HomeSettings } from './settings/Home';
import { ManifestSettings } from './settings/Manifest';

const TABS = { home: 'Главная', cart: 'Корзина' } as const;
type Tab = keyof typeof TABS;

/**
 * D-53 (D-22): «Витрина» — what the customer sees on the home screen and in the cart. Admin and marketer change it
 * without the other settings (payment, delivery, documents stay in «Настройки», admin only).
 */
export function Storefront() {
  const [params, setParams] = useSearchParams();
  const tab = (Object.keys(TABS).includes(params.get('tab') ?? '') ? params.get('tab') : 'home') as Tab;
  return (
    <>
      <PageHead title="Витрина">
        <div className="segmented">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'is-on' : ''} onClick={() => setParams({ tab: t }, { replace: true })}>
              {TABS[t]}
            </button>
          ))}
        </div>
      </PageHead>
      {tab === 'home' && (
        <>
          <BannersSettings />
          <ManifestSettings />
          <HomeSettings />
          <BonusTeaserForm />
        </>
      )}
      {tab === 'cart' && <CartUpsellSettings />}
    </>
  );
}
