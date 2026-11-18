import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BackIcon } from '../components/Icons';
import { ErrorBox, Field, PageHead } from '../components/ui';
import type { IherbDraft } from '../components/IherbDraftPanel';
import { api } from '../lib/api';

const IHERB_URL = /^https:\/\/(?:[a-z]{2}\.|www\.)?iherb\.com\/pr\/(?:[^/?#]+\/)?\d{2,10}(?:[/?#].*)?$/i;

/**
 * D-78 «Добавить из iHerb»: the link + the page the owner saved in his own browser (iHerb blocks robots, we do not
 * bypass it) → AI drafts the whole product → the product editor opens with the draft; nothing is saved until
 * «Создать товар».
 */
export function IherbAdd() {
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const urlOk = IHERB_URL.test(url.trim());

  const run = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('url', url.trim());
      if (file) form.append('file', file);
      else form.append('text', text);
      return api<IherbDraft>('/staff/products/iherb/draft', { method: 'POST', form });
    },
    onSuccess: (r) => {
      if (!r.duplicate) navigate('/products/new', { state: { iherbDraft: r } });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run.mutate();
  };
  const dup = run.data?.duplicate;

  return (
    <form onSubmit={submit}>
      <PageHead title="Добавить товар из iHerb">
        <Link to="/products" className="btn btn-ghost">
          <BackIcon /> К списку
        </Link>
      </PageHead>
      <section className="card">
        <ol>
          <li>Вставьте ссылку на товар iHerb.</li>
          <li>
            Откройте эту ссылку у себя в браузере и нажмите <strong>Ctrl+S</strong> — сохраните страницу. Выберите сохранённый файл ниже. Если не получается — выделите всю
            страницу (Ctrl+A), скопируйте (Ctrl+C) и вставьте текст в поле.
          </li>
          <li>Нажмите «Подготовить черновик». AI заполнит карточку на русском и узбекском и данные для VITALO AI — около минуты.</li>
          <li>Проверьте черновик и нажмите «Создать товар». Товар создаётся скрытым — покупатели его не видят, пока вы не включите показ.</li>
        </ol>
        <p className="muted small">Страницу сохраняете вы: iHerb защищён от роботов, и система сама его не открывает. Цена берётся по правилам автоцены (цена iHerb + наценка 80%), страница должна быть в сумах.</p>
        <div className="form-grid">
          <Field label="Ссылка на товар iHerb" hint={url && !urlOk ? 'Нужна ссылка на страницу товара: https://uz.iherb.com/pr/…/12345' : undefined}>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://uz.iherb.com/pr/…/12345" inputMode="url" required />
          </Field>
          <Field label="Сохранённая страница (.html)">
            <input type="file" accept=".html,.htm,.mhtml,.mht,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
        {!file && (
          <Field label="…или текст страницы">
            <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ctrl+A, Ctrl+C на странице товара iHerb и вставьте сюда" />
          </Field>
        )}
        <ErrorBox error={run.error} />
        {dup && (
          <div className="alert alert-warn" role="alert">
            Этот товар iHerb уже есть: <Link to={`/products/${dup.id}`}>{dup.sku} — {dup.name_ru}</Link>
            {dup.status !== 'active' ? ` (${dup.status === 'hidden' ? 'скрыт' : 'в архиве'})` : ''}. Второй такой товар создать нельзя.
          </div>
        )}
        <div className="page-actions">
          <button type="submit" className="btn" disabled={!urlOk || (!file && text.trim().length < 50) || run.isPending}>
            {run.isPending ? 'AI изучает страницу… около минуты' : 'Подготовить черновик'}
          </button>
        </div>
      </section>
    </form>
  );
}

