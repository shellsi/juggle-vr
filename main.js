import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
// ─── Constants ───────────────────────────────────────────────────────
const EARTH_GRAVITY = 9.81;
const CATCH_RADIUS = 0.08;          // 8cm catch zone around each grip (spherical)
const BALL_RADIUS = 0.035;          // 3.5cm radius = 7cm diameter
const STACK_OFFSET = BALL_RADIUS;    // offset per stacked ball; top (next throw) at centre, others back
const FLOOR_Y = 0;
const BALL_RESET_Y = -0.5;          // Reset balls that fall below floor
const HAPTIC_INTENSITY = 0.6;
const HAPTIC_DURATION = 100;         // ms
const VELOCITY_HISTORY_SIZE = 6;    // frames to average for throw velocity
const THROW_VELOCITY_SCALE = 1.2;    // multiplier for throw feel
const MIN_THROW_UP = 1.5;           // minimum upward velocity on throw
const THROW_IMMUNITY_MS = 300;      // ms after throw before ball can be re-caught
const GRAVITY_MIN = 0.1;
const GRAVITY_MAX = 1.0;
const GRAVITY_ADJUST_SPEED = 0.4;   // how fast thumbstick adjusts gravity per second
const RAY_GRAB_MAX_DIST = 10;       // max raycast distance for trigger grab
const RAY_GRAB_ANGLE_THRESHOLD = 0.05; // radians — how close the ray must be to a ball center
const SLIDE_DURATION = 0.6;          // seconds to slide ball to hand after ray-grab

// ─── Mutable Game State ──────────────────────────────────────────────
let gravityMultiplier = 1.0;        // 0.1 to 1.0
let currentGravity = EARTH_GRAVITY; // computed each frame

// Auto-throw settings
let autoThrowEnabled = true;
const AUTO_THROW_MIN_VELOCITY = 0.6;   // m/s upward velocity required
const AUTO_THROW_MIN_HOLD_MS = 200;     // ms ball must be held before auto-throw
const AUTO_THROW_COOLDOWN_MS = 300;     // ms cooldown per hand after auto-throw
const ACCEL_SMOOTHING = 0.3;            // EMA alpha for acceleration smoothing
const ACCEL_UPSWING_THRESHOLD = 0.5;    // m/s² min accel to count as "was accelerating up"

// Flat plane constraint
let flatPlaneEnabled = true;

// Smoke trail settings
let trailEnabled = false;
const TRAIL_LENGTH = 800;               // number of points in trail buffer
const TRAIL_SCROLL_SPEED = 0.5;         // m/s backward scroll
const TRAIL_COLORS = [
  new THREE.Color(0.25, 0.25, 0.25),   // left hand: dark grey
  new THREE.Color(0.25, 0.25, 0.25),   // right hand: dark grey
];
const RIBBON_BASE_WIDTH = 0.002;        // base half-width of ribbon (5mm)
const RIBBON_PITCH_SCALE = 0.03;        // extra half-width per radian of pitch
// Ribbon width scales inversely with controller speed (m/s)
const RIBBON_SPEED_REF = 1.2;           // speed where width ~= base+pitch
const RIBBON_SPEED_EPS = 0.08;          // avoid division blow-up near 0
const RIBBON_HALF_WIDTH_MIN = 0.0006;   // clamp for stability (half-width)
const RIBBON_HALF_WIDTH_MAX = 0.01;     // clamp for stability (half-width)
const TRAIL_FREEZE_VELOCITY_THRESHOLD = 0.15;  // m/s — freeze trails when total controller velocity below this
const TRAIL_VELOCITY_REF = 1.0;  // m/s — scroll speed = TRAIL_SCROLL_SPEED when total velocity equals this

const BALL_COLORS = [
  0xff4466,  // warm red-pink
  0x44bbff,  // sky blue
  0xffcc33,  // golden yellow
  0x66ff88,  // mint green
  0xff88dd,  // hot pink
  0xffaa44,  // orange
  0x8866ff,  // purple
  0x44ffdd,  // teal
  0xff6644,  // coral
];
const MAX_BALLS = 9;
const MIN_BALLS = 1;
let targetBallCount = 3;            // adjustable via thumbstick
let ballCountCooldown = 0;          // prevents rapid add/remove

// ─── Scene Setup ─────────────────────────────────────────────────────
const scene = new THREE.Scene();

// Gradient sky
const skyGeo = new THREE.SphereGeometry(50, 32, 32);
const skyMat = new THREE.ShaderMaterial({
  uniforms: {
    topColor:    { value: new THREE.Color(0x0a0a2e) },
    bottomColor: { value: new THREE.Color(0x1a1a3e) },
    offset:      { value: 10 },
    exponent:    { value: 0.6 },
  },
  vertexShader: `
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    uniform float offset;
    uniform float exponent;
    varying vec3 vWorldPosition;
    void main() {
      float h = normalize(vWorldPosition + offset).y;
      gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
    }
  `,
  side: THREE.BackSide,
});
scene.add(new THREE.Mesh(skyGeo, skyMat));

// Starfield
const starCount = 800;
const starPositions = new Float32Array(starCount * 3);
for (let i = 0; i < starCount; i++) {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(Math.random() * 0.8 + 0.2); // upper hemisphere bias
  const r = 40 + Math.random() * 8;
  starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
  starPositions[i * 3 + 1] = r * Math.cos(phi);
  starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
}
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.08, sizeAttenuation: true });
scene.add(new THREE.Points(starGeo, starMat));

// Lighting
const ambientLight = new THREE.AmbientLight(0x404060, 0.8);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffeedd, 1.2);
dirLight.position.set(3, 8, 5);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 1024;
dirLight.shadow.mapSize.height = 1024;
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 20;
dirLight.shadow.camera.left = -3;
dirLight.shadow.camera.right = 3;
dirLight.shadow.camera.top = 3;
dirLight.shadow.camera.bottom = -3;
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(0x6688cc, 0.4);
fillLight.position.set(-3, 4, -5);
scene.add(fillLight);

