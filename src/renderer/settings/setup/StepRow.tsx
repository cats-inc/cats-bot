import { useState } from 'react';
import type { SetupStep } from '../../../shared/providerSetup.ts';
import { useI18n } from '../../i18n.ts';
import { stepFacts } from './setupFacts.ts';
import { rowKind } from './setupLogic.ts';

/** SPEC-010 FR-10: every command in the wizard looks like this, with a copy button when it is for the owner. */
export function CommandSnippet({ command, copyable = false }: { command: string; copyable?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <>
      <code className="setup-command">{command}</code>
      {copyable && (
        <button
          type="button"
          className="setup-copy"
          onClick={() => {
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }).catch(() => {});
          }}
        >
          {copied ? t('Copied') : t('Copy')}
        </button>
      )}
    </>
  );
}

function CheckIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="var(--ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function CrossIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" /></svg>;
}
export function WaitIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--muted-text)" strokeWidth="1.5" /><path d="M8 4.5V8l2.2 1.6" fill="none" stroke="var(--muted-text)" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}
export { CheckIcon };

export function StepTitle({ label, optional }: { label: string; optional: boolean }) {
  const { t } = useI18n();
  return <strong>{t(label)}{optional && <em className="setup-optional">{t('(optional step)')}</em>}</strong>;
}

/** A row that says only where it is: before the check has reached it, or while it runs. */
export function PlainRow({ label, optional, glyph, state, note, id }: { label: string; optional: boolean; glyph: React.ReactNode; state: string; note?: string | null; id?: string }) {
  return (
    <li className="setup-row" data-row={id}>
      <div className="setup-row-top">
        <span className="setup-glyph">{glyph}</span>
        <div className="setup-row-text"><StepTitle label={label} optional={optional} />{note && <p>{note}</p>}</div>
        <span className="setup-row-state">{state}</span>
      </div>
    </li>
  );
}

