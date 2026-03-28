interface PaginationProps {
  page: number;
  total: number;
  limit: number;
  onPage: (page: number) => void;
}

export function Pagination({ page, total, limit, onPage }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-white border-t">
      <p className="text-sm text-gray-500">
        {total} total · page {page} of {totalPages}
      </p>
      <div className="flex gap-2">
        <button
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="px-3 py-1 rounded border text-sm disabled:opacity-40 hover:bg-gray-50 transition-colors"
        >
          ← Prev
        </button>
        <button
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          className="px-3 py-1 rounded border text-sm disabled:opacity-40 hover:bg-gray-50 transition-colors"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