// Ground plane
const groundGeo = new THREE.CircleGeometry(8, 64);
const groundMat = new THREE.MeshStandardMaterial({
  color: 0x181828,
  roughness: 0.85,
  metalness: 0.1,
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = FLOOR_Y;
ground.receiveShadow = true;
scene.add(ground);

// Subtle ground ring
const ringGeo = new THREE.RingGeometry(0.9, 1.0, 64);
const ringMat = new THREE.MeshBasicMaterial({
  color: 0x444466,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.4,
});
const ring = new THREE.Mesh(ringGeo, ringMat);
ring.rotation.x = -Math.PI / 2;
ring.position.y = FLOOR_Y + 0.001;
scene.add(ring);

// ─── Camera & Renderer ──────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

// VR Button — request hand-tracking as optional (put down controllers for hands)
const vrButton = VRButton.createButton(renderer, {
  optionalFeatures: ['hand-tracking'],
});
document.body.appendChild(vrButton);

// H key: cycle input mode (auto → hands → controllers) for switching
window.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') {
    const modes = ['auto', 'hands', 'controllers'];
    const i = modes.indexOf(inputMode);
    inputMode = modes[(i + 1) % modes.length];
    console.log('Input mode:', inputMode);
  }
});

// Resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Controllers & Hands ─────────────────────────────────────────────
const controllerModelFactory = new XRControllerModelFactory();
const handModelFactory = new XRHandModelFactory();
handModelFactory.setPath('https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/');

// Input mode: 'auto' = use whichever is active; 'hands' / 'controllers' = prefer that type
let inputMode = 'auto';

