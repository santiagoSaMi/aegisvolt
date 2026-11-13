import { InvalidValueError } from '../shared/domain-error.ts';
import type { StationId } from '../shared/identifiers.ts';
import type { City, GeoLocation } from './value-objects.ts';

export interface StationProps {
  readonly id: StationId;
  readonly name: string;
  readonly city: City;
  readonly location: GeoLocation;
}

/**
 * Electrolinera (datos de catálogo). Sus conectores son agregados propios
 * (`ChargingConnector`): la concurrencia de reservas es por conector.
 */
export class Station {
  static readonly MAX_NAME_LENGTH = 120;

  readonly id: StationId;
  readonly name: string;
  readonly city: City;
  readonly location: GeoLocation;

  private constructor(props: StationProps) {
    this.id = props.id;
    this.name = props.name;
    this.city = props.city;
    this.location = props.location;
  }

  static create(props: StationProps): Station {
    const name = props.name.trim();
    if (name.length === 0 || name.length > Station.MAX_NAME_LENGTH) {
      throw new InvalidValueError(
        'name',
        `debe tener entre 1 y ${Station.MAX_NAME_LENGTH} caracteres`,
      );
    }
    return new Station({ ...props, name });
  }
}
