import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { ROLE } from '../lib/format';
import { navFor } from '../lib/nav';
import { CloseIcon, MenuIcon } from './Icons';
import { Logo } from './Logo';

/**
 * Admin frame. The menu scrolls on its own (low screens, admin inside Telegram), and on narrow screens
 * (≤ 900 px) it is a panel that slides in from the left by the «Меню» button.
 */
export function Layout() {
  const { staff, permissions, logout } = useSession();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  // Going to another section closes the panel on a phone.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className={open ? 'shell nav-open' : 'shell'}>
      <header className="topbar">
        <button
          type="button"
          className="btn btn-ghost topbar-menu"
          aria-label="Открыть меню"
          aria-expanded={open}
          aria-controls="admin-sidebar"
          onClick={() => setOpen(true)}
        >
          <MenuIcon size={22} /> Меню
        </button>
        <Logo />
      </header>
      <div className="sidebar-backdrop" aria-hidden onClick={() => setOpen(false)} />
      <aside className="sidebar" id="admin-sidebar">
        <div className="brand">
          <Logo /> <span>admin</span>
          <button
            type="button"
            className="btn btn-ghost btn-icon sidebar-close"
            aria-label="Закрыть меню"
            onClick={() => setOpen(false)}
          >
            <CloseIcon size={20} />
          </button>
        </div>
        <nav aria-label="Разделы админки">
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
