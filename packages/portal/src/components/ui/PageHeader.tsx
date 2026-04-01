import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Crumb = { label: string; href?: string };

interface PageHeaderProps {
  title: string;
  breadcrumbs?: Crumb[];
  description?: string;
  actions?: ReactNode;
}

export default function PageHeader({ title, breadcrumbs, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400 mb-1">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && <span className="text-gray-300 dark:text-slate-600">/</span>}
              {crumb.href ? (
                <Link to={crumb.href} className="hover:text-gray-700 dark:hover:text-slate-200 transition-colors">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-gray-900 dark:text-slate-100">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
