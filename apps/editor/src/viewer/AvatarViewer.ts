import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { Color3, Color4, Vector3 } from "@babylonjs/core/Maths/math.js";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import { Scene } from "@babylonjs/core/scene.js";
import { PBRMetallicRoughnessMaterial } from "@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";

// Side-effect import: registers the glTF loader with SceneLoader.
import "@babylonjs/loaders/glTF/2.0/index.js";

import { applyRecipe, loadAvatar, playAnimation } from "@tpb/avatar-runtime/babylon";
import type { LoadedAvatar } from "@tpb/avatar-runtime/babylon";
import type { SolveResult } from "@tpb/avatar-runtime";
import { computeSkinColor } from "@tpb/recipe";
import type { CharacterRecipe } from "@tpb/recipe";

const MESH_URL = "/generated/basemesh.glb";
const MANIFEST_URL = "/generated/basemesh.manifest.json";

/**
 * Owns the Babylon scene. Framework-free on purpose: React drives it through a
 * thin hook, and keeping the 3D code out of the component tree avoids
 * re-creating the engine on every render.
 */
export class AvatarViewer {
  private engine: Engine | null = null;
  private scene: Scene | null = null;
  private camera: ArcRotateCamera | null = null;
  private avatar: LoadedAvatar | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private skinMaterial: PBRMetallicRoughnessMaterial | null = null;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.09, 0.1, 0.12, 1);

    const camera = new ArcRotateCamera(
      "camera",
      Math.PI / 2,
      Math.PI / 2.35,
      3.4,
      new Vector3(0, 0.9, 0),
      scene,
    );
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 0.6;
    camera.upperRadiusLimit = 12;
    camera.wheelDeltaPercentage = 0.02;
    camera.minZ = 0.05;

    // Soft fill from above plus a key light, enough to read silhouette and form
    // without needing an HDR environment.
    const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
    ambient.intensity = 0.75;
    ambient.groundColor = new Color3(0.25, 0.26, 0.3);

    const key = new DirectionalLight("key", new Vector3(-0.5, -1, -0.6), scene);
    key.intensity = 1.8;
    key.position = new Vector3(3, 5, 3);

    const ground = CreateGround("ground", { width: 12, height: 12 }, scene);
    const groundMaterial = new StandardMaterial("groundMaterial", scene);
    groundMaterial.diffuseColor = new Color3(0.14, 0.15, 0.17);
    groundMaterial.specularColor = new Color3(0, 0, 0);
    ground.material = groundMaterial;

    this.engine = engine;
    this.scene = scene;
    this.camera = camera;

    this.avatar = await loadAvatar({ meshUrl: MESH_URL, manifestUrl: MANIFEST_URL, scene });
    this.skinMaterial = new PBRMetallicRoughnessMaterial("skin", scene);
    this.skinMaterial.metallic = 0;
    this.avatar.mesh.material = this.skinMaterial;

    engine.runRenderLoop(() => scene.render());

    // A ResizeObserver keeps the canvas correct when the side panel changes
    // width, which a window resize listener alone would miss.
    this.resizeObserver = new ResizeObserver(() => engine.resize());
    this.resizeObserver.observe(canvas);
  }

  /**
   * Flat PBR skin color driven by the recipe. There is no skin texture yet
   * (Phase 4), so this is a single tinted color rather than a photoreal
   * material, but it is a real function of skin.tone/tint/roughness rather
   * than a hardcoded placeholder.
   */
  private applySkin(recipe: CharacterRecipe): void {
    if (!this.skinMaterial) return;
    const { r, g, b } = computeSkinColor(recipe.skin);
    this.skinMaterial.baseColor = new Color3(r, g, b);
    this.skinMaterial.roughness = recipe.skin.roughness;
  }

  apply(recipe: CharacterRecipe): SolveResult | null {
    if (!this.avatar) return null;
    this.applySkin(recipe);
    return applyRecipe(this.avatar, recipe);
  }

  /** Points the camera at the whole body, given its real height. */
  frameBody(heightCm: number): void {
    if (!this.camera) return;
    const metres = heightCm / 100;
    this.camera.setTarget(new Vector3(0, metres * 0.55, 0));
    this.camera.radius = metres * 2.1;
  }

  /** Frames the head, for checking face parameters. */
  frameHead(heightCm: number): void {
    if (!this.camera) return;
    const metres = heightCm / 100;
    this.camera.setTarget(new Vector3(0, metres * 0.92, 0));
    this.camera.radius = metres * 0.45;
  }

  get animationNames(): string[] {
    return this.avatar ? [...this.avatar.animations.keys()] : [];
  }

  playAnimation(name: string): void {
    if (this.avatar) playAnimation(this.avatar, name);
  }

  get triangleCount(): number {
    return this.avatar ? this.avatar.mesh.getTotalIndices() / 3 : 0;
  }

  get boneCount(): number {
    return this.avatar?.skeleton?.bones.length ?? 0;
  }

  get fps(): number {
    return this.engine ? Math.round(this.engine.getFps()) : 0;
  }

  /**
   * Bakes the current pose into a standalone GLB and triggers a download.
   *
   * This is the "export" path referenced in the README: characters are
   * transmitted as a ~1 KB recipe at runtime, but a self-contained GLB is
   * useful for importing into another engine or sharing a one-off model.
   * Uses GLTF2Export.GLBAsync directly rather than shipping a helper function
   * on the class, since it needs no state beyond the live scene.
   */
  async exportGlb(filename: string): Promise<void> {
    if (!this.scene) throw new Error("Viewer not initialized");
    const { GLTF2Export } = await import("@babylonjs/serializers");
    const glb = await GLTF2Export.GLBAsync(this.scene, filename, {
      shouldExportNode: (node) => node.name !== "ground",
    });
    glb.downloadFiles();
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.engine?.stopRenderLoop();
    this.scene?.dispose();
    this.engine?.dispose();
    this.engine = null;
    this.scene = null;
    this.camera = null;
    this.avatar = null;
    this.skinMaterial = null;
  }
}