class ControllerState {
  constructor(index) {
    this.index = index;
    this.controller = renderer.xr.getController(index);
    this.grip = renderer.xr.getControllerGrip(index);
    this.hand = renderer.xr.getHand(index);

    this.grip.add(controllerModelFactory.createControllerModel(this.grip));
    this.hand.add(handModelFactory.createHandModel(this.hand, 'mesh'));
    scene.add(this.controller);
    scene.add(this.grip);
    scene.add(this.hand);

    // Effective pivot for catch zone (follows grip or hand wrist)
    this.effectiveGrip = new THREE.Group();
    scene.add(this.effectiveGrip);

    // Catch zone visual: sphere (same for controllers and hands)
    const catchZoneGeo = new THREE.SphereGeometry(CATCH_RADIUS, 16, 12);
    const catchZoneMat = new THREE.MeshBasicMaterial({
      color: 0x88aaff,
      transparent: true,
      opacity: 0.08,
      wireframe: true,
    });
    this.catchZone = new THREE.Mesh(catchZoneGeo, catchZoneMat);
    this.catchZone.visible = false;
    this.effectiveGrip.add(this.catchZone);

    // Laser pointer for trigger-grab (thin line from controller/hand)
    const laserGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -RAY_GRAB_MAX_DIST),
    ]);
    const laserMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.15,
    });
    this.laser = new THREE.Line(laserGeo, laserMat);
    this.laser.visible = false;
    this.controller.add(this.laser);

    // ─── Smoke Trail Ribbon ───
    this.trailBuffer = [];  // ring buffer of { pos: Vector3, time: number, quat: Quaternion }
    const ribbonVertCount = TRAIL_LENGTH * 2; // 2 vertices per trail point (left/right)
    const ribbonPositions = new Float32Array(ribbonVertCount * 3);
    const ribbonColors = new Float32Array(ribbonVertCount * 3);
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(ribbonPositions, 3));
    this.trailGeo.setAttribute('color', new THREE.BufferAttribute(ribbonColors, 3));

    // Pre-compute triangle indices for the ribbon quads
    const ribbonIndices = [];
    for (let i = 0; i < TRAIL_LENGTH - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      ribbonIndices.push(a, b, c, b, d, c);
    }
    this.trailGeo.setIndex(ribbonIndices);
    this.trailGeo.setDrawRange(0, 0);

    const ribbonMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.trailMesh = new THREE.Mesh(this.trailGeo, ribbonMat);
    this.trailMesh.frustumCulled = false;
    this.trailMesh.visible = false;
    scene.add(this.trailMesh);

    // Velocity tracking
    this.positionHistory = [];
    this.previousPos = new THREE.Vector3();
    this.velocity = new THREE.Vector3();

    // Angular velocity (rad/s) for ball spin transfer on release
    this.previousQuat = new THREE.Quaternion();
    this.previousQuatTime = 0;
    this.hasPreviousQuat = false;
    this.angularVelocity = new THREE.Vector3();

    // State
    this.heldBalls = [];
    this.gripping = false;
    this.triggering = false;
    this.inputSource = null;

    // Acceleration tracking for auto-throw
    this.prevVelocityY = 0;
    this.smoothedAccelY = 0;
    this.wasAcceleratingUp = false;
    this.autoThrowCooldownUntil = 0;

    // A/B-button state tracking (right), X-button (left)
    this.aButtonDown = false;
    this.bButtonDown = false;
    this.xButtonDown = false;
    this.trailsFrozen = false;

    // Hand-mode state (pinch = trigger, fist = grip)
    this.isHandTracking = false;
    this.handPinching = false;
    this.handGripping = false;

    // Events
    this.controller.addEventListener('connected', (event) => {
      this.inputSource = event.data;
    });
    this.controller.addEventListener('disconnected', () => {
      this.inputSource = null;
    });
  }

  updateInputPose() {
    try {
      const useHand = (inputMode === 'hands' && this.hand && this.hand.visible) ||
        ((inputMode === 'auto' || inputMode === 'controllers') && this.hand && this.hand.visible && this.grip && !this.grip.visible);
      this.isHandTracking = !!useHand;

      if (useHand && this.hand.joints) {
        const knuckle = this.hand.joints['middle-finger-phalanx-proximal'] || this.hand.joints['middle-finger-metacarpal'];
        const ref = knuckle ?? this.hand.joints['wrist'];
        if (ref && ref.visible) {
          if (this.effectiveGrip.parent !== ref) {
            this.effectiveGrip.removeFromParent();
            ref.add(this.effectiveGrip);
          }
          this.effectiveGrip.position.set(0, -BALL_RADIUS, 0);
          this.effectiveGrip.quaternion.identity();
          this.effectiveGrip.visible = true;
          this.catchZone.visible = false;
          this._updateHandGestures();
        } else {
          this.effectiveGrip.visible = false;
        }
      } else {
        if (this.effectiveGrip.parent !== scene) {
          this.effectiveGrip.removeFromParent();
          scene.add(this.effectiveGrip);
        }
        if (this.grip && this.grip.visible && this.grip.matrixWorld) {
          this.catchZone.visible = false;
          this.effectiveGrip.matrix.copy(this.grip.matrixWorld);
          this.effectiveGrip.matrix.decompose(
            this.effectiveGrip.position,
            this.effectiveGrip.quaternion,
            this.effectiveGrip.scale
          );
          const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.effectiveGrip.quaternion);
          this.effectiveGrip.position.addScaledVector(forward, 0.02);
          this.effectiveGrip.visible = true;
        } else {
          this.effectiveGrip.visible = false;
        }
      }
    } catch (err) {
      this.effectiveGrip.visible = false;
      this.isHandTracking = false;
    }
  }

  _updateHandGestures() {
    try {
      const hand = this.hand;
      if (!hand || !hand.joints) return;
      this.handPinching = !!(hand.inputState && hand.inputState.pinching);
      const indexTip = hand.joints['index-finger-tip'];
      const wrist = hand.joints['wrist'];
      if (indexTip && wrist && indexTip.visible && wrist.visible &&
          indexTip.position && wrist.position) {
        const dist = indexTip.position.distanceTo(wrist.position);
        this.handGripping = dist < 0.10;
      } else {
        this.handGripping = false;
      }
    } catch {
      this.handPinching = false;
      this.handGripping = false;
    }
  }

  updateVelocity(dt) {
    this.updateInputPose();
    if (!this.effectiveGrip.visible) return;
    const currentPos = new THREE.Vector3();
    this.effectiveGrip.getWorldPosition(currentPos);

    this.positionHistory.push({ pos: currentPos.clone(), time: performance.now() });
    if (this.positionHistory.length > VELOCITY_HISTORY_SIZE) {
      this.positionHistory.shift();
    }

    const prevVelY = this.velocity.y;

    if (this.positionHistory.length >= 2) {
      const oldest = this.positionHistory[0];
      const newest = this.positionHistory[this.positionHistory.length - 1];
      const elapsed = (newest.time - oldest.time) / 1000;
      if (elapsed > 0) {
        this.velocity.subVectors(newest.pos, oldest.pos).divideScalar(elapsed);
      }
    }

    // Compute smoothed Y acceleration (for auto-throw)
    if (dt > 0) {
      const rawAccelY = (this.velocity.y - prevVelY) / dt;
      this.smoothedAccelY += ACCEL_SMOOTHING * (rawAccelY - this.smoothedAccelY);
    }

    // Record trail position + orientation (skipped when total controller velocity below threshold)
    if (trailEnabled && !this.trailsFrozen) {
      const quat = new THREE.Quaternion();
      this.effectiveGrip.getWorldQuaternion(quat);
      this.trailBuffer.push({ pos: currentPos.clone(), time: performance.now(), quat: quat });
      if (this.trailBuffer.length > TRAIL_LENGTH) {
        this.trailBuffer.shift();
      }
    }

    // Angular velocity from quaternion delta (rad/s)
    const quat = new THREE.Quaternion();
    this.effectiveGrip.getWorldQuaternion(quat);
    const now = performance.now();
    if (this.hasPreviousQuat && this.previousQuatTime > 0) {
      const dtQ = (now - this.previousQuatTime) / 1000;
      if (dtQ > 0.0001) {
        const qPrevInv = this.previousQuat.clone().invert();
        const qDelta = quat.clone().multiply(qPrevInv);
        const w = Math.max(-1, Math.min(1, qDelta.w));
        const angle = 2 * Math.acos(w);
        const sinHalf = Math.sqrt(1 - w * w);
        if (sinHalf > 0.0001) {
          this.angularVelocity.set(qDelta.x, qDelta.y, qDelta.z).divideScalar(sinHalf).multiplyScalar(angle / dtQ);
        } else {
          this.angularVelocity.set(0, 0, 0);
        }
      }
    }
    this.previousQuat.copy(quat);
    this.previousQuatTime = now;
    this.hasPreviousQuat = true;
  }

  updateTrail(now) {
    if (!trailEnabled || this.trailBuffer.length < 2) {
      this.trailMesh.visible = false;
      return;
    }

    this.trailMesh.visible = true;
    const positions = this.trailGeo.attributes.position.array;
    const colors = this.trailGeo.attributes.color.array;
    const trailColor = TRAIL_COLORS[this.index];
    const count = this.trailBuffer.length;
    const maxAge = TRAIL_LENGTH / 72;

    const localRight = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const delta = new THREE.Vector3();
    let prevEntry = this.trailBuffer[0];

    for (let i = 0; i < count; i++) {
      const entry = this.trailBuffer[i];
      const age = (now - entry.time) / 1000;
      const fade = Math.max(0, 1.0 - (age / maxAge));

      const scrollDistance = age * trailScrollSpeed;
      const cx = entry.pos.x;
      const cy = entry.pos.y;
      const cz = entry.pos.z - scrollDistance;

      // Extract pitch from quaternion: forward vector's Y component = sin(pitch)
      forward.set(0, 0, -1).applyQuaternion(entry.quat);
      const pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)));

      // Approx per-sample speed (m/s) from neighbor points
      let speed = 0;
      if (i === 0 && count > 1) {
        const nextEntry = this.trailBuffer[1];
        const dtSeg = (nextEntry.time - entry.time) / 1000;
        if (dtSeg > 0) {
          speed = delta.subVectors(nextEntry.pos, entry.pos).length() / dtSeg;
        }
      } else if (i > 0) {
        const dtSeg = (entry.time - prevEntry.time) / 1000;
        if (dtSeg > 0) {
          speed = delta.subVectors(entry.pos, prevEntry.pos).length() / dtSeg;
        }
        prevEntry = entry;
      }

      // Width: pitch modulation, then scaled inversely with speed
      const pitchWidth = RIBBON_BASE_WIDTH + Math.max(0, -pitch) * RIBBON_PITCH_SCALE;
      const rawHalfWidth = pitchWidth * (RIBBON_SPEED_REF / (speed + RIBBON_SPEED_EPS));
      const halfWidth = Math.min(RIBBON_HALF_WIDTH_MAX, Math.max(RIBBON_HALF_WIDTH_MIN, rawHalfWidth));

      // Ribbon orientation follows controller's local X axis (rotated 90° from before)
      localRight.set(1, 0, 0).applyQuaternion(entry.quat).normalize();

      // Left and right vertices
      const li = i * 2 * 3;
      const ri = (i * 2 + 1) * 3;
      positions[li + 0] = cx + localRight.x * halfWidth;
      positions[li + 1] = cy + localRight.y * halfWidth;
      positions[li + 2] = cz + localRight.z * halfWidth;
      positions[ri + 0] = cx - localRight.x * halfWidth;
      positions[ri + 1] = cy - localRight.y * halfWidth;
      positions[ri + 2] = cz - localRight.z * halfWidth;

      // Color for both vertices (light grey, 0.3 opacity)
      const c0 = trailColor.r * fade * 0.3;
      const c1 = trailColor.g * fade * 0.3;
      const c2 = trailColor.b * fade * 0.3;
      colors[li + 0] = c0; colors[li + 1] = c1; colors[li + 2] = c2;
      colors[ri + 0] = c0; colors[ri + 1] = c1; colors[ri + 2] = c2;
    }

    // Draw (count-1) quads = (count-1)*6 indices
    this.trailGeo.setDrawRange(0, Math.max(0, (count - 1) * 6));
    this.trailGeo.attributes.position.needsUpdate = true;
    this.trailGeo.attributes.color.needsUpdate = true;
  }

  triggerHaptic(intensity = HAPTIC_INTENSITY, duration = HAPTIC_DURATION) {
    if (this.isHandTracking) return;
    if (!this.inputSource || !this.inputSource.gamepad) return;
    const gp = this.inputSource.gamepad;
    if (gp.hapticActuators && gp.hapticActuators.length > 0) {
      gp.hapticActuators[0].pulse(intensity, duration);
    }
    // Fallback for newer API
    if (gp.vibrationActuator) {
      gp.vibrationActuator.playEffect('dual-rumble', {
        duration: duration,
        strongMagnitude: intensity,
        weakMagnitude: intensity * 0.5,
      });
    }
  }

  isSqueezing() {
    if (this.isHandTracking) return this.handGripping;
    if (!this.inputSource || !this.inputSource.gamepad) return false;
    const gp = this.inputSource.gamepad;
    return gp.buttons.length > 1 && gp.buttons[1].pressed;
  }

  isTriggerPressed() {
    if (this.isHandTracking) return this.handPinching;
    if (!this.inputSource || !this.inputSource.gamepad) return false;
    const gp = this.inputSource.gamepad;
    return gp.buttons.length > 0 && gp.buttons[0].pressed;
  }

  // Get right thumbstick Y axis (used for gravity control)
  getThumbstickY() {
    if (this.isHandTracking) return 0;
    if (!this.inputSource || !this.inputSource.gamepad) return 0;
    const gp = this.inputSource.gamepad;
    if (gp.axes.length >= 4) return gp.axes[3];
    if (gp.axes.length >= 2) return gp.axes[1];
    return 0;
  }

  // Get right thumbstick X axis (used for ball count)
  getThumbstickX() {
    if (this.isHandTracking) return 0;
    if (!this.inputSource || !this.inputSource.gamepad) return 0;
    const gp = this.inputSource.gamepad;
    if (gp.axes.length >= 4) return gp.axes[2];
    if (gp.axes.length >= 2) return gp.axes[0];
    return 0;
  }

  // A button (buttons[4] on Quest right, buttons[4] on left too)
  isAButtonPressed() {
    if (this.isHandTracking) return false;
    if (!this.inputSource || !this.inputSource.gamepad) return false;
    const gp = this.inputSource.gamepad;
    return gp.buttons.length > 4 && gp.buttons[4].pressed;
  }

  // B button (buttons[5] on Quest right)
  isBButtonPressed() {
    if (this.isHandTracking) return false;
    if (!this.inputSource || !this.inputSource.gamepad) return false;
    const gp = this.inputSource.gamepad;
    return gp.buttons.length > 5 && gp.buttons[5].pressed;
  }

  // X button (buttons[4] on Quest left controller)
  isXButtonPressed() {
    if (this.isHandTracking) return false;
    if (!this.inputSource || !this.inputSource.gamepad) return false;
    const gp = this.inputSource.gamepad;
    return gp.buttons.length > 4 && gp.buttons[4].pressed;
  }
}

