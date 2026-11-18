'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { MapPin, Plus } from 'lucide-react';
import { api, ApiError } from '@/lib/client';
import { composeAddress, EMPTY_DETAILS, type AddressDetails } from '@/lib/address';
import { nameOf } from '@/lib/format';
import { errorText } from '@/lib/i18n';
import type { Address, Region } from '@/lib/types';
import { useSession } from '@/components/Session';
import { AccountShell } from '@/components/AccountShell';

/** Delivery addresses: the same list the checkout (site and Mini App) offers. */
export function AddressesView() {
  const { t } = useSession();
  return (
    <AccountShell section="addresses" title={t('addresses.title')}>
      <AddressList />
    </AccountShell>
  );
}

interface Draft {
  id: string | null;
  label: string;
  region_id: string;
  city_id: string;
  address_text: string;
  details: AddressDetails;
  is_primary: boolean;
}

const draftOf = (a?: Address): Draft => ({
  id: a?.id ?? null,
  label: a?.label ?? '',
  region_id: a?.region.id ?? '',
  city_id: a?.city.id ?? '',
  address_text: a?.address_text ?? '',
  details: a ? { apartment: a.apartment ?? '', entrance: a.entrance ?? '', floor: a.floor ?? '', landmark: a.landmark ?? '' } : EMPTY_DETAILS,
  is_primary: false,
});

function AddressList() {
  const { t, lang } = useSession();
  const [list, setList] = useState<Address[] | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<Address[]>('/addresses').then(setList, () => setList([]));
    void api<Region[]>('/delivery/regions').then(setRegions, () => null);
  }, []);

  async function run(fn: () => Promise<Address[] | Address>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setList(Array.isArray(r) ? r : await api<Address[]>('/addresses'));
      return true;
    } catch (e) {
      setError(errorText(lang, e instanceof ApiError ? e.code : undefined));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft || !draft.region_id || !draft.city_id || !draft.address_text.trim()) return;
    // the map point is kept as it is: the site has no map yet, so latitude/longitude are not sent
    const body = { label: draft.label.trim() || undefined, region_id: draft.region_id, city_id: draft.city_id, address_text: draft.address_text.trim(), ...draft.details };
    const ok = await run(() =>
      draft.id
        ? api<Address>(`/addresses/${draft.id}`, { method: 'PATCH', body })
        : api<Address>('/addresses', { method: 'POST', body: { ...body, is_primary: draft.is_primary || undefined } }),
    );
    if (ok) setDraft(null);
  }

  if (list === null) {
    return (
      <div className="wait">
        <span className="spinner" aria-label={t('common.loading')} />
      </div>
    );
  }

  const region = regions.find((r) => r.id === draft?.region_id);
  const form = draft ? (
    <form className="card ck-section" onSubmit={(e) => void save(e)}>
      <h2>{draft.id ? t('addresses.edit') : t('addresses.add')}</h2>
      <div className="form-grid">
        <label className="field wide">
          <span>{t('addresses.label')}</span>
          <input className="input" maxLength={50} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('checkout.region')}</span>
          <select className="select input" value={draft.region_id} onChange={(e) => setDraft({ ...draft, region_id: e.target.value, city_id: '' })}>
            <option value="">{t('checkout.choose')}</option>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {nameOf(r, lang)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('checkout.city')}</span>
          <select className="select input" value={draft.city_id} disabled={!region} onChange={(e) => setDraft({ ...draft, city_id: e.target.value })}>
            <option value="">{t('checkout.choose')}</option>
            {(region?.cities ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {nameOf(c, lang)}
              </option>
            ))}
          </select>
        </label>
        <label className="field wide">
          <span>{t('checkout.street')}</span>
          <input className="input" maxLength={300} value={draft.address_text} onChange={(e) => setDraft({ ...draft, address_text: e.target.value })} />
        </label>
        <div className="form-grid wide" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          {(['apartment', 'entrance', 'floor'] as const).map((k) => (
            <label key={k} className="field">
              <span>{t(`checkout.${k}`)}</span>
              <input className="input" maxLength={20} value={draft.details[k]} onChange={(e) => setDraft({ ...draft, details: { ...draft.details, [k]: e.target.value } })} />
            </label>
          ))}
        </div>
        <label className="field wide">
          <span>{t('checkout.landmark')}</span>
          <input className="input" maxLength={200} value={draft.details.landmark} onChange={(e) => setDraft({ ...draft, details: { ...draft.details, landmark: e.target.value } })} />
        </label>
        {!draft.id && list.length > 0 ? (
          <label className="check wide">
            <input type="checkbox" checked={draft.is_primary} onChange={(e) => setDraft({ ...draft, is_primary: e.target.checked })} /> {t('addresses.makePrimary')}
          </label>
        ) : null}
      </div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      <div className="row-actions">
        <button type="submit" className="btn" disabled={busy || !draft.region_id || !draft.city_id || !draft.address_text.trim()}>
          {t('acc.save')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setDraft(null)}>
          {t('acc.cancel')}
        </button>
      </div>
    </form>
  ) : null;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {list.length === 0 && !draft ? (
        <div className="empty">
          <span className="empty-ic">
            <MapPin size={40} strokeWidth={1.6} />
          </span>
          <h2>{t('addresses.empty')}</h2>
        </div>
      ) : null}
      {list.map((a) =>
        draft?.id === a.id ? (
          <div key={a.id}>{form}</div>
        ) : (
          <section key={a.id} className="card ck-section address-card">
            <div className="sec-head">
              <b>{a.label || nameOf(a.city, lang)}</b>
              {a.is_primary ? <span className="status-badge is-info">{t('addresses.primary')}</span> : null}
            </div>
            <p>
              {nameOf(a.region, lang)}, {nameOf(a.city, lang)}
              <br />
              {composeAddress(a.address_text, a, lang)}
            </p>
            <div className="row-actions">
              {!a.is_primary ? (
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => api<Address[]>(`/addresses/${a.id}/primary`, { method: 'POST' }))}>
                  {t('addresses.makePrimary')}
                </button>
              ) : null}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDraft(draftOf(a))}>
                {t('acc.edit')}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('addresses.deleteConfirm'))) void run(() => api<Address[]>(`/addresses/${a.id}`, { method: 'DELETE' }));
                }}
              >
                {t('acc.delete')}
              </button>
            </div>
          </section>
        ),
      )}
      {draft && !draft.id ? form : null}
      {!draft ? (
        <button type="button" className="btn" style={{ justifySelf: 'start' }} onClick={() => setDraft(draftOf())}>
          <Plus size={18} strokeWidth={1.8} /> {t('addresses.add')}
        </button>
      ) : null}
      {error && !draft ? <div className="notice notice-error" role="alert">{error}</div> : null}
    </div>
  );
}
