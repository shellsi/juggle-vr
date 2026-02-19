import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// ─── Constants ───────────────────────────────────────────────────────
const EARTH_GRAVITY = 9.81;
const CATCH_RADIUS = 0.09;          // 9cm catch zone around each grip
const BALL_RADIUS = 0.04;           // 4cm radius juggling ball
const STACK_OFFSET = BALL_RADIUS;    // forward offset per stacked ball (overlaps by radius)
const FLOOR_Y = 0;
const BALL_RESET_Y = -0.5;          // Reset balls that fall below floor
const HAPTIC_INTENSITY = 0.6;
const HAPTIC_DURATION = 100;         // ms
const VELOCITY_HISTORY_SIZE = 10;    // frames to average for throw velocity
const THROW_VELOCITY_SCALE = 1.2;    // multiplier for throw feel
const MIN_THROW_UP = 1.5;           // minimum upward velocity on throw
const CASCADE_INTERVAL = 0.25;      // seconds between auto-launch balls
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

// VR Button
const vrButton = VRButton.createButton(renderer);
document.body.appendChild(vrButton);

// Resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Controllers ─────────────────────────────────────────────────────
const controllerModelFactory = new XRControllerModelFactory();

class ControllerState {
  constructor(index) {
    this.index = index;
    this.controller = renderer.xr.getController(index);
    this.grip = renderer.xr.getControllerGrip(index);
    this.grip.add(controllerModelFactory.createControllerModel(this.grip));
    scene.add(this.controller);
    scene.add(this.grip);

    // Catch zone visual
    const catchZoneGeo = new THREE.SphereGeometry(CATCH_RADIUS, 16, 12);
    const catchZoneMat = new THREE.MeshBasicMaterial({
      color: 0x88aaff,
      transparent: true,
      opacity: 0.08,
      wireframe: true,
    });
    this.catchZone = new THREE.Mesh(catchZoneGeo, catchZoneMat);
    this.grip.add(this.catchZone);

    // Laser pointer for trigger-grab (thin line from controller)
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

    // Velocity tracking
    this.positionHistory = [];
    this.previousPos = new THREE.Vector3();
    this.velocity = new THREE.Vector3();

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

    // A/B-button state tracking
    this.aButtonDown = false;
    this.bButtonDown = false;

    // Events
    this.controller.addEventListener('connected', (event) => {
      this.inputSource = event.data;
    });
    this.controller.addEventListener('disconnected', () => {
      this.inputSource = null;
    });
  }

  updateVelocity(dt) {
    const currentPos = new THREE.Vector3();
    this.grip.getWorldPosition(currentPos);

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
  }

  triggerHaptic(intensity = HAPTIC_INTENSITY, duration = HAPTIC_DURATION) {
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
    if (!this.inputSource || !this.inputSource.gamepad) return false;
    const gp = this.inputSource.gamepad;
    return gp.buttons.length > 1 && gp.buttons[1].pressed; // grip/squeeze
  }

  isTriggerPressed() {
    if (!this.inputSource || !this.inputSource.gamepad) return false;
    const gp = this.inputSource.gamepad;
    return gp.buttons.length > 0 && gp.buttons[0].pressed; // trigger
  }

  // Get right thumbstick Y axis (used for gravity control)
  getThumbstickY() {
    if (!this.inputSource || !this.inputSource.gamepad) return 0;
    const gp = this.inputSource.gamepad;
    if (gp.axes.length >= 4) return gp.axes[3];
    if (gp.axes.length >= 2) return gp.axes[1];
    return 0;
  }

  // Get right thumbstick X axis (used for ball count)
  getThumbstickX() {
    if (!this.inputSource || !this.inputSource.gamepad) return 0;
    const gp = this.inputSource.gamepad;
    if (gp.axes.length >= 4) return gp.axes[2];
    if (gp.axes.length >= 2) return gp.axes[0];
    return 0;
  }

  // A button (buttons[4] on Quest right, buttons[4] on left too)
  isAButtonPressed() {
    if (!this.inputSource || !this.inputSource.gamepad) return false;
    const gp = this.inputSource.gamepad;
    return gp.buttons.length > 4 && gp.buttons[4].pressed;
  }

  // B button (buttons[5] on Quest right)
  isBButtonPressed() {
    if (!this.inputSource || !this.inputSource.gamepad) return false;
    const gp = this.inputSource.gamepad;
    return gp.buttons.length > 5 && gp.buttons[5].pressed;
  }
}

const controllers = [
  new ControllerState(0),
  new ControllerState(1),
];