const controllers = [
  new ControllerState(0),
  new ControllerState(1),
];

// ─── Balls ───────────────────────────────────────────────────────────
function createCheckerTextures(colorHex) {
  const size = 64;
  const color = new THREE.Color(colorHex);
  const hex = '#' + color.getHexString();

  // Diffuse map: base color in 2 quadrants, near-black in other 2
  const mapCanvas = document.createElement('canvas');
  mapCanvas.width = size;
  mapCanvas.height = size;
  const mapCtx = mapCanvas.getContext('2d');
  mapCtx.fillStyle = hex;
  mapCtx.fillRect(0, 0, size / 2, size / 2);
  mapCtx.fillRect(size / 2, size / 2, size / 2, size / 2);
  mapCtx.fillStyle = '#000000';
  mapCtx.fillRect(size / 2, 0, size / 2, size / 2);
  mapCtx.fillRect(0, size / 2, size / 2, size / 2);

  // Emissive map: glow only on colored quadrants so dark areas stay dark
  const emitCanvas = document.createElement('canvas');
  emitCanvas.width = size;
  emitCanvas.height = size;
  const emitCtx = emitCanvas.getContext('2d');
  emitCtx.fillStyle = '#ffffff';
  emitCtx.fillRect(0, 0, size / 2, size / 2);
  emitCtx.fillRect(size / 2, size / 2, size / 2, size / 2);
  emitCtx.fillStyle = '#000000';
  emitCtx.fillRect(size / 2, 0, size / 2, size / 2);
  emitCtx.fillRect(0, size / 2, size / 2, size / 2);

  return {
    map: new THREE.CanvasTexture(mapCanvas),
    emissiveMap: new THREE.CanvasTexture(emitCanvas),
  };
}

