import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge, ErrorBox, Field, Loading, Modal, toInt, Help } from '../../components/ui';
import { api } from '../../lib/api';
import { money } from '../../lib/format';
import { MapsSettings } from './Maps';

interface Tariff {
  id: string;
  region: { id: string; name_ru: string };
  city: { id: string; name_ru: string } | null;
  tariff_uzs: number;
  free_shipping_threshold_uzs: number;
  status: 'active' | 'disabled';
  min_days: number | null;
  max_days: number | null;
  note_ru: string | null;
  note_uz: string | null;
  is_test: boolean;
}
interface City {
  id: string;
  name_ru: string;
  name_uz: string;
  status: 'active' | 'archived';
}
interface Region {
  id: string;
  name_ru: string;
  name_uz: string;
  status: 'active' | 'archived';
  cities: City[];
}

const useRegions = () => useQuery({ queryKey: ['settings', 'regions'], queryFn: () => api<Region[]>('/staff/settings/regions') });
const days = (t: Pick<Tariff, 'min_days' | 'max_days'>) => (t.min_days == null || t.max_days == null ? null : t.min_days === t.max_days ? `${t.min_days}` : `${t.min_days}–${t.max_days}`);

/** Delivery: tariffs with terms (test ones highlighted) and the cities of every region. */
export function DeliverySettings() {
  return (
    <>
      <Tariffs />
      <MapsSettings />
      <h2 className="section-title">Города и районы</h2>
      <Cities />
    </>
  );
}

