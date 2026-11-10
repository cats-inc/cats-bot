import type { ReactNode } from 'react';

/**
 * The settings panels' layout: a group of rows, each a label with an optional
 * hint on the left and its control on the right (settings.css, `.set-row`).
 */

export function Group({ title, lead, id, className, children }: {
  title?: string;
  lead?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className ? `group ${className}` : 'group'} id={id}>
      {title && <h3>{title}</h3>}
      {lead && <p className="hint group-lead">{lead}</p>}
      <div className="rows">{children}</div>
    </section>
  );
}

export function Row({ label, hint, warn, htmlFor, id, hidden, tone, stack, children }: {
  label: ReactNode;
  hint?: ReactNode;
  /** The hint is a problem the owner should act on. */
  warn?: boolean;
  /** The control's id, so a click on the label reaches it. */
  htmlFor?: string;
  id?: string;
  hidden?: boolean;
  tone?: 'warn';
  /** The control is too wide to sit beside its label, so it takes the row's width under it. */
  stack?: boolean;
  children?: ReactNode;
}) {
  const className = ['set-row', tone ? `is-${tone}` : '', stack ? 'is-stack' : ''].filter(Boolean).join(' ');
  return (
    <div className={className} id={id} hidden={hidden}>
      <div className="set-row-text">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint && <small className={warn ? 'hint warn' : 'hint'}>{hint}</small>}
      </div>
      {children !== undefined && children !== null && <div className="set-row-control">{children}</div>}
    </div>
  );
}

/** A fact as a row: its label, and its value where a control would be. */
export function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Row label={label}>
      <span className="set-row-value">{value}</span>
    </Row>
  );
}
