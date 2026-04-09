import { useEffect, useMemo, useState } from 'react';
import type { PaginationProps } from '../components/ui/Pagination';

export default function usePagination<T>(items: T[], opts?: { pageSize?: number }): {
  page: number;
  pageItems: T[];
  total: number;
  totalPages: number;
  paginationProps: PaginationProps;
} {
  const pageSize = opts?.pageSize ?? 20;
  const [page, setPage] = useState(1);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstItem = items[0];

  useEffect(() => {
    setPage(1);
  }, [total, firstItem]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const pageItems = useMemo(() => {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  return {
    page,
    pageItems,
    total,
    totalPages,
    paginationProps: {
      page,
      total,
      pageSize,
      onPageChange: setPage,
    },
  };
}
