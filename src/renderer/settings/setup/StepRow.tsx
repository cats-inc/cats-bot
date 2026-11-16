import { useState } from 'react';
import type { CodexInitialization, SetupSignIn, SetupStep } from '../../../shared/providerSetup.ts';
import { useI18n } from '../../i18n.ts';
import type { StepFacts } from './setupFacts.ts';

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
export function CrossIcon() {
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

const rowClass = (base: string, depClass?: string) => (depClass ? `${base} ${depClass}` : base);

/** A row that says only where it is: before the check has reached it, or while it runs. */
export function PlainRow({ label, optional, glyph, state, note, id, depClass, extra }: {
  label: string;
  optional: boolean;
  glyph: React.ReactNode;
  state: string;
  note?: string | null;
  id?: string;
  /** SPEC-013 FR-2: where the row hangs from Node.js in the Agent CLIs tab. */
  depClass?: string;
  /** A line under the summary, such as the cat bots that use a CLI. */
  extra?: string | null;
}) {
  return (
    <li className={rowClass('setup-row', depClass)} data-row={id}>
      <div className="setup-row-top">
        <span className="setup-glyph">{glyph}</span>
        <div className="setup-row-text">
          <StepTitle label={label} optional={optional} />
          {note && <p>{note}</p>}
          {extra && <p className="setup-row-users">{extra}</p>}
        </div>
        <span className="setup-row-state">{state}</span>
      </div>
    </li>
  );
}

/** SPEC-010 FR-11: the row being applied, with its timer, and what Windows is about to ask. */
export function RunningRow({ step, windows, elapsed, depClass, extra }: {
  step: SetupStep<string>;
  windows: boolean;
  elapsed: string | null;
  depClass?: string;
  extra?: string | null;
}) {
  const { t } = useI18n();
  const adminPrompt = step.id === 'node' && windows;
  return (
    <PlainRow
      id={step.id}
      label={step.label}
      optional={step.optional}
      depClass={depClass}
      extra={extra}
      glyph={<span className="setup-spinner" />}
      state={elapsed ?? '00:00'}
      note={adminPrompt
        ? t('Windows asks for permission; choose Yes. The installer runs in that process, so this updates when it ends.')
        : t('Running {file}', { file: step.script?.file ?? step.label })}
    />
  );
}

export function QueuedRow({ step, depClass, extra }: { step: SetupStep<string>; depClass?: string; extra?: string | null }) {
  const { t } = useI18n();
  return <PlainRow id={step.id} label={step.label} optional={step.optional} depClass={depClass} extra={extra} glyph={<WaitIcon />} state={t('Queued')} />;
}

export function Details({ step, facts, update }: { step: SetupStep<string>; facts: StepFacts; update: boolean }) {
  const { t } = useI18n();
  const command = update ? step.updateCommand : step.applyCommand;
  return (
    <div className="setup-details">
      <dl>
        {step.checkError && (
          <>
            <dt>{t('Reason')}</dt>
            <dd className="setup-reason">{step.checkError}</dd>
          </>
        )}
        {update ? (
          <>
            <dt>{t('It will')}</dt>
            <dd>{t(facts.summary)}</dd>
          </>
        ) : step.planned.length > 0 && (
          <>
            <dt>{t('It will')}</dt>
            <dd>{step.planned.map((line, index) => <div key={index}>{line}</div>)}</dd>
          </>
        )}
        {command && (
          <>
            <dt>{t('Runs')}</dt>
            <dd><CommandSnippet command={command} /></dd>
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

/**
 * SPEC-010 FR-15: signing in, in a real terminal with the provider's fixed command. Cats Bot
 * only asks the CLI, and reads no credential files.
 */
export function SignInRow({ id, label, signIn, command, who, busy, terminal, powerShellLeft, changedPath, onOpen }: {
  id: string;
  label: string;
  signIn: SetupSignIn;
  command: string | null;
  /** Who cannot answer until it is done: a cat bot's name, or the cat bots in general. */
  who: string;
  busy: boolean;
  terminal: 'opened' | 'missing' | null;
  powerShellLeft: boolean;
  changedPath: boolean;
  onOpen(): void;
}) {
  const { t } = useI18n();
  const openTerminalNote = changedPath ? t('Terminals already open need reopening to see the new PATH; this button opens a new one.') : '';
  return (
    <li className={signIn === 'signed_in' ? 'setup-row is-ready' : 'setup-row'} data-row={id === 'provider' ? 'sign-in' : `sign-in-${id}`}>
      <div className="setup-row-top">
        <span className="setup-glyph">{signIn === 'signed_in' ? <CheckIcon /> : <WaitIcon />}</span>
        <div className="setup-row-text">
          <strong>{t('Sign in to {provider}', { provider: label })}</strong>
          {signIn === 'required' && <p>{t('Sign in in a real terminal. Cats Bot only asks the CLI whether it is signed in and reads no credential files. You can skip this, but {name} cannot answer until you do.', { name: who })} {openTerminalNote}</p>}
          {signIn === 'unknown' && <p>{t('This CLI does not report whether it is signed in. Run this once if it is not; if it is, you need not.')} {powerShellLeft ? t('PowerShell scripts is not set up, so this opens in Command Prompt.') : ''} {openTerminalNote}</p>}
        </div>
        <span className={signIn === 'required' ? 'setup-row-state is-attention' : 'setup-row-state'}>
          {t(signIn === 'signed_in' ? 'Signed in' : signIn === 'required' ? 'Not signed in' : 'Cannot tell')}
        </span>
      </div>
      {signIn !== 'signed_in' && (
        <div className="setup-row-actions">
          {command && <CommandSnippet command={command} copyable />}
          <button type="button" id={`setup-open-terminal${id === 'provider' ? '' : `-${id}`}`} disabled={busy} onClick={onOpen}>{t('Open terminal and run')}</button>
          {terminal === 'opened' && <span className="hint">{t('Terminal opened.')}</span>}
          {terminal === 'missing' && <span className="hint warn" role="alert">{t('No terminal was found. Copy the command and run it in yours.')}</span>}
        </div>
      )}
    </li>
  );
}

/** SPEC-010 FR-15: Windows Codex's own first-time setup, which only a fresh check confirms. */
export function CodexSetupRow({ status, who, busy, terminal, onOpen }: {
  status: CodexInitialization['status'] | undefined;
  /** What can be done meanwhile: create a cat bot, or chat with the ones there are. */
  who: string | null;
  busy: boolean;
  terminal: 'opened' | 'missing' | null;
  onOpen(): void;
}) {
  const { t } = useI18n();
  return (
    <li className={status === 'ready' ? 'setup-row is-ready' : 'setup-row'} data-row="codex-initialization">
      <div className="setup-row-top">
        <span className="setup-glyph">{status === 'ready' ? <CheckIcon /> : <WaitIcon />}</span>
        <div className="setup-row-text">
          <strong>{t('Complete Codex first-time setup')}</strong>
          {status !== 'ready' && <p>{t('After signing in, open Codex and complete its Windows sandbox prompts. Exit Codex, then check again. Codex handles any administrator prompt and sandbox choices.')}</p>}
          {status === 'unavailable' && <p className="warn">{t('Could not verify Codex setup. Complete it in the terminal, then check again.')}</p>}
          {status !== 'ready' && <p>{who
            ? t('You can create {name} now. If Codex setup is incomplete, finish it before chatting.', { name: who })
            : t('Cat bots on Codex can wait for it, but finish it before they chat.')}</p>}
        </div>
        <span className={status === 'ready' ? 'setup-row-state' : 'setup-row-state is-attention'}>{t(status === 'ready' ? 'Ready' : status === 'unavailable' ? 'Cannot tell' : 'First-time setup needed')}</span>
      </div>
      {status !== 'ready' && <div className="setup-row-actions">
        <CommandSnippet command="codex" copyable />
        <button type="button" id="setup-open-codex" disabled={busy} onClick={onOpen}>{t('Open Codex first-time setup')}</button>
        {terminal === 'opened' && <span className="hint">{t('Terminal opened. Complete setup there, exit Codex, then check again.')}</span>}
        {terminal === 'missing' && <span className="hint warn" role="alert">{t('No terminal was found. Open Command Prompt in a working folder you trust and run codex.')}</span>}
      </div>}
    </li>
  );
}
