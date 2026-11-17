import { InvalidValueError } from './domain-error.ts';

declare const brand: unique symbol;
type Brand<TValue, TName extends string> = TValue & { readonly [brand]: TName };

export type SessionId = Brand<string, 'SessionId'>;
export type SagaId = Brand<string, 'SagaId'>;
export type StationId = Brand<string, 'StationId'>;
export type ConnectorId = Brand<string, 'ConnectorId'>;

const ID_VALUE = '[a-z0-9][a-z0-9-]{0,62}';

function assertId(prefix: string, field: string, raw: string): void {
  if (!new RegExp(`^${prefix}_${ID_VALUE}$`).test(raw)) {
    throw new InvalidValueError(field, `debe tener el formato ${prefix}_<valor>`);
  }
}

export const SessionId = {
  parse: (raw: string): SessionId => {
    assertId('ses', 'sessionId', raw);
    return raw as SessionId;
  },
};
export const SagaId = {
  parse: (raw: string): SagaId => {
    assertId('saga', 'sagaId', raw);
    return raw as SagaId;
  },
};
export const StationId = {
  parse: (raw: string): StationId => {
    assertId('st', 'stationId', raw);
    return raw as StationId;
  },
};
export const ConnectorId = {
  parse: (raw: string): ConnectorId => {
    assertId('cn', 'connectorId', raw);
    return raw as ConnectorId;
  },
};
