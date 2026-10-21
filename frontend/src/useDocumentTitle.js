import { useEffect } from 'react';

export const DEFAULT_DOCUMENT_TITLE = 'Ignition';

export function useDocumentTitle(title) {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} · Ignition` : DEFAULT_DOCUMENT_TITLE;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
