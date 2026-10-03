import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { Markdown } from '../components/Markdown';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useRefreshUser } from '../lib/auth';
import { errorText, useI18n } from '../lib/i18n';
import { useLegalDocuments } from '../lib/queries';
import { haptic } from '../lib/telegram';
import type { LegalCode, LegalStatus } from '../lib/types';

/**
 * First screen until the current Public offer and Privacy policy are accepted (A1).
 * "Продолжить" works only with the consent box ticked; news and offers are a separate, optional box (off by default).
 */
export function Welcome() {
  const { t, lang, setLang } = useI18n();
  const client = useQueryClient();
  const refreshUser = useRefreshUser();
  const [agree, setAgree] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const accept = useMutation({
    mutationFn: () => api<LegalStatus>('/legal/accept', { method: 'POST', body: { marketing_opt_in: marketing } }),
    onSuccess: (status) => {
      haptic('success');
      void refreshUser().catch(() => undefined);
      client.setQueryData(['legal-status'], status);
    },
    onError: () => haptic('error'),
  });

  return (
    <div className="welcome">
      <div className="segmented welcome-lang">
        {(['ru', 'uz'] as const).map((l) => (
          <button key={l} className={lang === l ? 'is-on' : ''} onClick={() => setLang(l)}>
            {l === 'ru' ? 'Русский' : 'O‘zbekcha'}
          </button>
        ))}
      </div>
      <div className="welcome-body">
        <Logo size="lg" />
        <h1>{t('welcome.title')}</h1>
        <p className="hint">{t('welcome.text')}</p>
      </div>
      <div className="welcome-actions">
        <label className="check-row">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>
            {t('welcome.agreeBefore')}
            <Link to="/legal/offer" className="link">
              {t('welcome.offer')}
            </Link>
            {t('welcome.and')}
            <Link to="/legal/privacy" className="link">
              {t('welcome.privacy')}
            </Link>
            {t('welcome.agreeAfter')}
          </span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
          <span>{t('welcome.marketing')}</span>
        </label>
        {accept.isError && <p className="error-text small">{errorText(lang, accept.error instanceof ApiError ? accept.error.code : undefined)}</p>}
        <button className="btn btn-block" disabled={!agree || accept.isPending} onClick={() => accept.mutate()}>
          {t('welcome.continue')}
        </button>
      </div>
    </div>
  );
}

/** /legal/offer, /legal/privacy — the active version, Markdown formatting kept. */
export function LegalDocument() {
  const { code = '' } = useParams();
  const { t, lang } = useI18n();
  const docs = useLegalDocuments();
  if (docs.isPending) return <div className="page"><Loading /></div>;
  if (docs.isError) return <ErrorState error={docs.error} onRetry={() => void docs.refetch()} />;
  const doc = docs.data.find((d) => d.code === code);
  if (!doc) return <EmptyState title={t('common.error')} />;
  return (
    <div className="page legal-page">
      <h1>{t(`legal.${code as LegalCode}`)}</h1>
      <p className="hint small">{t('legal.version', { v: doc.version })}</p>
      <section className="card">
        <Markdown text={lang === 'uz' ? doc.text_uz : doc.text_ru} />
      </section>
    </div>
  );
}
