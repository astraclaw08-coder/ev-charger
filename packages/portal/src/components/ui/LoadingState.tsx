import { cn } from '../../lib/utils';

function Shimmer({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-lg bg-gray-200 dark:bg-slate-700',
        className,
      )}
    />
  );
}

export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5', className)}>
      <Shimmer className="h-4 w-24 mb-3" />
      <Shimmer className="h-8 w-32 mb-2" />
      <Shimmer className="h-3 w-20" />
    </div>
  );
}

export function StatCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5', className)}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <Shimmer className="h-3.5 w-20 mb-2" />
          <Shimmer className="h-7 w-28" />
        </div>
        <Shimmer className="h-10 w-10 rounded-lg" />
      </div>
    </div>
  );
}

export function TableRowSkeleton({ columns = 5, className }: { columns?: number; className?: string }) {
  return (
    <tr className={className}>
      {Array.from({ length: columns }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Shimmer className={cn('h-4', i === 0 ? 'w-32' : 'w-20')} />
        </td>
      ))}
    </tr>
  );
}

export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200 dark:border-slate-700">
            {Array.from({ length: columns }).map((_, i) => (
              <th key={i} className="px-4 py-3 text-left">
                <Shimmer className="h-3 w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRowSkeleton key={i} columns={columns} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Shimmer className="h-4 w-32 mb-2" />
        <Shimmer className="h-8 w-64 mb-1" />
        <Shimmer className="h-4 w-48" />
      </div>
      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
      {/* Table */}
      <TableSkeleton />
    </div>
  );
}
