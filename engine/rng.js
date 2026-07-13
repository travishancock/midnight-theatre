// Seeded PRNG (mulberry32). The RNG state lives inside the game state so the
// whole engine stays deterministic and replayable: same seed + same action
// sequence => same game.

export function makeSeed() {
  return ((Date.now() & 0xffffffff) ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

// Advances state.rng and returns a float in [0, 1).
export function nextRand(state) {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randInt(state, n) {
  return Math.floor(nextRand(state) * n);
}

// In-place Fisher-Yates shuffle driven by the state RNG.
export function shuffle(state, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(state, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
