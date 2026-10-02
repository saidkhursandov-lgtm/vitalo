import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Empty, ErrorState, Loading, RegionCitySelect } from '../components/ui';
import { ApiError } from '../lib/api';
import { nameOf } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { useAddressActions, useAddresses, useRegions } from '../lib/queries';
import { confirmDialog } from '../lib/telegram';

export function Addresses() {
  const { t, lang } = useI18n();
  const addresses = useAddresses();
  const { makePrimary, remove } = useAddressActions();

  return (
    <div className="page">
      <h1>{t('addresses.title')}</h1>
      {addresses.isPending ? (
        <Loading />
      ) : addresses.isError ? (
        <ErrorState error={addresses.error} onRetry={() => void addresses.refetch()} />
      ) : addresses.data.length === 0 ? (
        <Empty>{t('addresses.empty')}</Empty>
      ) : (
        addresses.data.map((a) => (
          <section key={a.id} className="card address">
            <div className="address-head">
              <strong>{a.label || nameOf(a.city, lang)}</strong>
              {a.is_primary && <span className="status status-paid">{t('addresses.primary')}</span>}
            </div>
            <p>
              {nameOf(a.region, lang)}, {nameOf(a.city, lang)}
              <br />
              {a.address_text}
            </p>
            <div className="row-actions">
              {!a.is_primary && (
                <button className="btn btn-secondary btn-sm" onClick={() => makePrimary.mutate(a.id)}>
                  {t('addresses.makePrimary')}
                </button>
              )}
              <Link to={`/profile/addresses/${a.id}`} className="btn btn-secondary btn-sm">
                {t('common.edit')}
              </Link>
              <button
                className="btn btn-secondary btn-sm danger"
                onClick={() => void confirmDialog(t('addresses.deleteConfirm')).then((ok) => ok && remove.mutate(a.id))}
              >
                {t('common.delete')}
              </button>
            </div>
          </section>
        ))
      )}
      <Link to="/profile/addresses/new" className="btn btn-block">
        {t('addresses.add')}
      </Link>
    </div>
  );
}

/** Add (/profile/addresses/new) or edit (/profile/addresses/:id) an address. */
export function AddressEdit() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const regions = useRegions();
  const addresses = useAddresses();
  const { create, update } = useAddressActions();
  const current = isNew ? undefined : addresses.data?.find((a) => a.id === id);

  const [draft, setDraft] = useState<{ label: string; region_id: string; city_id: string; address_text: string; is_primary: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (regions.isPending || addresses.isPending) return <Loading />;
  if (regions.isError) return <ErrorState error={regions.error} />;
  if (!isNew && !current) return <Empty>{t('common.error')}</Empty>;

  const form = draft ?? {
    label: current?.label ?? '',
    region_id: current?.region.id ?? '',
    city_id: current?.city.id ?? '',
    address_text: current?.address_text ?? '',
    is_primary: false,
  };
  const valid = form.region_id && form.city_id && form.address_text.trim();
  const saving = create.isPending || update.isPending;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setError(null);
    const body = { label: form.label.trim() || undefined, region_id: form.region_id, city_id: form.city_id, address_text: form.address_text.trim() };
    try {
      if (isNew) await create.mutateAsync({ ...body, is_primary: form.is_primary || undefined });
      else await update.mutateAsync({ id: id!, ...body });
      navigate('/profile/addresses', { replace: true });
    } catch (err) {
      setError(errorText(lang, err instanceof ApiError ? err.code : undefined));
    }
  }

  return (
    <form className="page" onSubmit={(e) => void submit(e)}>
      <h1>{isNew ? t('addresses.add') : t('addresses.edit')}</h1>
      <section className="card">
        <label className="field">
          <span>{t('addresses.label')}</span>
          <input maxLength={50} value={form.label} onChange={(e) => setDraft({ ...form, label: e.target.value })} />
        </label>
        <RegionCitySelect regions={regions.data} regionId={form.region_id} cityId={form.city_id} onChange={(v) => setDraft({ ...form, ...v })} />
        <label className="field">
          <span>{t('checkout.addressText')}</span>
          <input value={form.address_text} onChange={(e) => setDraft({ ...form, address_text: e.target.value })} />
        </label>
        {isNew && (addresses.data?.length ?? 0) > 0 && (
          <label className="check-row">
            <input type="checkbox" checked={form.is_primary} onChange={(e) => setDraft({ ...form, is_primary: e.target.checked })} />
            {t('addresses.makePrimary')}
          </label>
        )}
      </section>
      {error && <div className="notice notice-error">{error}</div>}
      <button type="submit" className="btn btn-block" disabled={!valid || saving}>
        {t('common.save')}
      </button>
    </form>
  );
}
