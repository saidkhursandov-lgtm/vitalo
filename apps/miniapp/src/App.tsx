import { useEffect, type ReactNode } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { trackAppOpen } from './lib/analytics';
import { Layout } from './components/Layout';
import { ConfirmProvider } from './components/Confirm';
import { BrandBlock, LangSwitch } from './components/HeaderParts';
import { BackIcon } from './components/Icons';
import { Logo } from './components/Logo';
import { Empty, ErrorState } from './components/ui';
import { useLegalStatus } from './lib/queries';
import { useAuthed } from './lib/auth';
import { Login } from './screens/Login';
import { LegalDocument, Welcome } from './screens/Legal';
import { useI18n } from './lib/i18n';
import { AddressEdit, Addresses } from './screens/Addresses';
import { Cart } from './screens/Cart';
import { BrandScreen, Catalog, ProductList } from './screens/Catalog';
import { CampaignScreen } from './screens/Campaign';
import { BundleScreen } from './screens/Bundle';
import { Checkout } from './screens/Checkout';
import { Favorites } from './screens/Favorites';
import { Home } from './screens/Home';
import { OrderDetail, Orders } from './screens/Orders';
import { Notifications } from './screens/Notifications';
import { Payment } from './screens/Payment';
import { PaymePayment } from './screens/PaymePayment';
import { ReviewScreen } from './screens/Review';
import { ReturnScreen } from './screens/Return';
import { SupportList, SupportThreadScreen } from './screens/Support';
import { Product } from './screens/Product';
import { Profile } from './screens/Profile';
import { BonusScreen } from './screens/Bonus';
import { Search } from './screens/Search';

function NotFound() {
  const { t } = useI18n();
  return <Empty>{t('common.error')}</Empty>;
}

/** Until the current offer and privacy policy are accepted, only the welcome screen and the documents are open. */
export function App() {
  const authed = useAuthed();
  // Release 6: a guest on the website browses the shop; the documents are accepted after signing in
  if (!authed)
    return (
      <ConfirmProvider>
        <Shop />
      </ConfirmProvider>
    );
  return <SignedInApp />;
}

function SignedInApp() {
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

/** Release 6: the cart, orders and the profile need an account; a guest sees the login form in their place. */
function RequireLogin({ children }: { children: ReactNode }) {
  return useAuthed() ? children : <Login embedded />;
}

function Shop() {
  const authed = useAuthed();
  useEffect(() => {
    if (authed) trackAppOpen();
  }, [authed]);
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="login" element={<Login />} />
        <Route path="search" element={<Search />} />
        <Route path="catalog" element={<Catalog />} />
        <Route path="catalog/products" element={<ProductList />} />
        <Route path="brand/:slug" element={<BrandScreen />} />
        <Route path="campaign/:slug" element={<CampaignScreen />} />
        <Route path="set/:slug" element={<BundleScreen />} />
        <Route path="product/:id" element={<Product />} />
        <Route path="favorites" element={<RequireLogin><Favorites /></RequireLogin>} />
        <Route path="cart" element={<RequireLogin><Cart /></RequireLogin>} />
        <Route path="checkout" element={<RequireLogin><Checkout /></RequireLogin>} />
        <Route path="orders" element={<RequireLogin><Orders /></RequireLogin>} />
        <Route path="orders/:id" element={<RequireLogin><OrderDetail /></RequireLogin>} />
        <Route path="orders/:id/pay" element={<RequireLogin><Payment /></RequireLogin>} />
        <Route path="orders/:id/payme" element={<RequireLogin><PaymePayment /></RequireLogin>} />
        <Route path="review/:orderId" element={<RequireLogin><ReviewScreen /></RequireLogin>} />
        <Route path="orders/:id/return" element={<RequireLogin><ReturnScreen /></RequireLogin>} />
        <Route path="notifications" element={<RequireLogin><Notifications /></RequireLogin>} />
        <Route path="support" element={<RequireLogin><SupportList /></RequireLogin>} />
        <Route path="support/:id" element={<RequireLogin><SupportThreadScreen /></RequireLogin>} />
        <Route path="profile" element={<RequireLogin><Profile /></RequireLogin>} />
        <Route path="bonus" element={<RequireLogin><BonusScreen /></RequireLogin>} />
        <Route path="profile/addresses" element={<RequireLogin><Addresses /></RequireLogin>} />
        <Route path="profile/addresses/:id" element={<RequireLogin><AddressEdit /></RequireLogin>} />
        <Route path="legal/:code" element={<LegalDocument />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