class Ball {
  constructor(color, index) {
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 24, 18);
    const checker = createCheckerTextures(color);
    const mat = new THREE.MeshStandardMaterial({
      map: checker.map,
      emissiveMap: checker.emissiveMap,
      color: 0xffffff,
      roughness: 0.3,
      metalness: 0.5,
      emissive: color,
      emissiveIntensity: 0.1,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3(); // rad/s, from controller at release
    this.state = 'waiting'; // 'waiting', 'free', 'held', 'sliding'
    this.holder = null;     // controller reference if held
    this.index = index;
    this.throwImmunityUntil = 0; // timestamp: immune from auto-catch until this time
    this.holdStartTime = 0;      // when ball was last caught/held
    this.releaseZ = -0.4;        // Z coordinate to lock to when flat plane is on

    // Smoke trail for ball
    this.trailBuffer = [];
    const trailPositions = new Float32Array(TRAIL_LENGTH * 3);
    const trailColorsArr = new Float32Array(TRAIL_LENGTH * 3);
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
    this.trailGeo.setAttribute('color', new THREE.BufferAttribute(trailColorsArr, 3));
    this.trailGeo.setDrawRange(0, 0);
    const trailMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.trailLine = new THREE.Line(this.trailGeo, trailMat);
    this.trailLine.frustumCulled = false;
    this.trailLine.visible = false;
    this.trailColor = new THREE.Color(color);
    scene.add(this.trailLine);

    // Sliding state
    this.slideStartPos = new THREE.Vector3();
    this.slideStartTime = 0;
    this.slideTarget = null; // controller to slide toward

    // Start hidden
    this.mesh.position.set(0, -10, 0);
  }

  launch(x, y, z, vx, vy, vz) {
    this.mesh.position.set(x, y, z);
    this.velocity.set(vx, vy, vz);
    this.angularVelocity.set(0, 0, 0);
    this.mesh.quaternion.identity();
    this.state = 'free';
    this.holder = null;
    // Detach from any parent
    if (this.mesh.parent !== scene) {
      const worldPos = new THREE.Vector3();
      this.mesh.getWorldPosition(worldPos);
      scene.attach(this.mesh);
      this.mesh.position.copy(worldPos);
    }
  }

  startSlideTo(controller) {
    this.state = 'sliding';
    this.slideTarget = controller;
    this.slideStartTime = performance.now();
    // Detach from any parent first
    if (this.mesh.parent !== scene) {
      const worldPos = new THREE.Vector3();
      this.mesh.getWorldPosition(worldPos);
      scene.attach(this.mesh);
      this.mesh.position.copy(worldPos);
    }
    this.slideStartPos.copy(this.mesh.position);
    this.velocity.set(0, 0, 0);
    controller.heldBalls.push(this); // reserve the slot
    this.holder = controller;
  }

  attachTo(controller) {
    this.state = 'held';
    this.holder = controller;
    if (!controller.heldBalls.includes(this)) {
      controller.heldBalls.push(this);
    }
    // Parent to grip so it moves with the hand
    const worldPos = new THREE.Vector3();
    this.mesh.getWorldPosition(worldPos);
    controller.effectiveGrip.attach(this.mesh);
    // New ball at centre; reposition all held balls (existing ones shift back towards user)
    const n = controller.heldBalls.length;
    controller.heldBalls.forEach((b, i) => {
      const zOffset = (n - 1 - i) * STACK_OFFSET;
      b.mesh.position.set(0, 0, zOffset);
    });
    this.mesh.quaternion.identity();
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.holdStartTime = performance.now();
    // Stamp a final trail point at the catch position, then break the strip while held.
    if (trailEnabled) {
      const heldWorldPos = new THREE.Vector3();
      this.mesh.getWorldPosition(heldWorldPos);
      this.trailBuffer.push({ pos: heldWorldPos.clone(), time: performance.now() });
      this.trailBuffer.push(null);
      while (this.trailBuffer.length > TRAIL_LENGTH) this.trailBuffer.shift();
    }
  }

  release(throwVelocity) {
    if (this.holder) {
      this.angularVelocity.copy(this.holder.angularVelocity);
      const idx = this.holder.heldBalls.indexOf(this);
      if (idx !== -1) this.holder.heldBalls.splice(idx, 1);
      // Reposition remaining balls in stack (top at centre, others back)
      const n = this.holder.heldBalls.length;
      this.holder.heldBalls.forEach((b, i) => {
        const zOffset = (n - 1 - i) * STACK_OFFSET;
        b.mesh.position.set(0, 0, zOffset);
      });
    }
    const worldPos = new THREE.Vector3();
    this.mesh.getWorldPosition(worldPos);
    scene.attach(this.mesh);
    this.mesh.position.copy(worldPos);

    this.velocity.copy(throwVelocity).multiplyScalar(THROW_VELOCITY_SCALE);
    // Ensure some minimum upward velocity for forgiveness
    if (this.velocity.y < MIN_THROW_UP) {
      this.velocity.y = MIN_THROW_UP;
    }
    // Flat plane: lock Z at release point
    if (flatPlaneEnabled) {
      this.releaseZ = this.mesh.position.z;
      this.velocity.z = 0;
    }
    this.state = 'free';
    this.holder = null;
    this.throwImmunityUntil = performance.now() + THROW_IMMUNITY_MS;
  }

  update(dt) {
    if (this.state === 'sliding') {
      const elapsed = (performance.now() - this.slideStartTime) / 1000;
      const t = Math.min(elapsed / SLIDE_DURATION, 1.0);
      // Smooth ease-out
      const ease = 1 - Math.pow(1 - t, 3);

      // Slide toward the stacked position (top at centre, others back)
      const stackIndex = this.slideTarget.heldBalls.indexOf(this);
      const zOffset = (this.slideTarget.heldBalls.length - 1 - stackIndex) * STACK_OFFSET;
      const targetPos = new THREE.Vector3(0, 0, zOffset);
      this.slideTarget.effectiveGrip.localToWorld(targetPos);
      this.mesh.position.lerpVectors(this.slideStartPos, targetPos, ease);

      if (t >= 1.0) {
        // Arrived — snap to held and reposition all (new ball at centre, others shift back)
        this.state = 'held';
        this.slideTarget.effectiveGrip.attach(this.mesh);
        const n = this.slideTarget.heldBalls.length;
        this.slideTarget.heldBalls.forEach((b, i) => {
          const zOff = (n - 1 - i) * STACK_OFFSET;
          b.mesh.position.set(0, 0, zOff);
        });
        this.slideTarget = null;
      }
      return;
    }

    if (this.state !== 'free') return;

    this.velocity.y -= currentGravity * dt;
    this.mesh.position.x += this.velocity.x * dt;
    this.mesh.position.y += this.velocity.y * dt;

    // Apply angular velocity (spin from release)
    if (this.angularVelocity.lengthSq() > 1e-12) {
      const axis = this.angularVelocity.clone().normalize();
      const angle = this.angularVelocity.length() * dt;
      const deltaQ = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      this.mesh.quaternion.premultiply(deltaQ);
    }

    // Flat plane: constrain Z
    if (flatPlaneEnabled) {
      this.velocity.z = 0;
      this.mesh.position.z = this.releaseZ;
    } else {
      this.mesh.position.z += this.velocity.z * dt;
    }

    // Floor bounce
    if (this.mesh.position.y < FLOOR_Y + BALL_RADIUS) {
      this.mesh.position.y = FLOOR_Y + BALL_RADIUS;
      this.velocity.y = Math.abs(this.velocity.y) * 0.4; // damped bounce
      this.velocity.x *= 0.8;
      this.velocity.z *= 0.8;

      // Friction with floor reduces spin — lose ~80% of angular velocity per bounce
      this.angularVelocity.multiplyScalar(0.2);

      // If very slow, just stop bouncing and spinning
      if (Math.abs(this.velocity.y) < 0.3) {
        this.velocity.y = 0;
        this.angularVelocity.set(0, 0, 0);
      }
    }

    // Reset if ball goes way off
    if (this.mesh.position.y < BALL_RESET_Y ||
        Math.abs(this.mesh.position.x) > 10 ||
        Math.abs(this.mesh.position.z) > 10) {
      this.resetToSpawn();
    }

    // Record trail position (only in flight, not resting on ground)
    const isMoving = this.velocity.lengthSq() > 0.1;
    if (trailEnabled && isMoving) {
      this.trailBuffer.push({ pos: this.mesh.position.clone(), time: performance.now() });
      if (this.trailBuffer.length > TRAIL_LENGTH) {
        this.trailBuffer.shift();
      }
    }
  }

  updateTrail(now) {
    if (!trailEnabled || this.trailBuffer.length < 2) {
      this.trailLine.visible = false;
      return;
    }

    this.trailLine.visible = true;
    const positions = this.trailGeo.attributes.position.array;
    const colors = this.trailGeo.attributes.color.array;
    const count = this.trailBuffer.length;
    const maxAge = TRAIL_LENGTH / 72;

    for (let i = 0; i < count; i++) {
      const entry = this.trailBuffer[i];

      if (entry === null) {
        // Break marker: NaN creates a gap in the line strip
        positions[i * 3 + 0] = NaN;
        positions[i * 3 + 1] = NaN;
        positions[i * 3 + 2] = NaN;
        colors[i * 3 + 0] = 0;
        colors[i * 3 + 1] = 0;
        colors[i * 3 + 2] = 0;
        continue;
      }

      const age = (now - entry.time) / 1000;
      const fade = Math.max(0, 1.0 - (age / maxAge));

      const scrollDistance = age * trailScrollSpeed;
      positions[i * 3 + 0] = entry.pos.x;
      positions[i * 3 + 1] = entry.pos.y;
      positions[i * 3 + 2] = entry.pos.z - scrollDistance;

      colors[i * 3 + 0] = this.trailColor.r * fade * 0.7;
      colors[i * 3 + 1] = this.trailColor.g * fade * 0.7;
      colors[i * 3 + 2] = this.trailColor.b * fade * 0.7;
    }

    this.trailGeo.setDrawRange(0, count);
    this.trailGeo.attributes.position.needsUpdate = true;
    this.trailGeo.attributes.color.needsUpdate = true;
  }

  resetToSpawn() {
    // Relaunch from in front of the player
    const offset = (this.index - 1) * 0.15;
    this.launch(offset, 1.2, -0.4, 0, 3.0, 0);
  }
}

const balls = BALL_COLORS.slice(0, targetBallCount).map((color, i) => new Ball(color, i));

function addBall() {
  if (balls.length >= MAX_BALLS) return;
  const idx = balls.length;
  const ball = new Ball(BALL_COLORS[idx], idx);
  balls.push(ball);
  if (vrSessionActive && controllers.length >= 2) {
    const leftCount = controllers[0].heldBalls.length;
    const rightCount = controllers[1].heldBalls.length;
    const ctrl = rightCount <= leftCount ? controllers[1] : controllers[0];
    ball.attachTo(ctrl);
  } else {
    const xOff = (Math.random() - 0.5) * 0.2;
    ball.launch(xOff, 1.2, -0.4, 0, 0.5, 0);
  }
}

function removeBall() {
  if (balls.length <= MIN_BALLS) return;
  const ball = balls.pop();

  if (ball.state === 'held' && ball.holder) {
    const ctrl = ball.holder;
    const idx = ctrl.heldBalls.indexOf(ball);
    if (idx !== -1) ctrl.heldBalls.splice(idx, 1);
    ball.holder = null;
    const n = ctrl.heldBalls.length;
    ctrl.heldBalls.forEach((b, i) => {
      const zOffset = (n - 1 - i) * STACK_OFFSET;
      b.mesh.position.set(0, 0, zOffset);
    });
  } else if (ball.state === 'sliding' && ball.slideTarget) {
    const ctrl = ball.slideTarget;
    const idx = ctrl.heldBalls.indexOf(ball);
    if (idx !== -1) ctrl.heldBalls.splice(idx, 1);
    ball.slideTarget = null;
    ball.holder = null;
  }
  ball.mesh.parent?.remove(ball.mesh);
  scene.remove(ball.trailLine);
}

// ─── Game Logic ──────────────────────────────────────────────────────
let vrSessionActive = false;
let trailScrollSpeed = TRAIL_SCROLL_SPEED;  // scaled by total controller velocity

// Ground HUD — info panel on ground
function clearTrailBuffers() {
  for (const ctrl of controllers) {
    ctrl.trailBuffer.length = 0;
    ctrl.trailMesh.visible = false;
  }
  for (const ball of balls) {
    ball.trailBuffer.length = 0;
    ball.trailLine.visible = false;
  }
}

const hudCanvas = document.createElement('canvas');
hudCanvas.width = 768;
hudCanvas.height = 256;
const hudCtx = hudCanvas.getContext('2d');
const hudTexture = new THREE.CanvasTexture(hudCanvas);
const hudGeo = new THREE.PlaneGeometry(0.96, 0.32);
const hudMat = new THREE.MeshBasicMaterial({
  map: hudTexture,
  transparent: true,
  opacity: 0.9,
  side: THREE.DoubleSide,
});
const hudMesh = new THREE.Mesh(hudGeo, hudMat);
hudMesh.rotation.x = -Math.PI / 2;
hudMesh.position.set(0, FLOOR_Y + 0.002, -0.6);
scene.add(hudMesh);

// HUD ray interaction removed — use thumbstick (right) and buttons (A/B/X) for reliable control

function updateHUD() {
  const W = 768;
  const H = 256;
  hudCtx.clearRect(0, 0, W, H);
  hudCtx.fillStyle = 'rgba(12, 12, 35, 0.88)';
  hudCtx.roundRect(8, 8, W - 16, H - 16, 20);
  hudCtx.fill();
  hudCtx.strokeStyle = 'rgba(80, 120, 200, 0.4)';
  hudCtx.lineWidth = 2;
  hudCtx.stroke();

  const pct = Math.round(gravityMultiplier * 100);
  const autoLabel = autoThrowEnabled ? 'ON' : 'OFF';
  const planeLabel = flatPlaneEnabled ? 'ON' : 'OFF';
  const trailLabel = trailEnabled ? 'ON' : 'OFF';

  hudCtx.fillStyle = 'rgba(255,255,255,0.5)';
  hudCtx.font = '600 18px sans-serif';
  hudCtx.textAlign = 'center';
  hudCtx.textBaseline = 'middle';

  const leftCol1 = W * 0.15;
  const leftCol2 = W * 0.32;
  const rightCol1 = W * 0.52;
  const rightCol2 = W * 0.68;
  const rightCol3 = W * 0.85;
  const row1 = H * 0.35;
  const row2 = H * 0.65;

  hudCtx.fillText('AUTO-THROW', leftCol1, row1 - 28);
  hudCtx.fillText('FLAT PLANE', leftCol2, row1 - 28);
  hudCtx.fillText('GRAVITY ↕', rightCol1, row1 - 28);
  hudCtx.fillText('BALLS ↔', rightCol2, row1 - 28);
  hudCtx.fillText('TRAILS', rightCol3, row2 - 28);

  hudCtx.fillStyle = '#ffffff';
  hudCtx.font = 'bold 42px sans-serif';
  hudCtx.fillText(autoLabel, leftCol1, row1 + 6);
  hudCtx.fillText(planeLabel, leftCol2, row1 + 6);
  hudCtx.fillText(`${pct}%`, rightCol1, row1 + 6);
  hudCtx.fillText(`${balls.length}`, rightCol2, row1 + 6);
  hudCtx.fillText(trailLabel, rightCol3, row2 + 6);
  hudCtx.font = '12px sans-serif';
  hudCtx.fillStyle = 'rgba(255,255,255,0.35)';
  hudCtx.fillText('Right stick ↕↔: Gravity + Balls | Left X: Auto-throw | Left Y: Flat plane | Right A: Trails', W / 2, H - 18);
  hudTexture.needsUpdate = true;
}
updateHUD();

function distributeBallsToHands() {
  const leftCount = Math.floor(balls.length / 2);
  const rightCount = balls.length - leftCount;
  for (let i = 0; i < leftCount; i++) {
    balls[i].attachTo(controllers[0]);
  }
  for (let i = leftCount; i < balls.length; i++) {
    balls[i].attachTo(controllers[1]);
  }
}

renderer.xr.addEventListener('sessionstart', () => {
  vrSessionActive = true;
  distributeBallsToHands();
});

renderer.xr.addEventListener('sessionend', () => {
  vrSessionActive = false;
});

// Raycaster for trigger-grab
const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

function checkAutoCatch() {
  // Auto-catch: any free ball that enters a hand's catch zone is caught automatically (spherical)
  for (const ctrl of controllers) {
    if (ctrl.heldBalls.length >= balls.length) continue;
    if (!ctrl.effectiveGrip || !ctrl.effectiveGrip.visible) continue;

    const gripWorld = new THREE.Vector3();
    ctrl.effectiveGrip.getWorldPosition(gripWorld);

    let closestBall = null;
    let closestDist = Infinity;

    for (const ball of balls) {
      if (ball.state !== 'free') continue;
      if (performance.now() < ball.throwImmunityUntil) continue;
      const ballPos = new THREE.Vector3();
      ball.mesh.getWorldPosition(ballPos);
      const dist = gripWorld.distanceTo(ballPos);
      if (dist < CATCH_RADIUS && dist < closestDist) {
        closestDist = dist;
        closestBall = ball;
      }
    }

    if (closestBall) {
      closestBall.attachTo(ctrl);
      ctrl.triggerHaptic();
      // Flash the catch zone
    }
  }
}

function checkThrowOnGripRelease() {
  // Throw: release grip while hand is moving upward
  for (const ctrl of controllers) {
    const squeezing = ctrl.isSqueezing();
    const wasGripping = ctrl.gripping;

    if (squeezing && !wasGripping) {
      ctrl.gripping = true;
    }

    if (!squeezing && wasGripping) {
      ctrl.gripping = false;
      if (ctrl.heldBalls.length > 0 && ctrl.velocity.y > 0.1) {
        // Hand is moving upward — throw the topmost (furthest forward) ball
        const topBall = ctrl.heldBalls[ctrl.heldBalls.length - 1];
        topBall.release(ctrl.velocity);
      }
      // If hand is not moving upward, ball stays held (don't drop it)
    }
  }
}

function checkTriggerGrab() {
  for (const ctrl of controllers) {
    if (!ctrl) continue;
    const triggerPressed = ctrl.isTriggerPressed?.() ?? false;
    const src = ctrl.controller?.matrixWorld ?? ctrl.effectiveGrip?.matrixWorld;
    if (src) tempMatrix.identity().extractRotation(src);
    else tempMatrix.identity();
    const forward = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix);
    const pointingDown = forward.y < -0.2;

    if (ctrl.laser) {
      ctrl.laser.visible = (triggerPressed && ctrl.heldBalls.length < balls.length) || pointingDown;
      ctrl.laser.material.opacity = triggerPressed ? 0.7 : 0.15;
    }

    const hasSlidingToMe = balls.some(b => b.state === 'sliding' && b.slideTarget === ctrl);
    const canFetch = !hasSlidingToMe && ctrl.heldBalls.length < balls.length && (ctrl.controller?.matrixWorld || ctrl.effectiveGrip?.matrixWorld);
    if ((triggerPressed || pointingDown) && canFetch) {
      tempMatrix.identity().extractRotation(ctrl.controller?.matrixWorld ?? ctrl.effectiveGrip?.matrixWorld);
      const rayOrigin = new THREE.Vector3();
      (ctrl.controller ?? ctrl.effectiveGrip).getWorldPosition(rayOrigin);
      const rayDir = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();

      let bestBall = null;
      let bestDist = Infinity;
      const groundThreshold = FLOOR_Y + BALL_RADIUS + 0.05;

      for (const ball of balls) {
        if (ball.state !== 'free') continue;
        const ballPos = new THREE.Vector3();
        ball.mesh.getWorldPosition(ballPos);

        if (!triggerPressed && ballPos.y > groundThreshold) continue;

        const toBall = ballPos.clone().sub(rayOrigin);
        const projLen = toBall.dot(rayDir);
        if (projLen < 0 || projLen > RAY_GRAB_MAX_DIST) continue;

        const closest = rayOrigin.clone().add(rayDir.clone().multiplyScalar(projLen));
        const perpDist = closest.distanceTo(ballPos);

        if (perpDist < BALL_RADIUS + 0.08 && projLen < bestDist) {
          bestDist = projLen;
          bestBall = ball;
        }
      }

      if (bestBall) {
        bestBall.startSlideTo(ctrl);
        ctrl.triggerHaptic(0.3, 60);
      }
    }
  }
}

