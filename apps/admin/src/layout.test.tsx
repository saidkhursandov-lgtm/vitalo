import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/auth', () => ({
  useSession: () => ({
    staff: { name: 'Админ (тест)', role: 'admin' },
    permissions: ['dashboard.view', 'orders.view', 'settings.manage', 'audit.view'],
    logout: vi.fn(),
  }),
}));

import { Layout } from './components/Layout';

afterEach(cleanup);

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<p>Дашборд</p>} />
          <Route path="/audit" element={<p>Журнал</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('admin menu (low screens and phones)', () => {
  it('the list of sections scrolls on its own, the sidebar is one screen high', () => {
    const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.sidebar nav \{[^}]*overflow-y: auto/);
    expect(css).toMatch(/\.sidebar nav \{[^}]*min-height: 0/);
    expect(css).toMatch(/\.sidebar \{[^}]*height: 100dvh/);
    expect(css).toMatch(/@media \(max-width: 900px\)/);
  });

  it('«Меню» opens the panel; choosing a section closes it', () => {
    const { container } = renderLayout();
    const shell = container.querySelector('.shell')!;
    expect(shell.classList.contains('nav-open')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Открыть меню' }));
    expect(shell.classList.contains('nav-open')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Система' })); // generalplan stage 2: groups fold
    fireEvent.click(screen.getByRole('link', { name: 'Журнал аудита' }));
    expect(shell.classList.contains('nav-open')).toBe(false);
    expect(screen.getByText('Журнал')).toBeTruthy();
  });

  it('Escape and the close button close the panel', () => {
    const { container } = renderLayout();
    const shell = container.querySelector('.shell')!;
    fireEvent.click(screen.getByRole('button', { name: 'Открыть меню' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(shell.classList.contains('nav-open')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Открыть меню' }));
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть меню' }));
    expect(shell.classList.contains('nav-open')).toBe(false);
  });
});

describe('menu groups (генплан, этап 2)', () => {
  it('a group folds and unfolds; the group of the open page is unfolded', () => {
    render(
      <MemoryRouter initialEntries={['/audit']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/audit" element={<p>Журнал</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const system = screen.getByRole('button', { name: 'Система' });
    expect(system.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: 'Журнал аудита' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('link', { name: 'Заказы' })).toBeNull(); // «Продажи» folded
    fireEvent.click(screen.getByRole('button', { name: 'Продажи' }));
    expect(screen.getByRole('link', { name: 'Заказы' })).toBeTruthy();
    fireEvent.click(system);
    expect(screen.queryByRole('link', { name: 'Журнал аудита' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Дашборд' })).toBeTruthy(); // a group of one is a plain link
  });
});