function Details({ step, provider, platform }: { step: SetupStep; provider: string; platform: string }) {
  const { t } = useI18n();
  const facts = stepFacts(step, provider, platform);
  return (
    <div className="setup-details">
      <dl>
        {step.planned.length > 0 && (
          <>
            <dt>{t('It will')}</dt>
            <dd>{step.planned.map((line, index) => <div key={index}>{line}</div>)}</dd>
          </>
        )}
        {step.applyCommand && (
          <>
            <dt>{t('Runs')}</dt>
            <dd><CommandSnippet command={step.applyCommand} /></dd>
          </>
        )}
        {step.script && (
          <>
            <dt>{t('Script')}</dt>
            <dd>
              {step.script.sha256
                ? t('{file}, SHA-256 {hash}…, from {source}', { file: step.script.file, hash: step.script.sha256.slice(0, 8), source: step.script.source ?? '' })
                : step.script.file}
            </dd>
          </>
        )}
        {facts.manual && (
          <>
            <dt>{t('By hand')}</dt>
            <dd className="setup-with-copy"><CommandSnippet command={facts.manual} copyable /></dd>
          </>
        )}
        {step.warnings.length > 0 && (
          <>
            <dt>{t('Warnings')}</dt>
            <dd>{step.warnings.map((line, index) => <div key={index}>{line}</div>)}</dd>
          </>
        )}
        {step.manualSteps.length > 0 && (
          <>
            <dt>{t('Next')}</dt>
            <dd>{step.manualSteps.map((line, index) => <div key={index}>{t(line)}</div>)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

const elevationDeclinedText = 'You chose No in the Windows prompt, so nothing changed.';

/** FR-8 and FR-10: one row of the checklist, once the check has reported on it. */
export function StepRow({
  step,
  provider,
  platform,
  ticked,
  disabled,
  justApplied,
  detailsOpen,
  onTick,
  onDetails,
}: {
  step: SetupStep;
  provider: string;
  platform: string;
  ticked: boolean;
  disabled: boolean;
  justApplied: boolean;
  detailsOpen: boolean;
  onTick(ticked: boolean): void;
  onDetails(open: boolean): void;
}) {
  const { t } = useI18n();
  const kind = rowKind(step);
  const facts = stepFacts(step, provider, platform);
  const more = (
    <button type="button" className="setup-more" id={`setup-more-${step.id}`} aria-expanded={detailsOpen} onClick={() => onDetails(!detailsOpen)}>
      {detailsOpen ? t('Hide details') : t('What it does')}
    </button>
  );
  const tags = (
    <div className="setup-tags">
      {facts.tags.map((tag) => <span key={tag.text} className={tag.danger ? 'setup-tag is-danger' : 'setup-tag'}>{t(tag.text, tag.values)}</span>)}
      {more}
    </div>
  );
  if (kind === 'ready') {
    return (
      <li className="setup-row is-ready" data-row={step.id}>
        <div className="setup-row-top">
          <span className="setup-glyph"><CheckIcon /></span>
          <div className="setup-row-text">
            <StepTitle label={step.label} optional={step.optional} />
            {step.systemRestartRequired && <p className="setup-system-restart">{t('Restart Windows to finish installation.')}</p>}
          </div>
          <span className="setup-row-state">
            {justApplied ? t('Just finished') : t('Ready')}{step.version && <code className="setup-version">{step.version}</code>}
          </span>
        </div>
      </li>
    );
  }
  if (kind === 'waiting') {
    return (
      <li className="setup-row is-waiting" data-row={step.id}>
        <div className="setup-row-top">
          <span className="setup-glyph"><WaitIcon /></span>
          <div className="setup-row-text">
            <StepTitle label={step.label} optional={step.optional} />
            <p>{t('Waits for Node.js. Once it works, this lists what it would do, for you to tick.')}</p>
          </div>
        </div>
      </li>
    );
  }
  if (kind === 'restart') {
    return (
      <li className="setup-row is-failed" data-row={step.id}>
        <div className="setup-row-top">
          <span className="setup-glyph"><WaitIcon /></span>
          <div className="setup-row-text">
            <StepTitle label={step.label} optional={step.optional} />
            <p className={step.systemRestartRequired ? 'setup-system-restart' : undefined}>{step.systemRestartRequired
              ? t('Restart Windows to finish installation.')
              : t('Installed, but Cats Bot cannot find it yet. Check again first. If that does not help, restart Cats Bot.')}</p>
          </div>
          <span className="setup-row-state is-attention">{t('Not found yet')}</span>
        </div>
      </li>
    );
  }
  if (kind === 'failed' || kind === 'declined') {
    return (
      <li className="setup-row is-failed" data-row={step.id}>
        <div className="setup-row-top">
          <span className="setup-glyph"><CrossIcon /></span>
          <div className="setup-row-text">
            <StepTitle label={step.label} optional={step.optional} />
            <p>{kind === 'declined' ? t(elevationDeclinedText) : t('It did not finish. The log below says why.')}</p>
            {step.systemRestartRequired && <p className="setup-system-restart">{t('Restart Windows to finish installation.')}</p>}
          </div>
          <span className="setup-row-state is-danger">{t('Not installed')}</span>
        </div>
        {tags}
        {detailsOpen && <Details step={step} provider={provider} platform={platform} />}
      </li>
    );
  }
  return (
    <li className="setup-row is-needs" data-row={step.id}>
      <div className="setup-row-top">
        <label>
          <input type="checkbox" id={`setup-tick-${step.id}`} checked={ticked} disabled={disabled} onChange={(event) => onTick(event.target.checked)} />
          <span className="setup-row-text">
            <StepTitle label={step.label} optional={step.optional} />
            <p>{t(facts.summary, facts.summaryValues)}</p>
          </span>
        </label>
      </div>
      {tags}
      {detailsOpen && <Details step={step} provider={provider} platform={platform} />}
    </li>
  );
}
