import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { imageTarget, linkTarget } from './links.ts';
import './markdown.css';

/**
 * SPEC-003 FR-2, FR-3: a bot reply as GitHub-flavoured markdown. Raw HTML in
 * the reply is shown as text and unsafe URL schemes are dropped
 * (react-markdown's defaults); single newlines stay line breaks, as the
 * plain-text note showed them. No inline styles: the page CSP allows only
 * its own stylesheets.
 */

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

const COMPONENTS: Components = {
  a({ href, children }) {
    const target = linkTarget(href);
    if (target.kind === 'external') {
      // The shell's window-open handler gives http(s) to the system browser; the note never navigates.
      return (
        <a className="md-link" href={target.href} target="_blank" rel="noopener noreferrer" title={target.href}>
          {children}
        </a>
      );
    }
    return (
      <span className="md-inert-link" title={target.title}>
        {children}
      </span>
    );
  },
  img({ src, alt }) {
    const target = imageTarget(typeof src === 'string' ? src : undefined, alt);
    if (target.kind === 'external') {
      return (
        <a className="md-link" href={target.href} target="_blank" rel="noopener noreferrer" title={target.href}>
          {target.label}
        </a>
      );
    }
    return <span>{target.label}</span>;
  },
  table({ children }) {
    return (
      <div className="md-table-scroll">
        <table>{children}</table>
      </div>
    );
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
