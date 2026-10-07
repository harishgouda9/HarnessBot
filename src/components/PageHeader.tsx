import type { ReactNode } from 'react';

/**
 * Shared title row for workspace pages. Actions sit on the right and wrap
 * under the title when the window is narrow.
 */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3 hairline" style={{ background: 'var(--color-panel)' }}>
      <div className="min-w-0 flex-1">
        <h1 className="text-[15px] font-semibold">{title}</h1>
        {description ? (
          <p className="mt-0.5 max-w-xl text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </header>
  );
}
