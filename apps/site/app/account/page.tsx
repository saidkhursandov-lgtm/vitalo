import type { Metadata } from 'next';
import { AccountView } from './AccountView';

export const metadata: Metadata = { title: 'VITALO', robots: { index: false } };

export default function AccountPage() {
  return (
    <div className="page">
      <div className="container">
        <AccountView section="home" />
      </div>
    </div>
  );
}
