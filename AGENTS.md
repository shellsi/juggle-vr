# Juggle VR — Agent Guide

This document gives AI agents (and human contributors) the full context needed to reason about the project without digging through the codebase.

## Live Site

Published at: **https://shellsi.github.io/juggle-vr/**

---

## Stack & Build

- **Runtime**: ES modules with an import map — no bundler, transpilation, or build step.
- **3D**: Three.js 0.170.0 loaded from jsdelivr CDN.
- **VR**: WebXR helpers (`VRButton`, `XRControllerModelFactory`, `Reflector`).
- **Server**: Node HTTPS (port 8443) with HTTP fallback on 3001. Requires `key.pem` + `cert.pem` for WebXR on Quest.

---

## Running

```bash
node server.js
```

- **VR**: `https://localhost:8443` — Quest: accept cert warning → Enter VR
- **Desktop**: `http://localhost:3001` — preview only, no VR functionality

---

## File Layout

| File | Role |
|------|------|
| `index.html` | Entry point, import map definitions, info overlay |
| `main.js` | Scene setup, controllers, balls, and the main game loop (~1180 lines) |
| `server.js` | Static file server (HTTPS + HTTP) |
| `key.pem`, `cert.pem` | TLS certs for local HTTPS (needed by WebXR) |

---

## Architecture Overview

### Controller System (`ControllerState` class)

- Velocity tracking with history-based averaging
- Ribbon trails with pitch-based width modulation and speed-inverse scaling
- Haptic feedback for interactions
- Input handling for grip, trigger, A/B/X buttons, and thumbsticks

### Ball System (`Ball` class)

State machine with four states:

| State | Description |
|-------|-------------|
| **waiting** | Not launched yet |
| **free** | In flight — physics simulation + trail recording |
| **held** | Attached to grip, parented to controller |
| **sliding** | Moving from ray-grab to hand (0.6 s ease-out) |

Flow: `waiting` → `free` → `held`/`sliding` → `free` (cycle)

Trail is recorded only while `free`; one extra point at catch location before the held break marker.

### Scene

Gradient sky, starfield, lighting, and ground plane.

---

## Controls

| Input | Action |
|-------|--------|
| **Auto-catch** | Ball enters ~9 cm zone around grip → caught |
| **Throw** | Grip squeeze + release while hand moves **up** → throw top ball |
| **Trigger** | Ray-grab: point at ball, pull trigger → ball slides to hand |
| **Right A** | Toggle auto-throw (automatic upward toss after short hold) |
| **Right B** | Toggle flat-plane constraint (lock Z when released) |
| **Right stick Y** | Adjust gravity (10%–100%) |
| **Right stick X** | Add/remove balls (1–9) |
| **Left X** | Toggle smoke trails (controller + ball) |
| **H** (keyboard) | Cycle input mode: Auto / Hands / Controllers |

**Hand tracking** (put down controllers): pinch = trigger/grab, fist = grip/hold. No haptics, thumbstick, or A/B/X.

---

## Trail System

- **Controller trails**: Ribbon (quads) with pitch-based width + width inversely proportional to controller speed. Left = cyan, right = orange.
- **Ball trails**: Line strip, raw positions, age-based fade + Z scroll. No explicit smoothing. Break marker (`null`) during hold.

Constants: `TRAIL_LENGTH` 400, `TRAIL_SCROLL_SPEED` 0.5 m/s, ribbon width clamps, speed ref/epsilon.

---

## Animation Loop Order

1. Auto-launch balls (VR start)
2. Controller `updateVelocity(dt)`
3. Gravity / ball count (thumbstick)
4. `checkAutoCatch()`
5. `checkThrowOnGripRelease()`
6. `checkTriggerGrab()`
7. `checkAutoThrow()` (if enabled)
8. A/B toggles
9. Controller trail `updateTrail(now)`
10. Ball `update(dt)` (physics + trail recording)
11. Ball trail `updateTrail(now)`
12. Render

---

## Key Constants

| Name | Value | Purpose |
|------|-------|---------|
| `CATCH_RADIUS` | 0.09 m | Proximity for auto-catch |
| `BALL_RADIUS` | 0.04 m | Ball size |
| `THROW_VELOCITY_SCALE` | 1.2 | Throw strength multiplier |
| `MIN_THROW_UP` | 1.5 m/s | Minimum upward velocity |
| `TRAIL_LENGTH` | 400 points | Trail buffer size |
| `AUTO_THROW_MIN_VELOCITY` | 0.6 m/s | Auto-throw trigger threshold |
| `FLAT_PLANE` | on by default | Constrains Z when released |

---

## Future Enhancements

- Super Hot–style slow-mo time (time slows when you slow down)
- Pass-through mixed reality
- Clubs (replace/augment balls)
- Bounce juggling

### Already Implemented
- Start with balls in hands
- Balls stack backwards from centre
- Hand tracking (powered by open/close detection)
- Rotational velocity transfer
