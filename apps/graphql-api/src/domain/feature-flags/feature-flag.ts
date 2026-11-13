import { InvalidValueError } from '../shared/domain-error.ts';

declare const brand: unique symbol;

/** Clave de una flag: MAYÚSCULAS_CON_GUIONES_BAJOS (p. ej. `ENABLE_FAST_CHARGE_BOOST`). */
export type FeatureFlagKey = string & { readonly [brand]: 'FeatureFlagKey' };
export const FeatureFlagKey = {
  parse: (raw: string): FeatureFlagKey => {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(raw)) {
      throw new InvalidValueError('key', 'debe ser MAYÚSCULAS_CON_GUIONES_BAJOS (3–64 caracteres)');
    }
    return raw as FeatureFlagKey;
  },
};

/** Quién hizo un cambio (sub/email del token del administrador). */
export type ActorId = string & { readonly [brand]: 'ActorId' };
export const ActorId = {
  parse: (raw: string): ActorId => {
    if (!/^\S{1,128}$/.test(raw)) {
      throw new InvalidValueError('actor', 'debe tener 1–128 caracteres sin espacios');
    }
    return raw as ActorId;
  },
};

/** Registro de auditoría de un cambio de flag (se persiste junto con la flag). */
export interface FlagChange {
  readonly key: FeatureFlagKey;
  readonly from: boolean;
  readonly to: boolean;
  readonly version: number;
  readonly changedBy: ActorId;
  readonly changedAt: Date;
}

export interface FeatureFlagProps {
  readonly key: FeatureFlagKey;
  readonly enabled: boolean;
  readonly description: string;
  readonly version: number;
  readonly updatedBy: ActorId;
  readonly updatedAt: Date;
}

/**
 * Feature flag de un ambiente (ADR-0007). Cada ambiente tiene su propia tabla:
 * el ambiente no es un atributo de la flag. Invariantes: descripción no vacía y
 * `version` ≥ 1, que crece en cada cambio efectivo (concurrencia optimista).
 */
export class FeatureFlag {
  static readonly MAX_DESCRIPTION_LENGTH = 280;

  readonly key: FeatureFlagKey;
  readonly enabled: boolean;
  readonly description: string;
  readonly version: number;
  readonly updatedBy: ActorId;
  readonly updatedAt: Date;

  private constructor(props: FeatureFlagProps) {
    this.key = props.key;
    this.enabled = props.enabled;
    this.description = props.description;
    this.version = props.version;
    this.updatedBy = props.updatedBy;
    this.updatedAt = props.updatedAt;
  }

  /** Definición inicial (la siembra Terraform con los valores de cada ambiente). */
  static define(input: {
    key: FeatureFlagKey;
    enabled: boolean;
    description: string;
    definedBy: ActorId;
    now: Date;
  }): FeatureFlag {
    return FeatureFlag.restore({
      key: input.key,
      enabled: input.enabled,
      description: input.description,
      version: 1,
      updatedBy: input.definedBy,
      updatedAt: input.now,
    });
  }

  static restore(props: FeatureFlagProps): FeatureFlag {
    const description = props.description.trim();
    if (description.length === 0 || description.length > FeatureFlag.MAX_DESCRIPTION_LENGTH) {
      throw new InvalidValueError(
        'description',
        `debe tener entre 1 y ${FeatureFlag.MAX_DESCRIPTION_LENGTH} caracteres`,
      );
    }
    if (!Number.isInteger(props.version) || props.version < 1) {
      throw new InvalidValueError('version', 'debe ser un entero ≥ 1');
    }
    return new FeatureFlag({ ...props, description });
  }

  /**
   * Cambia el estado. Si ya tiene ese valor no hay cambio ni auditoría
   * (idempotente); si cambia, sube la versión y devuelve el registro de auditoría.
   */
  setEnabled(
    enabled: boolean,
    actor: ActorId,
    now: Date,
  ): { flag: FeatureFlag; change: FlagChange | undefined } {
    if (enabled === this.enabled) {
      return { flag: this, change: undefined };
    }
    const flag = new FeatureFlag({
      key: this.key,
      description: this.description,
      enabled,
      version: this.version + 1,
      updatedBy: actor,
      updatedAt: now,
    });
    return {
      flag,
      change: {
        key: this.key,
        from: this.enabled,
        to: enabled,
        version: flag.version,
        changedBy: actor,
        changedAt: now,
      },
    };
  }
}
