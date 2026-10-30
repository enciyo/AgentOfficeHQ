// Merging furniture parts: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeParts, takeParts } from './mergeStatics.ts';

const solid = new THREE.MeshStandardMaterial();
const box = () => new THREE.BoxGeometry(1, 1, 1);

function item(id = 'i1', ...parts: THREE.Object3D[]) {
  const g = new THREE.Group();
  g.userData.itemId = id;
  g.add(...parts);
  return g;
}

test('parts with the same material become one mesh, in place, and a box takes the item\'s clicks', () => {
  const a = new THREE.Mesh(box(), solid);
  const b = new THREE.Mesh(box(), solid);
  b.position.x = 3;
  const g = item('i1', a, b);
  g.position.z = 5;
  const { parts, hits } = takeParts(g);
  assert.equal(g.children.length, 0);
  const merged = mergeParts(parts);
  assert.equal(merged.length, 1);
  merged[0]!.geometry.computeBoundingBox();
  const { min, max } = merged[0]!.geometry.boundingBox!;
  assert.deepEqual([min.x, max.x, min.z, max.z], [-0.5, 3.5, 4.5, 5.5]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.userData.itemId, 'i1');
  assert.equal(hits[0]!.visible, false);
  hits[0]!.updateMatrixWorld();
  assert.equal(new THREE.Raycaster(new THREE.Vector3(0, 5, 5), new THREE.Vector3(0, -1, 0)).intersectObject(hits[0]!).length, 1);
});

test('what must stay its own object stays', () => {
  const screen = new THREE.Mesh(box(), solid);
  const glass = new THREE.Mesh(box(), new THREE.MeshStandardMaterial({ transparent: true }));
  const textured = new THREE.Mesh(box(), new THREE.MeshStandardMaterial({ map: new THREE.Texture() }));
  const lit = new THREE.Mesh(box(), solid);
  lit.add(new THREE.PointLight());
  const mirrored = new THREE.Mesh(box(), solid);
  mirrored.scale.x = -1;
  const g = item('i1', screen, glass, textured, lit, mirrored);
  const { parts, hits } = takeParts(g, new Set([screen]));
  assert.equal(parts.length, 0);
  assert.equal(hits.length, 0); // nothing left the item, so its own parts still take clicks
  assert.equal(g.children.length, 5);
});

test('things with an id of their own inside an item keep their own click box', () => {
  const seat = new THREE.Group();
  seat.userData.itemId = 'seat';
  seat.add(new THREE.Mesh(box(), solid));
  const { hits } = takeParts(item('table', seat, new THREE.Mesh(box(), solid)));
  assert.deepEqual(hits.map(h => h.userData.itemId), ['seat']);
});

test('shadow settings are kept apart', () => {
  const lit = new THREE.Mesh(box(), solid);
  lit.castShadow = true;
  const { parts } = takeParts(item('i1', lit, new THREE.Mesh(box(), solid)));
  assert.deepEqual(mergeParts(parts).map(m => m.castShadow).sort(), [false, true]);
});
