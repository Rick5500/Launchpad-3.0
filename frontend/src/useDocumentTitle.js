import { useEffect } from 'react';

export const DEFAULT_DOCUMENT_TITLE = 'LaunchPad 3.0';

export function useDocumentTitle(title) {
  useEffect(() => {
    const previous = document.title;
    document.title = title || DEFAULT_DOCUMENT_TITLE;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