function updateGravityFromThumbstick(dt) {
  // Right controller (index 1) thumbstick
  const rightCtrl = controllers[1];
  const thumbY = rightCtrl.getThumbstickY();
  const thumbX = rightCtrl.getThumbstickX();

  // Y axis: gravity
  if (Math.abs(thumbY) > 0.15) {
    const oldMult = gravityMultiplier;
    gravityMultiplier -= thumbY * GRAVITY_ADJUST_SPEED * dt;
    gravityMultiplier = Math.max(GRAVITY_MIN, Math.min(GRAVITY_MAX, gravityMultiplier));
    if (Math.round(oldMult * 100) !== Math.round(gravityMultiplier * 100)) {
      updateHUD();
    }
  }
  currentGravity = EARTH_GRAVITY * gravityMultiplier;

  // X axis: ball count (with cooldown to prevent rapid fire)
  if (ballCountCooldown > 0) {
    ballCountCooldown -= dt;
  } else if (Math.abs(thumbX) > 0.7) { // strong push only
    if (thumbX > 0 && balls.length < MAX_BALLS) {
      addBall();
      updateHUD();
      ballCountCooldown = 0.35;
    } else if (thumbX < 0 && balls.length > MIN_BALLS) {
      removeBall();
      updateHUD();
      ballCountCooldown = 0.35;
    }
  }
}

