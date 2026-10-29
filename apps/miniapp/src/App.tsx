import { useEffect } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { trackAppOpen } from './lib/analytics';
import { Layout } from './components/Layout';
import { ConfirmProvider } from './components/Confirm';
import { BrandBlock, LangSwitch } from './components/HeaderParts';
import { BackIcon } from './components/Icons';
import { Logo } from './components/Logo';
import { Empty, ErrorState } from './components/ui';
import { useLegalStatus } from './lib/queries';
import { LegalDocument, Welcome } from './screens/Legal';
import { useI18n } from './lib/i18n';
import { AddressEdit, Addresses } from './screens/Addresses';
import { Cart } from './screens/Cart';
import { Catalog, ProductList } from './screens/Catalog';
import { Checkout } from './screens/Checkout';
import { Favorites } from './screens/Favorites';
import { Home } from './screens/Home';
import { OrderDetail, Orders } from './screens/Orders';
import { Payment } from './screens/Payment';
import { Product } from './screens/Product';
import { Profile } from './screens/Profile';
import { Search } from './screens/Search';

function NotFound() {
  const { t } = useI18n();
  return <Empty>{t('common.error')}</Empty>;
}

/** Until the current offer and privacy policy are accepted, only the welcome screen and the documents are open. */
export function App() {
  const legal = useLegalStatus();
  if (legal.isPending) return <Splash />;
  if (legal.isError) return <ErrorState error={legal.error} onRetry={() => void legal.refetch()} />;
  if (!legal.data.accepted) {
    return (
      <Routes>
        <Route path="legal/:code" element={<LegalStandalone />} />
        <Route path="*" element={<Welcome />} />
      </Routes>
    );
  }
  return (
    <ConfirmProvider>
      <Shop />
    </ConfirmProvider>
  );
}

function Splash() {
  return (
    <div className="screen-center" role="status" aria-busy="true">
      <Logo size="lg" />
      <span className="skel" style={{ width: 120, height: 6, borderRadius: 3 }} />
    </div>
  );
}

/** Document opened from the welcome screen: no shop navigation yet, just a way back. */
function LegalStandalone() {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn" aria-label={t('common.back')} onClick={() => navigate('/', { replace: true })}>
          <BackIcon />
        </button>
        <BrandBlock logo={<Logo />} />
        <LangSwitch />
      </header>
      <main className="content">
        <LegalDocument />
      </main>
    </div>
  );
}

function Shop() {
  useEffect(() => trackAppOpen(), []);
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="search" element={<Search />} />
        <Route path="catalog" element={<Catalog />} />
        <Route path="catalog/products" element={<ProductList />} />
        <Route path="product/:id" element={<Product />} />
        <Route path="favorites" element={<Favorites />} />
        <Route path="cart" element={<Cart />} />
        <Route path="checkout" element={<Checkout />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="orders/:id/pay" element={<Payment />} />
        <Route path="profile" element={<Profile />} />
        <Route path="profile/addresses" element={<Addresses />} />
        <Route path="profile/addresses/:id" element={<AddressEdit />} />
        <Route path="legal/:code" element={<LegalDocument />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
