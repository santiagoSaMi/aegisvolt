import { useOutletContext } from 'react-router';

import type { Viewer } from '../api/viewer.ts';

/** Identidad del usuario dentro de las páginas (la provee `AppShell`). */
export function useViewerContext(): Viewer {
  return useOutletContext<Viewer>();
}