// ─── Desktop Preview (non-VR) ────────────────────────────────────────
// Auto-launch balls in non-VR mode too for desktop preview
let desktopLaunched = false;
function desktopPreview() {
  if (vrSessionActive || desktopLaunched) return;
  desktopLaunched = true;
  balls.forEach((ball, i) => {
    setTimeout(() => {
      const side = i % 2 === 0 ? -1 : 1;
      ball.launch(
        (i - 1) * 0.2,
        0.8,
        -0.3,
        side * 0.8,
        4.0 + i * 0.3,
        0
      );
    }, i * 400);
  });
}

// Kick off desktop preview after a short delay
setTimeout(desktopPreview, 1000);

// ─── Auto-Throw ──────────────────────────────────────────────────────
function checkAutoThrow(now) {
  for (const ctrl of controllers) {
    if (ctrl.heldBalls.length === 0) {
      // Track acceleration state even when empty so it's ready
      ctrl.wasAcceleratingUp = ctrl.smoothedAccelY > ACCEL_UPSWING_THRESHOLD;
      continue;
    }

    // Cooldown check
    if (now < ctrl.autoThrowCooldownUntil) {
      ctrl.wasAcceleratingUp = ctrl.smoothedAccelY > ACCEL_UPSWING_THRESHOLD;
      continue;
    }

    const topBall = ctrl.heldBalls[ctrl.heldBalls.length - 1];

    // Min hold duration check
    if (now - topBall.holdStartTime < AUTO_THROW_MIN_HOLD_MS) {
      ctrl.wasAcceleratingUp = ctrl.smoothedAccelY > ACCEL_UPSWING_THRESHOLD;
      continue;
    }

    // Detect zero-crossing: was accelerating up, now decelerating
    const nowDecelerating = ctrl.smoothedAccelY < 0;

    if (ctrl.wasAcceleratingUp && nowDecelerating && ctrl.velocity.lengthSq() > 0.3) {
      // Auto-throw!
      topBall.release(ctrl.velocity);
      ctrl.autoThrowCooldownUntil = now + AUTO_THROW_COOLDOWN_MS;
    }

    // Update state for next frame
    ctrl.wasAcceleratingUp = ctrl.smoothedAccelY > ACCEL_UPSWING_THRESHOLD;
  }
}

