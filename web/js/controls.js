// Interactive controls for the Preview / Explore windows (the desktop wallpaper
// itself never receives input - Windows sends it to the icons).
//   drag  : rotate freely around the Earth
//   W A S D / arrow keys : pan
//   + / - , Page Up / Page Down, mouse wheel : zoom
//   R / Home / double-click : reset      Esc : close (full-screen Explore)
import * as THREE from 'three';

export function createControls(canvas, { onClose } = {}) {
  const view = { zoom: 1, panX: 0, panY: 0, rotation: new THREE.Quaternion() };
  const keys = new Set();
  let drag = null;
  let pendingDX = 0, pendingDY = 0;

  const zoomBy = (f) => { view.zoom = THREE.MathUtils.clamp(view.zoom * f, 0.25, 12); };
  const reset = () => { view.zoom = 1; view.panX = 0; view.panY = 0; view.rotation.identity(); };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    pendingDX += e.clientX - drag.x;
    pendingDY += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
  });
  const endDrag = () => { drag = null; canvas.style.cursor = 'grab'; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', reset);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0012)); }, { passive: false });
  canvas.style.cursor = 'grab';

  const PAN_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (PAN_KEYS.includes(k)) { keys.add(k); e.preventDefault(); }
    else if (k === '+' || k === '=' || k === 'pageup') { zoomBy(1.12); e.preventDefault(); }
    else if (k === '-' || k === '_' || k === 'pagedown') { zoomBy(1 / 1.12); e.preventDefault(); }
    else if (k === 'r' || k === 'home') reset();
    else if (k === 'escape' && onClose) onClose();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  const axis = new THREE.Vector3();
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();

  // Call once per frame with the camera as framed last frame.
  function update(dt, camera, height) {
    const speed = 0.9 * dt / Math.sqrt(view.zoom);
    if (keys.has('a') || keys.has('arrowleft')) view.panX += speed;
    if (keys.has('d') || keys.has('arrowright')) view.panX -= speed;
    if (keys.has('w') || keys.has('arrowup')) view.panY -= speed;
    if (keys.has('s') || keys.has('arrowdown')) view.panY += speed;
    view.panX = THREE.MathUtils.clamp(view.panX, -3, 3);
    view.panY = THREE.MathUtils.clamp(view.panY, -3, 3);

    if (pendingDX || pendingDY) {
      // Surface follows the mouse: orbit the camera the opposite way.
      const k = (Math.PI / Math.max(height, 1)) / Math.sqrt(view.zoom);
      axis.set(0, 1, 0).applyQuaternion(camera.quaternion);
      qa.setFromAxisAngle(axis, -pendingDX * k);
      axis.set(1, 0, 0).applyQuaternion(camera.quaternion);
      qb.setFromAxisAngle(axis, -pendingDY * k);
      view.rotation.premultiply(qb).premultiply(qa).normalize();
      pendingDX = pendingDY = 0;
    }
    return view;
  }

  return { update, reset, view };
}
