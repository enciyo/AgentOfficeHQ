// Furniture never moves, so its many small parts can be drawn as a few big meshes, one per material. What changes or
// needs its own object stays as it is: screens, textured and see-through parts, anything holding a light or a label.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

interface Part { geometry: THREE.BufferGeometry; material: THREE.Material; castShadow: boolean; receiveShadow: boolean }

const hitMaterial = new THREE.MeshBasicMaterial();

/** An invisible box that takes clicks for parts that are gone (rays hit invisible meshes too). */
function hitBox(box: THREE.Box3, itemId: unknown) {
  const hit = new THREE.Mesh(new THREE.BoxGeometry(...box.getSize(new THREE.Vector3()).toArray()), hitMaterial);
  box.getCenter(hit.position);
  hit.visible = false;
  hit.userData.itemId = itemId;
  return hit;
}

function mergeable(o: THREE.Object3D, kept: Set<THREE.Object3D>): o is THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  if (!(o instanceof THREE.Mesh) || kept.has(o) || o.children.length || Array.isArray(o.material)) return false;
  const material = o.material as THREE.MeshStandardMaterial;
  // A mirrored part would turn inside out
  return !material.transparent && !material.map && o.matrixWorld.determinant() > 0;
}

/** The part as plain triangles where its item stands. */
function placed(mesh: THREE.Mesh) {
  const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
  return geometry.applyMatrix4(mesh.matrixWorld);
}

/**
 * Takes the mergeable parts out of an item that is not attached to anything yet.
 * Returns them with the boxes that take the item's clicks from now on: one per thing with an id of its own inside it,
 * or else one for the item. An item that lost no parts needs none.
 */
export function takeParts(item: THREE.Object3D, kept: Set<THREE.Object3D> = new Set()) {
  item.updateMatrixWorld(true);
  const inner: THREE.Object3D[] = [];
  item.traverse(o => { if (o !== item && o.userData.itemId !== undefined) inner.push(o); });
  const boxes = (inner.length ? inner : [item]).map(o => ({ box: new THREE.Box3().setFromObject(o), id: o.userData.itemId }));
  const meshes: THREE.Mesh[] = [];
  item.traverse(o => { if (mergeable(o, kept)) meshes.push(o); });
  const parts: Part[] = meshes.map(m => ({ geometry: placed(m), material: m.material as THREE.Material, castShadow: m.castShadow, receiveShadow: m.receiveShadow }));
  meshes.forEach(m => m.removeFromParent());
  const hits = parts.length ? boxes.filter(b => !b.box.isEmpty()).map(b => hitBox(b.box, b.id)) : [];
  return { parts, hits };
}

/** One mesh per material and shadow setting. */
export function mergeParts(parts: Part[]) {
  const groups = new Map<string, Part[]>();
  for (const part of parts) {
    const key = `${part.material.uuid}:${part.castShadow}:${part.receiveShadow}`;
    groups.set(key, [...(groups.get(key) ?? []), part]);
  }
  return [...groups.values()].map(group => {
    const { material, castShadow, receiveShadow } = group[0]!;
    const mesh = new THREE.Mesh(mergeGeometries(group.map(p => p.geometry)), material);
    group.forEach(p => p.geometry.dispose());
    return Object.assign(mesh, { castShadow, receiveShadow });
  });
}