function checkAutoThrowToggle() {
  const leftCtrl = controllers[0];
  const rightCtrl = controllers[1];

  // Left X: auto-throw
  const xPressed = leftCtrl.isXButtonPressed();
  if (xPressed && !leftCtrl.xButtonDown) {
    leftCtrl.xButtonDown = true;
    autoThrowEnabled = !autoThrowEnabled;
    updateHUD();
    leftCtrl.triggerHaptic(0.2, 50);
  }
  if (!xPressed) leftCtrl.xButtonDown = false;

  // Left Y: flat plane
  const leftBPressed = leftCtrl.isBButtonPressed();
  if (leftBPressed && !leftCtrl.bButtonDown) {
    leftCtrl.bButtonDown = true;
    flatPlaneEnabled = !flatPlaneEnabled;
    updateHUD();
    leftCtrl.triggerHaptic(0.2, 50);
  }
  if (!leftBPressed) leftCtrl.bButtonDown = false;

  // Right A: toggle trails
  const aPressed = rightCtrl.isAButtonPressed();
  if (aPressed && !rightCtrl.aButtonDown) {
    rightCtrl.aButtonDown = true;
    trailEnabled = !trailEnabled;
    if (!trailEnabled) clearTrailBuffers();
    updateHUD();
    rightCtrl.triggerHaptic(0.2, 50);
  }
  if (!aPressed && rightCtrl.aButtonDown) {
    rightCtrl.aButtonDown = false;
  }
}

// ─── Animation Loop ──────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05); // clamp dt to avoid spiral of death
  const now = performance.now();

  if (vrSessionActive) {
    try {
    // Balls start in hands (distributeBallsToHands on session start) — no auto-launch

    // Update controller velocities; freeze trails when total velocity below threshold; keep scroll speed constant
    const totalVel = (controllers[0]?.velocity?.length() ?? 0) + (controllers[1]?.velocity?.length() ?? 0);
    const trailsFrozen = totalVel < TRAIL_FREEZE_VELOCITY_THRESHOLD;
    // Keep velocity calculation but use constant scroll speed
    // trailScrollSpeed = TRAIL_SCROLL_SPEED * (totalVel / TRAIL_VELOCITY_REF);
    trailScrollSpeed = TRAIL_SCROLL_SPEED;
    for (const ctrl of controllers) {
      ctrl.trailsFrozen = trailsFrozen;
      ctrl.updateVelocity(dt);
    }

    // Gravity and ball count control (right thumbstick)
    updateGravityFromThumbstick(dt);

    // Auto-catch balls that enter hand proximity
    checkAutoCatch();

    // Throw on grip release (only when hand moving up)
    checkThrowOnGripRelease();

    // Trigger-grab: point and pull trigger to summon a ball
    checkTriggerGrab();

    // Auto-throw detection
    if (autoThrowEnabled) {
      checkAutoThrow(now);
    }

    checkAutoThrowToggle();

    // Update smoke trails
    for (const ctrl of controllers) {
      try { ctrl.updateTrail?.(now); } catch (_) {}
    }
    } catch (err) {
      console.warn('VR update error:', err);
    }
  }

  // Update ball physics
  for (const ball of balls) {
    ball.update(dt);
  }

  // Update ball trails (outside VR check so they render in desktop too)
  const trailNow = performance.now();
  for (const ball of balls) {
    ball.updateTrail(trailNow);
  }

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);
