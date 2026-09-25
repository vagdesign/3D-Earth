import * as THREE from 'three';

// Lightweight HTML labels projected from 3D positions.
export class Labels {
  constructor(root) {
    this.root = root;
    this.items = new Map();
    this.v = new THREE.Vector3();
  }

  _el(id, cls, html) {
    let it = this.items.get(id);
    if (!it) {
      const el = document.createElement('div');
      el.className = `lbl ${cls}`;
      this.root.appendChild(el);
      it = { el, html: null, seen: true };
      this.items.set(id, it);
    }
    if (it.html !== html) { it.el.innerHTML = html; it.html = html; }
    it.seen = true;
    return it.el;
  }

  begin() { for (const it of this.items.values()) it.seen = false; }

  // world: position; dx/dy: pixel offset from the projected point.
  place(id, cls, html, world, camera, w, h, dx = 0, dy = 0, visible = true) {
    const el = this._el(id, cls, html);
    this.v.copy(world).project(camera);
    const on = visible && this.v.z < 1 && Math.abs(this.v.x) < 1.02 && Math.abs(this.v.y) < 1.02;
    if (!on) { el.style.opacity = 0; return; }
    const x = (this.v.x * 0.5 + 0.5) * w + dx;
    const y = (-this.v.y * 0.5 + 0.5) * h + dy;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    el.style.opacity = '';
  }

  end() {
    for (const [id, it] of this.items) {
      if (!it.seen) { it.el.remove(); this.items.delete(id); }
    }
  }

  clear() { this.begin(); this.end(); }
}

// True if the segment camera -> point is blocked by the Earth (unit sphere at origin).
export function hiddenByEarth(camPos, point) {
  const d = point.clone().sub(camPos);
  const len = d.length();
  d.divideScalar(len);
  const b = camPos.dot(d);
  const c = camPos.lengthSq() - 1;
  const disc = b * b - c;
  if (disc < 0) return false;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < len;
}
