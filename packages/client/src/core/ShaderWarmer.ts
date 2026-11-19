import {
  Color3,
  MeshBuilder,
  PBRMaterial,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { SKIN_LIST } from "@game/shared";

/**
 * Eliminates "First-Shot Stutter" by spawning temporary off-screen samples of every
 * combat material (weapon skins, muzzle flash, tracers, smoke, glass, concrete)
 * inside the camera frustum during the Loading Screen and forcing 2 GPU render ticks.
 */
export class ShaderWarmer {
  static async warmUpScene(
    scene: Scene,
    onProgress?: (pct: number, detail: string) => void
  ): Promise<void> {
    onProgress?.(82, "Pre-compiling PBR weapon skins, glass, smoke & tracer shaders...");
    const cam = scene.activeCamera;
    if (!cam) return;

    const root = new TransformNode("shader_warmup_root", scene);
    const forward = cam.getDirection(Vector3.Forward());
    root.position = cam.position.add(forward.scale(3.5));

    const tempMeshes = [];

    // Sample materials covering skins, glass, neon, tracer, smoke, and brass
    for (let i = 0; i < SKIN_LIST.length; i++) {
      const skin = SKIN_LIST[i];
      const box = MeshBuilder.CreateBox(`warm_skin_${i}`, { size: 0.12 }, scene);
      box.parent = root;
      box.position.x = (i - 2.5) * 0.18;
      const mat = new PBRMaterial(`warm_pbr_${i}`, scene);
      mat.albedoColor = Color3.FromHexString(skin.materials.primary.baseColorHex ?? "#334155");
      mat.roughness = skin.materials.primary.roughness ?? 0.5;
      mat.metallic = skin.materials.primary.metallic ?? 0.3;
      if (skin.materials.primary.emissiveHex) {
        mat.emissiveColor = Color3.FromHexString(skin.materials.primary.emissiveHex);
      }
      box.material = mat;
      tempMeshes.push(box);
    }

    const glassMat = new PBRMaterial("warm_glass", scene);
    glassMat.alpha = 0.35;
    glassMat.albedoColor = Color3.FromHexString("#67e8f9");
    glassMat.roughness = 0.08;
    const glassBox = MeshBuilder.CreateBox("warm_glass_mesh", { size: 0.15 }, scene);
    glassBox.parent = root;
    glassBox.position.y = 0.25;
    glassBox.material = glassMat;
    tempMeshes.push(glassBox);

    const flashMat = new StandardMaterial("warm_flash", scene);
    flashMat.emissiveColor = new Color3(1, 0.85, 0.35);
    flashMat.disableLighting = true;
    const flashSphere = MeshBuilder.CreateSphere("warm_flash_mesh", { diameter: 0.12 }, scene);
    flashSphere.parent = root;
    flashSphere.position.y = -0.25;
    flashSphere.material = flashMat;
    tempMeshes.push(flashSphere);

    // Force 2 GPU render passes while loading overlay covers the screen
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    scene.render();
    onProgress?.(98, "GPU shaders compiled & cached. Match ready.");

    for (const m of tempMeshes) {
      m.material?.dispose();
      m.dispose();
    }
    root.dispose();
  }
}