function Tariffs() {
  const q = useQuery({ queryKey: ['settings', 'tariffs'], queryFn: () => api<Tariff[]>('/staff/settings/tariffs') });
  const [edit, setEdit] = useState<Tariff | 'new' | null>(null);
  const tests = q.data?.filter((t) => t.is_test && t.status === 'active').length ?? 0;
  return (
    <section className="card flush">
      <div className="card-head">
        <Help id="delivery">
          Тариф города важнее тарифа региона. Порог — сумма товаров после скидок, с которой доставка бесплатна. Срок — рабочих дней; у города без своего срока
          берётся срок региона.
        </Help>
        <button className="btn" onClick={() => setEdit('new')}>
          + Тариф
        </button>
      </div>
      {tests > 0 && (
        <div className="alert alert-warn" style={{ margin: '12px 20px 0' }}>
          Тестовых тарифов: {tests}. Они созданы автоматически (35 000 сум, бесплатно от 500 000) — проверьте цены и снимите отметку «тестовый».
        </div>
      )}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (
        <table className="table table-hover">
          <thead>
            <tr>
              <th>Регион</th>
              <th>Город</th>
              <th className="num">Доставка</th>
              <th className="num">Бесплатно от</th>
              <th className="num">Срок, дней</th>
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((t) => (
              <tr key={t.id} className={`${t.status === 'active' ? '' : 'muted'} ${t.is_test ? 'row-warn' : ''}`}>
                <td>
                  {t.region.name_ru}
                  {t.is_test && (
                    <div>
                      <Badge tone="warn">тестовый, проверить</Badge>
                    </div>
                  )}
                </td>
                <td>{t.city?.name_ru ?? <span className="muted">весь регион</span>}</td>
                <td className="num">{money(t.tariff_uzs)}</td>
                <td className="num">{money(t.free_shipping_threshold_uzs)}</td>
                <td className="num">{days(t) ?? <span className="muted">{t.city ? 'как регион' : '—'}</span>}</td>
                <td>
                  <Badge tone={t.status === 'active' ? 'ok' : 'neutral'}>{t.status === 'active' ? 'Активен' : 'Выключен'}</Badge>
                </td>
                <td>
                  <button className="btn btn-sm btn-ghost" onClick={() => setEdit(t)}>
                    Изменить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <TariffModal tariff={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function TariffModal({ tariff, onClose }: { tariff: Tariff | null; onClose: () => void }) {
  const client = useQueryClient();
  const regions = useRegions();
  const [f, setF] = useState({
    region_id: tariff?.region.id ?? '',
    city_id: tariff?.city?.id ?? '',
    tariff_uzs: tariff ? String(tariff.tariff_uzs) : '',
    free_shipping_threshold_uzs: tariff ? String(tariff.free_shipping_threshold_uzs) : '',
    min_days: tariff?.min_days?.toString() ?? '',
    max_days: tariff?.max_days?.toString() ?? '',
    note_ru: tariff?.note_ru ?? '',
    note_uz: tariff?.note_uz ?? '',
    status: tariff?.status ?? 'active',
    is_test: tariff?.is_test ?? false,
  });
  const m = useMutation({
    mutationFn: () => {
      const body = {
        region_id: f.region_id,
        city_id: f.city_id || null,
        tariff_uzs: toInt(f.tariff_uzs),
        free_shipping_threshold_uzs: toInt(f.free_shipping_threshold_uzs),
        min_days: toInt(f.min_days) ?? null,
        max_days: toInt(f.max_days) ?? null,
        note_ru: f.note_ru,
        note_uz: f.note_uz,
        status: f.status,
        is_test: f.is_test,
      };
      return tariff ? api(`/staff/settings/tariffs/${tariff.id}`, { method: 'PATCH', body }) : api('/staff/settings/tariffs', { method: 'POST', body });
    },
    onSuccess: (list) => {
      client.setQueryData(['settings', 'tariffs'], list);
      onClose();
    },
  });
  const region = regions.data?.find((r) => r.id === f.region_id);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };

  return (
    <Modal title={tariff ? 'Изменить тариф' : 'Новый тариф'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Регион">
            <select value={f.region_id} onChange={(e) => setF({ ...f, region_id: e.target.value, city_id: '' })} required>
              <option value="">—</option>
              {regions.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name_ru}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Город" hint="Пусто — для всего региона">
            <select value={f.city_id} onChange={(e) => setF({ ...f, city_id: e.target.value })}>
              <option value="">Весь регион</option>
              {region?.cities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_ru}
                  {c.status === 'active' ? '' : ' (выключен)'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Стоимость доставки, сум">
            <input inputMode="numeric" value={f.tariff_uzs} onChange={(e) => setF({ ...f, tariff_uzs: e.target.value })} required />
          </Field>
          <Field label="Бесплатно от, сум">
            <input inputMode="numeric" value={f.free_shipping_threshold_uzs} onChange={(e) => setF({ ...f, free_shipping_threshold_uzs: e.target.value })} required />
          </Field>
          <Field label="Срок от, рабочих дней" hint={f.city_id ? 'Пусто — как у региона' : undefined}>
            <input inputMode="numeric" value={f.min_days} onChange={(e) => setF({ ...f, min_days: e.target.value })} />
          </Field>
          <Field label="Срок до, рабочих дней">
            <input inputMode="numeric" value={f.max_days} onChange={(e) => setF({ ...f, max_days: e.target.value })} />
          </Field>
        </div>
        <Field label="Заметка о доставке (RU), необязательно" hint="Покажется под сроком, например «Доставка в отдалённые районы — по договорённости»">
          <input value={f.note_ru} maxLength={300} onChange={(e) => setF({ ...f, note_ru: e.target.value })} />
        </Field>
        <Field label="Заметка о доставке (UZ)">
          <input value={f.note_uz} maxLength={300} onChange={(e) => setF({ ...f, note_uz: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.status === 'active'} onChange={(e) => setF({ ...f, status: e.target.checked ? 'active' : 'disabled' })} />
          Активен
        </label>{' '}
        <label className="check">
          <input type="checkbox" checked={f.is_test} onChange={(e) => setF({ ...f, is_test: e.target.checked })} />
          Тестовый (проверить цены)
        </label>
        <ErrorBox error={m.error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn" disabled={m.isPending}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Cities and districts: add, rename, switch off (switched-off cities disappear from the shop, old orders keep them). */
function Cities() {
  const client = useQueryClient();
  const regions = useRegions();
  const [regionId, setRegionId] = useState('');
  const [edit, setEdit] = useState<City | 'new' | null>(null);
  const region = regions.data?.find((r) => r.id === regionId) ?? regions.data?.[0];
  const toggle = useMutation({
    mutationFn: (c: City) => api<Region[]>(`/staff/settings/cities/${c.id}`, { method: 'PATCH', body: { status: c.status === 'active' ? 'archived' : 'active' } }),
    onSuccess: (list) => client.setQueryData(['settings', 'regions'], list),
  });
  if (regions.isPending) return <Loading />;
  if (regions.isError) return <ErrorBox error={regions.error} />;
  return (
    <section className="card">
      <div className="filters">
        <select value={region?.id ?? ''} onChange={(e) => setRegionId(e.target.value)} aria-label="Регион">
          {regions.data.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name_ru} ({r.cities.length})
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setEdit('new')} disabled={!region}>
          + Город
        </button>
      </div>
      <ErrorBox error={toggle.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Название (RU)</th>
            <th>Название (UZ)</th>
            <th>Статус</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {region?.cities.map((c) => (
            <tr key={c.id} className={c.status === 'active' ? '' : 'muted'}>
              <td>{c.name_ru}</td>
              <td>{c.name_uz}</td>
              <td>
                <Badge tone={c.status === 'active' ? 'ok' : 'neutral'}>{c.status === 'active' ? 'Активен' : 'Выключен'}</Badge>
              </td>
              <td className="ops">
                <button className="btn btn-sm btn-ghost" onClick={() => setEdit(c)}>
                  Изменить
                </button>
                <button className="btn btn-sm btn-ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(c)}>
                  {c.status === 'active' ? 'Выключить' : 'Включить'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && region && <CityModal regionId={region.id} city={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function CityModal({ regionId, city, onClose }: { regionId: string; city: City | null; onClose: () => void }) {
  const client = useQueryClient();
  const [f, setF] = useState({ name_ru: city?.name_ru ?? '', name_uz: city?.name_uz ?? '' });
  const m = useMutation({
    mutationFn: () =>
      city ? api<Region[]>(`/staff/settings/cities/${city.id}`, { method: 'PATCH', body: f }) : api<Region[]>('/staff/settings/cities', { method: 'POST', body: { region_id: regionId, ...f } }),
    onSuccess: (list) => {
      client.setQueryData(['settings', 'regions'], list);
      void client.invalidateQueries({ queryKey: ['regions'] });
      onClose();
    },
  });
  return (
    <Modal title={city ? 'Изменить город' : 'Новый город или район'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Название (RU)">
          <input value={f.name_ru} maxLength={100} onChange={(e) => setF({ ...f, name_ru: e.target.value })} required />
        </Field>
        <Field label="Название (UZ, латиница)">
          <input value={f.name_uz} maxLength={100} onChange={(e) => setF({ ...f, name_uz: e.target.value })} required />
        </Field>
        <ErrorBox error={m.error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn" disabled={m.isPending}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}
