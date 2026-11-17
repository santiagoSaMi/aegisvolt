import type { ReactNode } from 'react';

import type { RuntimeConfig } from '../../config/runtime-config.ts';
import { RuntimeConfigContext } from './runtime-config-context.ts';

export function RuntimeConfigProvider({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: ReactNode;
}) {
  return <RuntimeConfigContext value={config}>{children}</RuntimeConfigContext>;
}
