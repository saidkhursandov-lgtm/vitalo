import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PinIcon } from '../components/Icons';
import { Empty, EmptyState, ErrorState, Loading } from '../components/ui';
import { AddressFields, type AddressValue } from '../components/AddressFields';
import { ApiError } from '../lib/api';
import { nameOf } from '../lib/format';
import { composeAddress } from '../lib/address';
import { errorText, useI18n } from '../lib/i18n';
import { useAddressActions, useAddresses, useRegions } from '../lib/queries';
import { useConfirm } from '../components/Confirm';

export function Addresses() {
  const { t, lang } = useI18n();
  const confirm = useConfirm();
  const addresses = useAddresses();
  const { makePrimary, remove } = useAddressActions();

  return (
    <div className="page">
      <h1>{t('addresses.title')}</h1>
      {addresses.isPending ? (
        <Loading variant="list" count={2} />
      ) : addresses.isError ? (
        <ErrorState error={addresses.error} onRetry={() => void addresses.refetch()} />
      ) : addresses.data.length === 0 ? (
        <EmptyState icon={PinIcon} title={t('addresses.empty')} />
      ) : (
        addresses.data.map((a) => (
          <section key={a.id} className="card address">
            <div className="address-head">
              <strong>{a.label || nameOf(a.city, lang)}</strong>
              {a.is_primary && <span className="tag">{t('addresses.primary')}</span>}
            </div>
            <p>
              {nameOf(a.region, lang)}, {nameOf(a.city, lang)}
              <br />
              {composeAddress(a.address_text, a, lang)}
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
                onClick={() => void confirm({ message: t('addresses.deleteConfirm'), ok: t('common.delete'), danger: true }).then((ok) => ok && remove.mutate(a.id))}
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

  const [draft, setDraft] = useState<(AddressValue & { label: string; is_primary: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (regions.isPending || addresses.isPending) return <div className="page"><Loading /></div>;
  if (regions.isError) return <ErrorState error={regions.error} />;
  if (!isNew && !current) return <Empty>{t('common.error')}</Empty>;

  const form = draft ?? {
    label: current?.label ?? '',
    region_id: current?.region.id ?? '',
    city_id: current?.city.id ?? '',
    address_text: current?.address_text ?? '',
    details: { apartment: current?.apartment ?? '', entrance: current?.entrance ?? '', floor: current?.floor ?? '', landmark: current?.landmark ?? '' },
    point: current?.latitude != null && current.longitude != null ? { lat: current.latitude, lon: current.longitude } : null,
    is_primary: false,
  };
  const valid = form.region_id && form.city_id && form.address_text.trim();
  const saving = create.isPending || update.isPending;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setError(null);
    const body = {
      label: form.label.trim() || undefined,
      region_id: form.region_id,
      city_id: form.city_id,
      address_text: form.address_text.trim(),
      // 3.6: the map point (null clears an old one) and the parts typed by hand ('' clears)
      latitude: form.point?.lat ?? null,
      longitude: form.point?.lon ?? null,
      ...form.details,
    };
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
        <AddressFields regions={regions.data} value={form} place="profile" onChange={(v) => setDraft({ ...form, ...v })} />
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
