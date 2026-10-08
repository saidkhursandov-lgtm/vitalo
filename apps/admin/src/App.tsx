import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { NoAccess } from './components/ui';
import { useSession, type Permission } from './lib/auth';
import { homeFor } from './lib/nav';
import { Audit } from './pages/Audit';
import { CustomerDetail, Customers } from './pages/Customers';
import { Dashboard } from './pages/Dashboard';
import { Inventory } from './pages/Inventory';
import { OrderDetail } from './pages/OrderDetail';
import { Orders } from './pages/Orders';
import { ProductEdit } from './pages/ProductEdit';
import { Products } from './pages/Products';
import { PurchaseDetail, PurchaseNew, Purchases } from './pages/Purchases';
import { Settings } from './pages/Settings';

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
        <Route path="products" element={<Guard perm="products.view"><Products /></Guard>} />
        <Route path="products/new" element={<Guard perm="products.edit"><ProductEdit /></Guard>} />
        <Route path="products/:id" element={<Guard perm="products.view"><ProductEdit /></Guard>} />
        <Route path="inventory" element={<Guard perm="inventory.view"><Inventory /></Guard>} />
        <Route path="purchases" element={<Guard perm="purchases.view"><Purchases /></Guard>} />
        <Route path="purchases/new" element={<Guard perm="purchases.manage"><PurchaseNew /></Guard>} />
        <Route path="purchases/:id" element={<Guard perm="purchases.view"><PurchaseDetail /></Guard>} />
        <Route path="customers" element={<Guard perm="customers.view"><Customers /></Guard>} />
        <Route path="customers/:id" element={<Guard perm="customers.view"><CustomerDetail /></Guard>} />
        <Route path="settings" element={<Guard perm="settings.manage"><Settings /></Guard>} />
        <Route path="audit" element={<Guard perm="audit.view"><Audit /></Guard>} />
        <Route path="*" element={<NoAccess />} />
      </Route>
    </Routes>
  );
}
