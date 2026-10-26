import "@babylonjs/loaders/glTF";
import {
  LoadAssetContainerAsync, Quaternion, TransformNode, Vector3,
  type AbstractMesh, type AssetContainer, type InstantiatedEntries, type Scene,
} from "@babylonjs/core";
import {
  projectReleasedStore, releaseStore, releasedPastBudget, stepReleasedStore, type ReleasedStore,
} from "@0sfs/stores/releasedStore";
import { whenMeshesReady } from "foss-earth/runtime";
import { F35B_STRUCTURAL_REFERENCE_IN, type ExternalTankDefinition } from "./externalTankDefinitions";

export interface ExternalTankVisualOptions {
  requestRender?(): void;
  /** Double-precision ECEF -> scene east/up/south frame from the floating origin. */
  getWorldFromEcef(): { readonly m: ArrayLike<number> } | null;
  lifetimeSeconds: number;
  maxDetachedTanks: number;
  loadContainer?(url: string, scene: Scene): Promise<AssetContainer>;
  whenReady?(meshes: readonly AbstractMesh[], signal: AbortSignal): Promise<void>;
}

export interface ExternalTankVisualHandle {
  readonly ready: Promise<void>;
  sync(tanks: readonly { index: number; attached: boolean }[]): void;
  /** Scene east/up/south ground velocity, metres per second. Tank and pylon leave together. */
  jettison(index: number, worldVelocity: Vector3): void;
  /** Accepted simulation time only; zero rebases existing debris without advancing it. */
  update(dtSeconds: number): void;
  setLifetimeSeconds(seconds: number): void;
  setMaxDetachedTanks(count: number): void;
  resetDetached(): void;
  dispose(): void;
}

interface TankSlot {
  definition: ExternalTankDefinition;
  attached: boolean;
  installation: TransformNode;
  detached: TransformNode;
  released: ReleasedStore | null;
}

const ASSET = "aircraft/f-35b/ExternalTank_FlightGear.glb";

/**
 * 0sfs owns the external aircraft equipment. The retained FlightGear asset is
 * prepared once, hidden; clones share its geometry and materials. Each station
 * has one reusable release slot, so repeated respawning cannot accumulate debris.
 * Released stores have visual-only ballistic motion, without collision or aerodynamics.
 */
