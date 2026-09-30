import type { ReactNode } from 'react';

interface CardProps {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Card({ title, actions, children, className = '' }: CardProps) {
  return (
    <section
      className={`rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm backdrop-blur sm:p-5 dark:border-slate-800 dark:bg-slate-900/70 ${className}`}
    >
      {(title || actions) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{title}</h2>}
          {actions && <div className="flex items-center gap-1.5">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
