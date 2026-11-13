import { lazy, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { NoAccess } from './components/ui';
import { useSession, type Permission } from './lib/auth';
import { homeFor } from './lib/nav';
import { Dashboard } from './pages/Dashboard';

/**
 * Аудит админки 2.16: pages load on first opening (their own JS chunk), so the first screen does not wait for the
 * whole panel. Only the dashboard stays in the main chunk — the first screen of most employees.
 */
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
const Orders = page(() => import('./pages/Orders'), 'Orders');
const Analytics = page(() => import('./pages/Analytics'), 'Analytics');
const Audit = page(() => import('./pages/Audit'), 'Audit');
const CustomerDetail = page(() => import('./pages/Customers'), 'CustomerDetail');
const Customers = page(() => import('./pages/Customers'), 'Customers');
const Waitlist = page(() => import('./pages/Waitlist'), 'Waitlist');
const WaitlistProductPage = page(() => import('./pages/Waitlist'), 'WaitlistProductPage');
const Iherb = page(() => import('./pages/Iherb'), 'Iherb');
const CrossBorder = page(() => import('./pages/CrossBorder'), 'CrossBorder');
const CrossBorderBatch = page(() => import('./pages/CrossBorder'), 'CrossBorderBatch');
const AiAnalyst = page(() => import('./pages/AiAnalyst'), 'AiAnalyst');
const Promo = page(() => import('./pages/Promo'), 'Promo');
const PromoCodes = page(() => import('./pages/PromoCodes'), 'PromoCodes');
const Storefront = page(() => import('./pages/Storefront'), 'Storefront');
const Campaigns = page(() => import('./pages/Campaigns'), 'Campaigns');
const Compat = page(() => import('./pages/Compat'), 'Compat');
const AiChats = page(() => import('./pages/AiChats'), 'AiChats');
const SupportList = page(() => import('./pages/Support'), 'SupportList');
const Reviews = page(() => import('./pages/Reviews'), 'Reviews');
const Returns = page(() => import('./pages/Returns'), 'Returns');
const SupportThread = page(() => import('./pages/Support'), 'SupportThread');
const Devices = page(() => import('./pages/Devices'), 'Devices');
const Finance = page(() => import('./pages/Finance'), 'Finance');
const Inventory = page(() => import('./pages/Inventory'), 'Inventory');
const OrderDetail = page(() => import('./pages/OrderDetail'), 'OrderDetail');
const ProductEdit = page(() => import('./pages/ProductEdit'), 'ProductEdit');
const Products = page(() => import('./pages/Products'), 'Products');
const Brands = page(() => import('./pages/Brands'), 'Brands');
const PurchaseDetail = page(() => import('./pages/Purchases'), 'PurchaseDetail');
const PurchaseNew = page(() => import('./pages/Purchases'), 'PurchaseNew');
const Purchases = page(() => import('./pages/Purchases'), 'Purchases');
const Settings = page(() => import('./pages/Settings'), 'Settings');
const YandexOrderDetail = page(() => import('./pages/YandexOrders'), 'YandexOrderDetail');
const YandexOrderNew = page(() => import('./pages/YandexOrders'), 'YandexOrderNew');
const YandexOrders = page(() => import('./pages/YandexOrders'), 'YandexOrders');
const YandexSync = page(() => import('./pages/YandexSync'), 'YandexSync');

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
        <Route path="cross-border" element={<Guard perm="cross_border.view"><CrossBorder /></Guard>} />
        <Route path="cross-border/:id" element={<Guard perm="cross_border.view"><CrossBorderBatch /></Guard>} />
        <Route path="ai-analyst" element={<Guard perm="ai_analyst.use"><AiAnalyst /></Guard>} />
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
        <Route path="ai-chats" element={<Guard perm="compat.answer"><AiChats /></Guard>} />
        <Route path="support" element={<Guard perm="support.view"><SupportList /></Guard>} />
        <Route path="reviews" element={<Guard perm="reviews.moderate"><Reviews /></Guard>} />
        <Route path="returns" element={<Guard perm="returns.manage"><Returns /></Guard>} />
        <Route path="support/:id" element={<Guard perm="support.view"><SupportThread /></Guard>} />
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
