import { Outlet } from 'react-router';

import type { Viewer } from '../../src/shared/api/viewer.ts';

/** Layout de prueba: entrega el viewer como hace AppShell. */
export function ViewerOutlet({ viewer }: { viewer: Viewer }) {
  return <Outlet context={viewer} />;
}
