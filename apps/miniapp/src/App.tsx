import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Empty } from './components/ui';
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

export function App() {
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
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
