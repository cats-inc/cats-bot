import { useEffect, useState } from 'react';
import { t, useI18n } from '../i18n.ts';
import type { StandingGrant } from '../../core/types.ts';
import { activeGrants, grantLine } from './grantText.ts';
export { activeGrants, grantCategoryText, grantLine, STANDING_GRANT_MINUTES } from './grantText.ts';

/**
 * ADR-027: what the owner granted, always in view, with Stop. Stop ends every grant of this
 * conversation and cancels its turn; Escape also interrupts Kimi Computer Use's own input.
 */
export function StandingGrantsBar({ grants, busy, error = false, onStop }: {
  grants: readonly StandingGrant[] | undefined;
  busy: boolean;
  /** Runtime did not confirm the last Stop; the grants may still be in force. */
  error?: boolean;
  onStop(): void;
}) {
  useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const active = activeGrants(grants, now);
  if (!active.length) return null;
  return (
    <section className="desktop-bar grants-bar" id="standing-grants" aria-label={t('Allowed without asking')}>
      <div className="desktop-holding" role="alert">
        <span>
          {active.map((grant) => <span key={grant.category} className="grant-line">{grantLine(grant, now)}</span>)}
        </span>
        <button className="desktop-stop" id="standing-grants-stop" disabled={busy} onClick={onStop}>
          {t('Stop')}
        </button>
      </div>
      {error && (
        <div className="desktop-error" role="alert">
          {t('Stop was not confirmed, so these may still be allowed. Press Stop again, or quit Cats Bot.')}
        </div>
      )}
      <div className="desktop-status" role="status">
        {t('Stop also cancels the current reply. Ctrl+Alt+Shift+S stops every cat bot from anywhere.')}
      </div>
    </section>
  );
}