// ─── Balls ───────────────────────────────────────────────────────────
class Ball {
  constructor(color, index) {
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 24, 18);
    const mat = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.3,
      metalness: 0.5,
      emissive: color,
      emissiveIntensity: 0.1,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // Glow
    const glowGeo = new THREE.SphereGeometry(BALL_RADIUS * 1.5, 16, 12);
    const glowMat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.12,
    });
    this.glow = new THREE.Mesh(glowGeo, glowMat);
    this.mesh.add(this.glow);

    this.velocity = new THREE.Vector3();
    this.state = 'waiting'; // 'waiting', 'free', 'held', 'sliding'
    this.holder = null;     // controller reference if held
    this.index = index;
    this.throwImmunityUntil = 0; // timestamp: immune from auto-catch until this time
    this.holdStartTime = 0;      // when ball was last caught/held
    this.releaseZ = -0.4;        // Z coordinate to lock to when flat plane is on

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
    controller.grip.attach(this.mesh);
    // Offset forward based on stack position
    const stackIndex = controller.heldBalls.indexOf(this);
    this.mesh.position.set(0, 0, -stackIndex * STACK_OFFSET);
    this.velocity.set(0, 0, 0);
    this.holdStartTime = performance.now();
  }

  release(throwVelocity) {
    if (this.holder) {
      const idx = this.holder.heldBalls.indexOf(this);
      if (idx !== -1) this.holder.heldBalls.splice(idx, 1);
      // Reposition remaining balls in stack
      this.holder.heldBalls.forEach((b, i) => {
        b.mesh.position.set(0, 0, -i * STACK_OFFSET);
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

      // Slide toward the stacked position (offset forward from grip)
      const stackIndex = this.slideTarget.heldBalls.indexOf(this);
      const targetPos = new THREE.Vector3(0, 0, -stackIndex * STACK_OFFSET);
      this.slideTarget.grip.localToWorld(targetPos);
      this.mesh.position.lerpVectors(this.slideStartPos, targetPos, ease);

      if (t >= 1.0) {
        // Arrived — snap to held
        this.state = 'held';
        this.slideTarget.grip.attach(this.mesh);
        this.mesh.position.set(0, 0, -stackIndex * STACK_OFFSET);
        this.slideTarget = null;
      }

      // Glow pulse
      const gt = performance.now() * 0.003 + this.index * 2;
      this.glow.material.opacity = 0.08 + Math.sin(gt) * 0.04;
      return;
    }

    if (this.state !== 'free') return;

    this.velocity.y -= currentGravity * dt;
    this.mesh.position.x += this.velocity.x * dt;
    this.mesh.position.y += this.velocity.y * dt;

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

      // If very slow, just stop bouncing
      if (Math.abs(this.velocity.y) < 0.3) {
        this.velocity.y = 0;
      }
    }

    // Reset if ball goes way off
    if (this.mesh.position.y < BALL_RESET_Y ||
        Math.abs(this.mesh.position.x) > 10 ||
        Math.abs(this.mesh.position.z) > 10) {
      this.resetToSpawn();
    }

    // Glow pulse
    const t = performance.now() * 0.003 + this.index * 2;
    this.glow.material.opacity = 0.08 + Math.sin(t) * 0.04;
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
  // Drop in front of player with random X offset
  const xOff = (Math.random() - 0.5) * 0.2; // ±10cm
  ball.launch(xOff, 1.2, -0.4, 0, 0.5, 0);
}

function removeBall() {
  if (balls.length <= MIN_BALLS) return;
  const ball = balls.pop();
  // If held, remove from controller
  if (ball.holder) {
    const idx = ball.holder.heldBalls.indexOf(ball);
    if (idx !== -1) ball.holder.heldBalls.splice(idx, 1);
  }
  scene.remove(ball.mesh);
}

// ─── Game Logic ──────────────────────────────────────────────────────
let vrSessionActive = false;
let lastLaunchTime = 0;
let launchedCount = 0;

// Ground HUD — a flat plane on the ground facing up
const hudCanvas = document.createElement('canvas');
hudCanvas.width = 512;
hudCanvas.height = 128;
const hudCtx = hudCanvas.getContext('2d');
const hudTexture = new THREE.CanvasTexture(hudCanvas);
const hudGeo = new THREE.PlaneGeometry(0.5, 0.125);
const hudMat = new THREE.MeshBasicMaterial({
  map: hudTexture,
  transparent: true,
  opacity: 0.85,
  side: THREE.DoubleSide,
});
const hudMesh = new THREE.Mesh(hudGeo, hudMat);
hudMesh.rotation.x = -Math.PI / 2; // face up
hudMesh.position.set(0, FLOOR_Y + 0.005, -0.6); // on ground, slightly in front
scene.add(hudMesh);

function updateHUD() {
  hudCtx.clearRect(0, 0, 512, 128);
  // Background
  hudCtx.fillStyle = 'rgba(10, 10, 30, 0.7)';
  hudCtx.roundRect(4, 4, 504, 120, 16);
  hudCtx.fill();
  // Text
  hudCtx.fillStyle = '#ffffff';
  hudCtx.font = 'bold 36px sans-serif';
  hudCtx.textAlign = 'center';
  hudCtx.textBaseline = 'middle';
  const pct = Math.round(gravityMultiplier * 100);
  const autoLabel = autoThrowEnabled ? 'ON' : 'OFF';
  const planeLabel = flatPlaneEnabled ? 'ON' : 'OFF';
  hudCtx.fillText(`G:${pct}% B:${balls.length} Auto:${autoLabel} Plane:${planeLabel}`, 256, 64);
  hudTexture.needsUpdate = true;
}
updateHUD();

renderer.xr.addEventListener('sessionstart', () => {
  vrSessionActive = true;
  launchedCount = 0;
  lastLaunchTime = performance.now();
});

renderer.xr.addEventListener('sessionend', () => {
  vrSessionActive = false;
});

function autoLaunchBalls(now) {
  if (launchedCount >= balls.length) return;
  const elapsed = (now - lastLaunchTime) / 1000;
  if (elapsed >= CASCADE_INTERVAL) {
    const ball = balls[launchedCount];
    const xOffset = (launchedCount - 1) * 0.2;
    const side = launchedCount % 2 === 0 ? -1 : 1;
    ball.launch(
      xOffset, 0.8, -0.3,
      side * 0.8, 4.0 + launchedCount * 0.3, 0
    );
    launchedCount++;
    lastLaunchTime = now;
  }
}

// Raycaster for trigger-grab
const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

function checkAutoCatch() {
  // Auto-catch: any free ball that enters a hand's catch zone is caught automatically
  for (const ctrl of controllers) {
    if (ctrl.heldBalls.length >= balls.length) continue; // hand is full
    const gripPos = new THREE.Vector3();
    ctrl.grip.getWorldPosition(gripPos);

    let closestBall = null;
    let closestDist = Infinity;

    for (const ball of balls) {
      if (ball.state !== 'free') continue;
      if (performance.now() < ball.throwImmunityUntil) continue; // recently thrown, skip
      const ballPos = new THREE.Vector3();
      ball.mesh.getWorldPosition(ballPos);
      const dist = gripPos.distanceTo(ballPos);
      if (dist < CATCH_RADIUS && dist < closestDist) {
        closestDist = dist;
        closestBall = ball;
      }
    }

    if (closestBall) {
      closestBall.attachTo(ctrl);
      ctrl.triggerHaptic();
      // Flash the catch zone
      ctrl.catchZone.material.opacity = 0.3;
      setTimeout(() => { ctrl.catchZone.material.opacity = 0.08; }, 150);
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
  // Trigger-grab: point at a ball while trigger held to summon it
  for (const ctrl of controllers) {
    const triggerPressed = ctrl.isTriggerPressed();

    // Show/hide laser when trigger is held
    ctrl.laser.visible = triggerPressed && ctrl.heldBalls.length < balls.length;

    // Continuously check while trigger is held
    if (triggerPressed && ctrl.heldBalls.length < balls.length) {
      // Raycast from controller
      tempMatrix.identity().extractRotation(ctrl.controller.matrixWorld);
      const rayOrigin = new THREE.Vector3();
      ctrl.controller.getWorldPosition(rayOrigin);
      const rayDir = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();

      // Find closest ball to the ray
      let bestBall = null;
      let bestDist = Infinity;

      for (const ball of balls) {
        if (ball.state !== 'free') continue;
        const ballPos = new THREE.Vector3();
        ball.mesh.getWorldPosition(ballPos);

        // Distance from ray to ball center
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

    if (ctrl.wasAcceleratingUp && nowDecelerating && ctrl.velocity.y > AUTO_THROW_MIN_VELOCITY) {
      // Auto-throw!
      topBall.release(ctrl.velocity);
      ctrl.triggerHaptic(0.4, 80);
      ctrl.autoThrowCooldownUntil = now + AUTO_THROW_COOLDOWN_MS;
    }

    // Update state for next frame
    ctrl.wasAcceleratingUp = ctrl.smoothedAccelY > ACCEL_UPSWING_THRESHOLD;
  }
}

function checkAutoThrowToggle() {
  // Right controller A-button toggles auto-throw, B-button toggles flat plane
  const rightCtrl = controllers[1];

  // A button: auto-throw
  const aPressed = rightCtrl.isAButtonPressed();
  if (aPressed && !rightCtrl.aButtonDown) {
    rightCtrl.aButtonDown = true;
    autoThrowEnabled = !autoThrowEnabled;
    updateHUD();
    rightCtrl.triggerHaptic(0.2, 50);
  }
  if (!aPressed && rightCtrl.aButtonDown) {
    rightCtrl.aButtonDown = false;
  }

  // B button: flat plane
  const bPressed = rightCtrl.isBButtonPressed();
  if (bPressed && !rightCtrl.bButtonDown) {
    rightCtrl.bButtonDown = true;
    flatPlaneEnabled = !flatPlaneEnabled;
    updateHUD();
    rightCtrl.triggerHaptic(0.2, 50);
  }
  if (!bPressed && rightCtrl.bButtonDown) {
    rightCtrl.bButtonDown = false;
  }
}

// ─── Animation Loop ──────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05); // clamp dt to avoid spiral of death
  const now = performance.now();

  if (vrSessionActive) {
    // Auto-launch balls at start of VR session
    autoLaunchBalls(now);

    // Update controller velocities
    for (const ctrl of controllers) {
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

    // A-button toggle for auto-throw (right controller)
    checkAutoThrowToggle();
  }

  // Update ball physics
  for (const ball of balls) {
    ball.update(dt);
  }

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);
