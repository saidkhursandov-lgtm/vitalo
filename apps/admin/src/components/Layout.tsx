import { NavLink, Outlet } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { ROLE } from '../lib/format';
import { navFor } from '../lib/nav';
import { Logo } from './Logo';

export function Layout() {
  const { staff, permissions, logout } = useSession();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo /> <span>admin</span>
        </div>
        <nav>
          {navFor(permissions).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="me">
          <div className="me-name">{staff.name}</div>
          <div className="muted small">{ROLE[staff.role]}</div>
          <button className="btn btn-sm btn-ghost" onClick={() => void logout()}>
            Выйти
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
