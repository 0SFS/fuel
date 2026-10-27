import type { AircraftId } from "@0sfs/aircraft/aircraftIds";

export const F35B_STRUCTURAL_REFERENCE_IN = { x: 368.52, y: 0, z: -15.36 } as const;

export interface ExternalTankDefinition {
  index: number;
  label: string;
  attachmentProperty: string;
  capacityLbs: number;
  /** Provisional combined tank and pylon weight; both leave the aircraft together. */
  dryWeightLbs: number;
  /** JSBSim structural inches: aft, right, up. */
  locationIn: { x: number; y: number; z: number };
}

const tanksByAircraft = new Map<string, readonly ExternalTankDefinition[]>();

/** The aircraft mod says where a payload tank is mounted. The tank mod supplies capacity and dry mass. */
export function registerExternalTanks(aircraftId: string, tanks: readonly ExternalTankDefinition[]): void {
  tanksByAircraft.set(aircraftId, tanks);
}

export function getExternalTankDefinitions(aircraftId: AircraftId): readonly ExternalTankDefinition[] {
  return tanksByAircraft.get(aircraftId) ?? [];
}