export function createExternalTankVisuals(
  scene: Scene,
  parent: TransformNode,
  definitions: readonly ExternalTankDefinition[],
  options: ExternalTankVisualOptions,
): ExternalTankVisualHandle {
  const abort = new AbortController();
  let disposed = false, ready = false, serial = 0;
  let container: AssetContainer | null = null;
  const entries: InstantiatedEntries[] = [];
  let lifetime = Math.max(0, options.lifetimeSeconds);
  let maximum = Math.max(0, Math.min(definitions.length, Math.floor(options.maxDetachedTanks)));
  const slots: TankSlot[] = definitions.map(definition => {
    const installation = new TransformNode(`external-tank-${definition.index}-attached`, scene);
    installation.parent = parent;
    // The parent is the flight body frame: +X left,+Y up,+Z forward.
    const cg = F35B_STRUCTURAL_REFERENCE_IN;
    installation.position.set(-definition.locationIn.y * 0.0254,
      (definition.locationIn.z - cg.z) * 0.0254, (cg.x - definition.locationIn.x) * 0.0254);
    installation.setEnabled(false);
    const detached = new TransformNode(`external-tank-${definition.index}-detached`, scene);
    detached.rotationQuaternion = Quaternion.Identity();
    detached.setEnabled(false);
    return { definition, installation, detached, attached: false, released: null };
  });
  const requestRender = (): void => options.requestRender?.();
  const hideReleased = (slot: TankSlot): boolean => {
    const visible = slot.detached.isEnabled();
    slot.released = null;
    slot.detached.setEnabled(false);
    return visible;
  };
  const enforceBudget = (): boolean => {
    let changed = false;
    for (const slot of releasedPastBudget(slots, maximum, lifetime)) changed = hideReleased(slot) || changed;
    return changed;
  };
  const releaseResources = (): void => {
    for (const entry of entries.splice(0)) entry.dispose();
    for (const slot of slots) { slot.installation.dispose(); slot.detached.dispose(); }
    container?.dispose();
    container = null;
  };
  const prepare = async (): Promise<void> => {
    if (definitions.length === 0) { ready = true; return; }
    const base = (import.meta.env?.BASE_URL ?? "/") as string;
    const url = `${base.endsWith("/") ? base : base + "/"}${ASSET}`;
    try {
      const loaded = await (options.loadContainer ?? LoadAssetContainerAsync)(url, scene);
      if (disposed) { loaded.dispose(); return; }
      container = loaded;
      const meshes: AbstractMesh[] = [];
      for (const slot of slots) for (const holder of [slot.installation, slot.detached]) {
        const instance = loaded.instantiateModelsToScene(name => `${holder.name}-${name}`, false, { doNotInstantiate: true });
        entries.push(instance);
        for (const node of instance.rootNodes) node.parent = holder;
        for (const mesh of holder.getChildMeshes()) {
          mesh.isPickable = false;
          mesh.metadata = { ...mesh.metadata, aircraftVisualOnly: true, externalTankIndex: slot.definition.index };
          meshes.push(mesh);
        }
      }
      await (options.whenReady ?? ((meshes, signal) => whenMeshesReady(meshes, { signal })))(meshes, abort.signal);
      if (disposed) return;
      ready = true;
      let changed = false;
      for (const slot of slots) {
        slot.installation.setEnabled(slot.attached);
        changed = slot.installation.isEnabled() || changed;
      }
      if (changed) requestRender();
    } catch (error) {
      if (disposed) return;
      disposed = true;
      releaseResources();
      throw error;
    }
  };
  return {
    ready: prepare(),
    sync(tanks): void {
      if (disposed) return;
      let changed = false;
      for (const slot of slots) {
        const attached = tanks.find(tank => tank.index === slot.definition.index)?.attached ?? false;
        if (slot.attached === attached) continue;
        slot.attached = attached;
        const wasVisible = slot.installation.isEnabled();
        slot.installation.setEnabled(ready && attached);
        changed = wasVisible !== slot.installation.isEnabled() || changed;
      }
      if (changed) requestRender();
    },
    jettison(index, worldVelocity): void {
      if (disposed) return;
      const slot = slots.find(slot => slot.definition.index === index);
      if (!slot?.attached) return;
      const wasVisible = slot.installation.isEnabled();
      const frame = options.getWorldFromEcef();
      const released = ready && maximum > 0 && lifetime > 0 && frame
        ? releaseStore(slot.installation, worldVelocity, frame.m, serial + 1) : null;
      if (released && frame) {
        serial = released.serial;
        slot.released = released;
        projectReleasedStore(released, frame.m, slot.detached);
        slot.detached.setEnabled(true);
      }
      slot.attached = false;
      slot.installation.setEnabled(false);
      const budgetChanged = enforceBudget();
      if (wasVisible || slot.detached.isEnabled() || budgetChanged) requestRender();
    },
    update(dtSeconds): void {
      if (disposed) return;
      const frame = options.getWorldFromEcef();
      if (!frame) return;
      const dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
      let changed = false;
      for (const slot of slots) {
        const release = slot.released;
        if (!release) continue;
        // No visual time advances during pause; zero time only rebases.
        stepReleasedStore(release, dt);
        if (release.age >= lifetime) { changed = hideReleased(slot) || changed; continue; }
        changed = projectReleasedStore(release, frame.m, slot.detached) || changed;
      }
      if (changed) requestRender();
    },
    setLifetimeSeconds(seconds): void {
      if (disposed || !Number.isFinite(seconds)) return;
      lifetime = Math.max(0, seconds);
      if (enforceBudget()) requestRender();
    },
    setMaxDetachedTanks(count): void {
      if (disposed || !Number.isFinite(count)) return;
      maximum = Math.max(0, Math.min(slots.length, Math.floor(count)));
      if (enforceBudget()) requestRender();
    },
    resetDetached(): void {
      if (disposed) return;
      let changed = false;
      for (const slot of slots) changed = hideReleased(slot) || changed;
      if (changed) requestRender();
    },
    dispose(): void {
      if (disposed) return;
      const visible = slots.some(slot => slot.installation.isEnabled() || slot.detached.isEnabled());
      disposed = true;
      abort.abort();
      releaseResources();
      if (visible) requestRender();
    },
  };
}
