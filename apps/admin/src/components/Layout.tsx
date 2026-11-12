import { Suspense, useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { ROLE } from '../lib/format';
import { activeItem, groupsFor, type NavGroup, type NavItem } from '../lib/nav';
import { GlobalSearch } from './GlobalSearch';
import { CloseIcon, MenuIcon, NextIcon } from './Icons';
import { Logo } from './Logo';
import { Loading } from './ui';

/**
 * Admin frame. The menu scrolls on its own (low screens, admin inside Telegram), and on narrow screens
 * (≤ 900 px) it is a panel that slides in from the left by the «Меню» button. Генплан, этап 2: 7 groups that fold;
 * the group of the open section is unfolded.
 */
export function Layout() {
  const { staff, permissions, logout } = useSession();
  const [open, setOpen] = useState(false);
  const { pathname, search } = useLocation();
  const groups = groupsFor(permissions);
  const current = activeItem(groups.flatMap((g) => g.items), pathname, search);
  const currentGroup = groups.find((g) => current && g.items.includes(current))?.id;
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set(currentGroup ? [currentGroup] : []));

  // Going to another section closes the panel on a phone and unfolds that section's group.
  useEffect(() => {
    setOpen(false);
    if (currentGroup) setUnfolded((u) => (u.has(currentGroup) ? u : new Set(u).add(currentGroup)));
  }, [pathname, search, currentGroup]);
  const toggle = (id: string) =>
    setUnfolded((u) => {
      const next = new Set(u);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
        <GlobalSearch className="topbar-search" />
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
        <GlobalSearch className="sidebar-search" hotkey />
        <nav aria-label="Разделы админки">
          {groups.map((g) =>
            g.items.length === 1 && g.items[0].label === g.label ? (
              <Item key={g.id} item={g.items[0]} active={g.items[0] === current} />
            ) : (
              <Group key={g.id} group={g} current={current} open={unfolded.has(g.id)} onToggle={() => toggle(g.id)} />
            ),
          )}
        </nav>
        <div className="me">
          <div className="me-name">{staff.name}</div>
          <div className="muted small">{ROLE[staff.role]}</div>
          <div className="me-actions">
            <Link to="/devices" className="btn btn-sm btn-ghost" aria-current={pathname === '/devices' ? 'page' : undefined}>
              Мои устройства
            </Link>
            <button className="btn btn-sm btn-ghost" onClick={() => void logout()}>
              Выйти
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        {/* аудит 2.16: a page opened for the first time loads its chunk; the menu stays */}
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

function Item({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link to={item.to} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
      {item.label}
    </Link>
  );
}

function Group({ group, current, open, onToggle }: { group: NavGroup; current?: NavItem; open: boolean; onToggle: () => void }) {
  const id = `nav-group-${group.id}`;
  const hasCurrent = !!current && group.items.includes(current);
  return (
    <div className={hasCurrent ? 'nav-group has-current' : 'nav-group'}>
      <button type="button" className="nav-group-head" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <NextIcon size={16} className="nav-group-chevron" aria-hidden />
        {group.label}
      </button>
      {open && (
        <div id={id} className="nav-group-items">
          {group.items.map((i) => (
            <Item key={i.to} item={i} active={i === current} />
          ))}
        </div>
      )}
    </div>
  );
}
