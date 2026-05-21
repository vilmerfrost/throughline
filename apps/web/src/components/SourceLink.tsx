import type { ReactNode } from 'react';
import type { SourceRef } from '@throughline/core';
import type { ExplainSource } from '../lib/api';

type LinkableSource = SourceRef | ExplainSource;

interface SourceLinkProps {
  source: LinkableSource;
  className?: string;
  children?: ReactNode;
}

export function sourceLabel(source: LinkableSource): string {
  return 'label' in source
    ? source.label
    : `${source.filePath}:${source.startLine}${
        source.endLine !== source.startLine ? `-${source.endLine}` : ''
      }`;
}

export function SourceLink({ source, className, children }: SourceLinkProps) {
  const label = sourceLabel(source);
  const uri = 'uri' in source ? source.uri : undefined;

  if (!uri) {
    return <span className={className}>{children ?? label}</span>;
  }

  return (
    <a
      href={uri}
      onClick={(event) => {
        event.preventDefault();
        window.location.href = uri;
      }}
      className={`${className ?? ''} underline decoration-neutral-700 underline-offset-2 transition hover:text-neutral-100 hover:decoration-neutral-300`}
      title="Open source file in Cursor"
    >
      {children ?? label}
    </a>
  );
}
