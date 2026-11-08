import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { NoAccess } from './components/ui';
import { useSession, type Permission } from './lib/auth';
import { homeFor } from './lib/nav';
import { Analytics } from './pages/Analytics';
import { Audit } from './pages/Audit';
import { CustomerDetail, Customers } from './pages/Customers';
import { Waitlist, WaitlistProductPage } from './pages/Waitlist';
import { Iherb } from './pages/Iherb';
import { Promo } from './pages/Promo';
import { PromoCodes } from './pages/PromoCodes';
import { Storefront } from './pages/Storefront';
import { Campaigns } from './pages/Campaigns';
import { Compat } from './pages/Compat';
import { Dashboard } from './pages/Dashboard';
import { Devices } from './pages/Devices';
import { Finance } from './pages/Finance';
import { Inventory } from './pages/Inventory';
import { OrderDetail } from './pages/OrderDetail';
import { Orders } from './pages/Orders';
import { ProductEdit } from './pages/ProductEdit';
import { Products } from './pages/Products';
import { Brands } from './pages/Brands';
import { PurchaseDetail, PurchaseNew, Purchases } from './pages/Purchases';
import { Settings } from './pages/Settings';
import { YandexOrderDetail, YandexOrderNew, YandexOrders } from './pages/YandexOrders';
import { YandexSync } from './pages/YandexSync';

/** Hides a page from roles without the permission (the API would answer 403 anyway). */
function Guard({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { can } = useSession();
  return can(perm) ? children : <NoAccess />;
}

function Home() {
  const { can, permissions } = useSession();
  return can('dashboard.view') ? <Dashboard /> : <Navigate to={homeFor(permissions)} replace />;
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="orders" element={<Guard perm="orders.view"><Orders /></Guard>} />
        <Route path="orders/:id" element={<Guard perm="orders.view"><OrderDetail /></Guard>} />
        <Route path="yandex-orders" element={<Guard perm="yandex.orders.view"><YandexOrders /></Guard>} />
        <Route path="yandex-orders/new" element={<Guard perm="yandex.orders"><YandexOrderNew /></Guard>} />
        <Route path="yandex-orders/:id" element={<Guard perm="yandex.orders.view"><YandexOrderDetail /></Guard>} />
        <Route path="yandex-sync" element={<Guard perm="yandex.sync"><YandexSync /></Guard>} />
        <Route path="products" element={<Guard perm="products.view"><Products /></Guard>} />
        <Route path="brands" element={<Guard perm="settings.dictionaries"><Brands /></Guard>} />
        <Route path="products/new" element={<Guard perm="products.edit"><ProductEdit /></Guard>} />
        <Route path="products/:id" element={<Guard perm="products.view"><ProductEdit /></Guard>} />
        <Route path="iherb" element={<Guard perm="iherb.prices"><Iherb /></Guard>} />
        <Route path="inventory" element={<Guard perm="inventory.view"><Inventory /></Guard>} />
        <Route path="purchases" element={<Guard perm="purchases.view"><Purchases /></Guard>} />
        <Route path="purchases/new" element={<Guard perm="purchases.manage"><PurchaseNew /></Guard>} />
        <Route path="purchases/:id" element={<Guard perm="purchases.view"><PurchaseDetail /></Guard>} />
        <Route path="customers" element={<Guard perm="customers.view"><Customers /></Guard>} />
        <Route path="customers/:id" element={<Guard perm="customers.view"><CustomerDetail /></Guard>} />
        <Route path="waitlist" element={<Guard perm="customers.view"><Waitlist /></Guard>} />
        <Route path="promo" element={<Guard perm="promo.send"><Promo /></Guard>} />
        <Route path="promo-codes" element={<Guard perm="promo.view"><PromoCodes /></Guard>} />
        <Route path="storefront" element={<Guard perm="marketing.content"><Storefront /></Guard>} />
        <Route path="campaigns" element={<Guard perm="promo.view"><Campaigns /></Guard>} />
        <Route path="compat" element={<Guard perm="compat.view"><Compat /></Guard>} />
        <Route path="waitlist/:productId" element={<Guard perm="customers.view"><WaitlistProductPage /></Guard>} />
        <Route path="analytics" element={<Guard perm="finance.manage"><Analytics /></Guard>} />
        <Route path="finance" element={<Guard perm="finance.manage"><Finance /></Guard>} />
        <Route path="settings" element={<Guard perm="settings.manage"><Settings /></Guard>} />
        <Route path="audit" element={<Guard perm="audit.view"><Audit /></Guard>} />
        <Route path="devices" element={<Devices />} />
        <Route path="*" element={<NoAccess />} />
      </Route>
    </Routes>
  );
}
