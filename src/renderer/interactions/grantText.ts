import { t } from '../localeStore.ts';
import type { GrantCategory, StandingGrant } from '../../core/types.ts';

/** ADR-027: the time a card's "for 30 minutes" grants. */
export const STANDING_GRANT_MINUTES = 30;

/** What one category lets the provider do without asking, as the owner reads it. */
export function grantCategoryText(category: GrantCategory): string {
  return category === 'computer_use' ? t('operate the desktop')
    : category === 'command' ? t('run commands') : t('change files');
}

/** Grants still in force at `now`; Runtime ends a timed grant at its expiry. */
export function activeGrants(grants: readonly StandingGrant[] | undefined, now: number): StandingGrant[] {
  return (grants ?? []).filter((grant) => !grant.expiresAt || Date.parse(grant.expiresAt) > now);
}

/** One line of the note's grants bar. */
export function grantLine(grant: StandingGrant, now: number): string {
  const what = grantCategoryText(grant.category);
  if (grant.until === 'session' || !grant.expiresAt) return t('May {what} without asking in this conversation', { what });
  const minutes = Math.max(1, Math.ceil((Date.parse(grant.expiresAt) - now) / 60_000));
  return t('May {what} without asking for {minutes} more min', { what, minutes: String(minutes) });
}
