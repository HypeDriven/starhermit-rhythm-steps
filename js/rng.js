// Seeded random streams. Separate streams for rules, content decoration, and
// audiovisual variants so cosmetic randomness can never change rules.
// All generators are pure and serializable (state is a single uint32).

export function hashString(str) {
  // FNV-1a 32-bit — also used for state hashing across the app.
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function makeRng(seed) {
  // mulberry32
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) { // inclusive both ends
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(arr) { return arr[Math.floor(next() * arr.length)]; },
    chance(p) { return next() < p; },
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    getState() { return a >>> 0; },
    setState(s) { a = s >>> 0; },
  };
}

// Daily seed: immutable per UTC day. Never re-derive differently after publication.
export function dailySeed(utcDateString) {
  return hashString('rhythm-steps:daily:v1:' + utcDateString);
}

export function streamSeed(baseSeed, streamName) {
  return hashString(baseSeed + ':' + streamName) >>> 0;
}
