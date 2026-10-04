import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import { fetchApiConfig } from '@/lib/api-config';
import '@/lib/desktop-bridge-types';

/**
 * Whole-instance read-only posture, mirrored from `/api/config` (`server.readOnly`).
 *
 * ADVISORY-VISIBLE ONLY: the context tells the GUI to grey out controls and
 * show a banner. The server already refuses every write across MCP/HTTP/collab
 * — the client never decides policy, it only reflects what the server reports.
 * Threaded exactly like {@link useSingleFileMode}.
 */
const ReadOnlyModeContext = createContext<boolean>(false);

export function ReadOnlyModeProvider({ children }: { children: ReactNode }) {
  const [readOnly, setReadOnly] = useState<boolean>(false);

  useEffect(() => {
    if (window.okDesktop) return;

    const controller = new AbortController();
    void fetchApiConfig(controller.signal)
      .then((result) => {
        if (controller.signal.aborted || result.status !== 'ok') return;
        setReadOnly(result.config.readOnly);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return <ReadOnlyModeContext value={readOnly}>{children}</ReadOnlyModeContext>;
}

export function useReadOnlyMode(): boolean {
  return use(ReadOnlyModeContext);
}
