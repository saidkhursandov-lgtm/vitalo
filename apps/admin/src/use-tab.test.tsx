import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { useTab } from './lib/useTab';

function Page() {
  const [tab] = useTab(['bank', 'staff'] as const, 'bank');
  const loc = useLocation();
  return <p>{`${tab} ${loc.pathname}${loc.search}`}</p>;
}
const at = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Page />
    </MemoryRouter>,
  );

describe('page tabs from ?tab= (аудит 2.9)', () => {
  afterEach(cleanup);
  it('a known tab stays in the address', () => {
    at('/settings?tab=staff');
    expect(screen.getByText('staff /settings?tab=staff')).toBeTruthy();
  });
  it('an unknown tab or the default one is replaced by the canonical address', async () => {
    at('/settings?tab=nonsense');
    expect(await screen.findByText('bank /settings')).toBeTruthy();
  });
  it('the default tab written out also goes to the canonical address', async () => {
    at('/settings?tab=bank');
    expect(await screen.findByText('bank /settings')).toBeTruthy();
  });
});
