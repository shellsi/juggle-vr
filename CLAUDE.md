# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Live Site

Published at: **https://shellsi.github.io/juggle-vr/**

## Development Server

Start the local server for VR development:
```bash
node server.js
```

The server runs on two ports:
- **HTTPS (8443)**: `https://localhost:8443` - Required for WebXR on Quest devices (accept cert warning)
- **HTTP (3001)**: `http://localhost:3001` - Desktop preview (no VR functionality)

## Architecture Overview

This is a VR juggling application built with vanilla ES modules and Three.js, targeting WebXR devices like Meta Quest.

### Core Components

- **`main.js`** (~1180 lines): Single-file application containing all game logic
  - Scene setup with gradient sky, starfield, lighting, and ground
  - Controller handling with velocity tracking and haptic feedback
  - Ball physics with multiple states (`waiting`, `free`, `held`, `sliding`)
  - Trail rendering system for both controllers and balls
  - Game mechanics (auto-catch, throwing, trigger-grab, auto-throw)

- **`server.js`**: Static file server with HTTPS/HTTP dual-port setup for WebXR compatibility
- **`index.html`**: Entry point with Three.js importmap and minimal UI overlay

### Key Systems

**Controller System (`ControllerState` class)**:
- Velocity tracking with history-based averaging
- Ribbon trails with pitch-based width modulation and speed-inverse scaling  
- Haptic feedback for interactions
- Input handling for grip, trigger, A/B/X buttons, and thumbsticks

**Ball System (`Ball` class)**:
- State machine: `waiting` → `free` → `held`/`sliding` → `free` (cycle)
- Physics simulation with gravity, bouncing, and constraints
- Trail recording during flight with break markers when held
- Auto-catch within 9cm proximity zones

**Game Mechanics**:
- **Auto-catch**: Balls automatically attach when entering hand proximity
- **Throwing**: Grip squeeze + release while moving hand upward
- **Ray-grab**: Point trigger at ball to slide it to hand
- **Auto-throw**: Automatic throwing based on acceleration patterns (toggleable)

### Controls Reference

| Input | Action |
|-------|--------|
| **Auto-catch** | Ball enters ~9cm zone around grip → caught |
| **Throw** | Grip squeeze + release while hand moves up → throw top ball |
| **Trigger** | Ray-grab: point at ball, pull trigger → ball slides to hand |
| **Right A** | Toggle auto-throw |
| **Right B** | Toggle flat-plane constraint (locks Z when released) |
| **Right stick Y** | Adjust gravity (10%–100%) |
| **Right stick X** | Add/remove balls (1–9) |
| **Left X** | Toggle smoke trails |
| **H** (keyboard) | Cycle input mode: Auto / Hands / Controllers |

**Hand tracking** (put down controllers): pinch = trigger/grab, fist = grip/hold. No haptics, thumbstick, or A/B/X.

### Key Constants

Critical values for game feel adjustments:
- `CATCH_RADIUS`: 0.09m (auto-catch proximity)
- `THROW_VELOCITY_SCALE`: 1.2 (throw strength multiplier)
- `MIN_THROW_UP`: 1.5 m/s (minimum upward velocity)
- `TRAIL_LENGTH`: 400 points (trail buffer size)
- `AUTO_THROW_MIN_VELOCITY`: 0.6 m/s (auto-throw trigger threshold)

### No Build System

The project uses ES modules with Three.js loaded via CDN importmap. No bundler, transpilation, or build step required.