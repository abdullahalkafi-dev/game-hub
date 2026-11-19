import { Color3, MeshBuilder, StandardMaterial, type Mesh, type Scene } from "@babylonjs/core";
import type { ArenaPickup } from "@game/shared";

export class ArenaPickupsView {
  private readonly meshes = new Map<string, Mesh>();

  constructor(private readonly scene: Scene) {}

  sync(pickups: readonly ArenaPickup[]): void {
    for (const pickup of pickups) {
      let mesh = this.meshes.get(pickup.id);
      if (!mesh) {
        mesh = MeshBuilder.CreateBox(`arena_pickup_${pickup.id}`, { width: 0.6, height: 0.29, depth: 0.42 }, this.scene);
        const material = new StandardMaterial(`arena_pickup_mat_${pickup.id}`, this.scene);
        const color = Color3.FromHexString(pickup.kind === "armor" ? "#40cfff" : "#ffbb35");
        material.diffuseColor = color.scale(0.55);
        material.emissiveColor = color.scale(0.46);
        mesh.isPickable = false;
        mesh.material = material;
        const marker = MeshBuilder.CreateCylinder(`arena_pickup_marker_${pickup.id}`, { height: 0.042, diameter: 0.38, tessellation: pickup.kind === "armor" ? 5 : 4 }, this.scene);
        marker.parent = mesh;
        marker.position.y = 0.18;
        marker.material = material;
        marker.isPickable = false;
        this.meshes.set(pickup.id, mesh);
      }
      mesh.position.set(pickup.position.x, pickup.position.y + 0.18, pickup.position.z);
      mesh.setEnabled(pickup.available);
    }
    for (const [id, mesh] of this.meshes) {
      if (!pickups.some((item) => item.id === id)) mesh.setEnabled(false);
    }
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.dispose(false, true);
    this.meshes.clear();
  }
}
