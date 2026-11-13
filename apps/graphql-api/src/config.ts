import { loadBaseConfig, type BaseConfig, type EnvSource } from '@aegisvolt/config';

export const SERVICE_NAME = 'graphql-api';
export const DEFAULT_PORT = 4000;

export type ServiceConfig = BaseConfig;

export function loadServiceConfig(env: EnvSource): ServiceConfig {
  return loadBaseConfig(env, { serviceName: SERVICE_NAME, defaultPort: DEFAULT_PORT });
}
