<img src="./juggle-vr-screenshot.png" alt="Juggle VR trails" width="600">

# Juggle VR — Project Summary

VR juggling game built with Three.js and WebXR. Run locally with Node, use Quest (or compatible headset) to juggle balls with hand tracking and auto-catch/throw logic.

**Live:** https://shellsi.github.io/juggle-vr/

---

## Highlights

- Built for Quest hand-tracking: squeeze, throw, and auto-catch juggling patterns in VR.
- Controller and ball trails add a neon long-exposure effect that reflects motion.
- Quick tweaks for gravity, ball count, auto-throw, and smoke trails to experiment with feel.
- Minimal HTTPS Node server keeps setup simple while satisfying WebXR security requirements.

Need the full technical breakdown (controls, constants, animation loop, etc.)? See [`AGENTS.md`](./AGENTS.md).

---

## Running

```bash
node server.js
```

- **VR**: `https://localhost:8443` (Quest: accept cert warning → Enter VR)
- **Desktop**: `http://localhost:3001` (preview, no VR)
