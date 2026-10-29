import { t, useI18n } from '../i18n.ts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BotInteraction, InteractionAnswer, InteractionField } from '../../core/types.ts';

function Field({ field }: { field: InteractionField }) {
  useI18n();
  const name = `field:${field.id}`;
  // Schema required means the key exists, not that strings/arrays are nonempty.
  const common = { name, required: field.required && (['number', 'integer', 'boolean'].includes(field.type)
    || (field.type === 'string' && (field.minLength ?? 0) > 0)), autoComplete: 'off' };
  return (
    <label className="provider-field">
      <span>
        {field.label}
        {field.required ? ' *' : ''}
      </span>
      {field.description && <small>{field.description}</small>}
      {field.type === 'boolean' ? (
        <select {...common} defaultValue="">
          <option value="">{t('Choose…')}</option>
          <option value="true">{t('Yes')}</option>
          <option value="false">{t('No')}</option>
        </select>
      ) : field.options && !field.allowOther ? (
        <select
          {...common}
          required={field.required && field.type !== 'strings'}
          multiple={field.type === 'strings'}
          defaultValue={field.type === 'strings' ? [] : ''}
        >
          {field.type !== 'strings' && <option value="">{t('Choose…')}</option>}
          {field.options.map((o, index) => (
            <option key={o.id} value={`option:${index}`}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.type === 'strings' ? (
        <textarea {...common} rows={3} placeholder={t('One value per line')} />
      ) : (
        <input
          {...common}
          type={
            field.secret
              ? 'password'
              : field.type === 'number' || field.type === 'integer'
                ? 'number'
                : 'text'
          }
          min={
            field.type === 'integer' && field.min !== undefined ? Math.ceil(field.min) : field.min
          }
          max={
            field.type === 'integer' && field.max !== undefined ? Math.floor(field.max) : field.max
          }
          step={field.type === 'integer' ? 1 : 'any'}
          minLength={field.minLength}
          maxLength={field.maxLength}
        />
      )}
      {field.allowOther && field.options && (
        <small>
          {t('Suggestions:')}
          {field.options.map((o) => o.label).join(', ')}
          {t('. You may enter another value.')}
        </small>
      )}
    </label>
  );
}

export function InteractionCard({
  interaction: i,
  refresh,
}: {
  interaction: BotInteraction;
  refresh(): Promise<void>
}) {
  useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const form = useRef<HTMLFormElement>(null);
  // Retries with unchanged input use the same key; input is held only in this mounted form.
  const attempt = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const active = i.status === 'pending' && Date.parse(i.expiresAt) > now;
  useEffect(() => { if (!active) { form.current?.reset(); attempt.current = null; } }, [active]);
  const send = async (action: InteractionAnswer['action'], choice?: string) => {
    if (!active || busy) return;
    if (action === 'accept' && !form.current?.reportValidity()) return;
    const data = new FormData(form.current!);
    const answer: InteractionAnswer = { action, ...(choice ? { choice } : {}) };
    if (action === 'accept') {
      if (i.prompt?.fields?.length) {
        const values: NonNullable<InteractionAnswer['values']> = Object.create(null);
        for (const f of i.prompt.fields) {
          const raw = data.get(`field:${f.id}`);
          const enumerated = f.options && !f.allowOther;
          const decode = (value: FormDataEntryValue) =>
            enumerated ? (f.options![Number(String(value).slice(7))]?.id ?? '') : String(value);
          const value = raw === null || raw === '' ? raw : decode(raw);
          if ((raw === '' || raw === null) && !f.required) continue;
          values[f.id] = f.type === 'boolean' ? value === 'true'
            : f.type === 'integer' || f.type === 'number' ? Number(value)
              : f.type === 'strings' ? enumerated ? data.getAll(`field:${f.id}`).map(decode)
                : String(value ?? '').split('\n').map(v => v.trim()).filter(Boolean) : String(value ?? '');
        }
        answer.values = values;
      }
      if (i.kind === 'permission_grant') {
        answer.grants = data.getAll('grant').map(String);
        answer.scope = data.get('scope') === 'session' ? 'session' : 'turn';
      }
    }
    const body = JSON.stringify(answer);
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      await window.catsBot.invoke('respondProviderInteraction', i.conversationId, i.interactionId, {
        workerGeneration: i.workerGeneration, executionId: i.executionId, workItemId: i.workItemId,
        expectedRevision: i.revision, idempotencyKey: attempt.current!.key, answer,
      });
      form.current?.reset();
      attempt.current = null;
      await refresh();
    } catch {
      setError(t('The response was not confirmed. Refresh this request before retrying.'));
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void send('accept'); };
  return (
    <section className="provider-card" aria-label={t('Provider request')}>
      <strong>{i.prompt?.title ?? `Provider ${i.kind.replaceAll('_', ' ')}`}</strong>
      <small>
        {i.prompt?.server ?? t('Agent CLI')} · {i.status}
        {t('· expires')}
        {new Date(i.expiresAt).toLocaleTimeString()}
      </small>
      {i.reason && <p>{i.reason.replaceAll('_', ' ')}</p>}
      {i.prompt?.message && <p>{i.prompt.message}</p>}
      {i.prompt?.command && <pre>{i.prompt.command}</pre>}
      {i.prompt?.cwd && (
        <small>
          {t('Folder:')}
          {i.prompt.cwd}
        </small>
      )}
      {active && (
        <form ref={form} onSubmit={submit}>
          <fieldset disabled={busy}>
            {i.prompt?.fields?.map((f) => (
              <Field key={f.id} field={f} />
            ))}
            {i.prompt?.permissions?.map((p) => (
              <label key={p.id}>
                <input type="checkbox" name="grant" value={p.id} /> {p.label}
              </label>
            ))}
            {i.prompt?.scopes && (
              <label>
                {t('Grant duration')}
                <select name="scope" defaultValue={i.prompt.scopes[0]}>
                  {i.prompt.scopes.map((s) => (
                    <option key={s} value={s}>
                      {s === 'turn' ? t('This turn') : t('This session')}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {i.prompt?.url && (
              <div>
                <p className="provider-url">{i.prompt.url}</p>
                <button
                  type="button"
                  onClick={() =>
                    void window.catsBot
                      .invoke('openProviderInteractionUrl', i.conversationId, i.interactionId)
                      .catch(() => setError(t('This URL request is no longer available.')))
                  }
                >
                  {t('Open in browser')}
                </button>
                <p>
                  {t(
                    'Opening the page does not finish authorization. Complete its steps, then confirm below.',
                  )}
                </p>
              </div>
            )}
            <div className="provider-actions">
              {i.prompt?.choices?.length ? (
                i.prompt.choices.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    title={c.description}
                    onClick={() => void send('accept', c.id)}
                  >
                    {c.label}
                  </button>
                ))
              ) : (
                <button type="submit">
                  {i.kind === 'mcp_url' ? t('I completed the steps') : t('Submit response')}
                </button>
              )}
              <button type="button" onClick={() => void send('decline')}>
                {t('Decline')}
              </button>
              <button type="button" onClick={() => void send('cancel')}>
                {t('Cancel request')}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
