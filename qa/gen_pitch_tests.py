"""Generate synthetic pitch-test audio with KNOWN ground truth.

Each file is a mono 16-bit 44.1 kHz WAV in this directory:
  pure_196.wav      harmonic tone at 196 Hz (G3)              -> expect 196
  pure_98.wav       harmonic tone at  98 Hz (G2)              -> expect  98 (no false octave-up!)
  pure_98_vib.wav   98 Hz + 5.5 Hz vibrato +-40c              -> expect  98
  pure_147_vib.wav 147 Hz (D3) + vibrato                      -> expect 147
  fry_196.wav       196 Hz with period doubling (creak)       -> expect 196 (YIN alone says ~98)
  fry_196_vib.wav   fry 196 Hz + vibrato                      -> expect 196
  fry_196_soft.wav  fry 196 Hz, mild (alt cycles at 0.6)      -> expect 196
  fry_131.wav       fry 131 Hz (C3, the "Leo" case)           -> expect 131 (YIN alone says ~65)

The fry signals model Yuuri-style creaky intimate delivery: alternate
glottal pulses are weaker, so the acoustic period doubles and plain YIN
locks onto the subharmonic (one octave low). The octave correction in
pitchTrack must recover the true f0 without touching genuine low tones.
"""
import wave
import numpy as np

SR = 44100
OUT = __import__("os").path.dirname(__file__)


def harmonic_tone(f0, dur, vib_rate=0.0, vib_cents=0.0, fry_depth=0.0, seed=7):
    t = np.arange(int(dur * SR)) / SR
    if vib_rate:
        cents = vib_cents * np.sin(2 * np.pi * vib_rate * t)
        phase = 2 * np.pi * np.cumsum(f0 * 2 ** (cents / 1200.0)) / SR
    else:
        phase = 2 * np.pi * f0 * t
    y = np.zeros_like(t)
    for n in range(1, 11):
        y += np.sin(n * phase) / n
    if fry_depth:
        cyc = np.floor(phase / (2 * np.pi)).astype(int)
        amp = np.where(cyc % 2 == 0, 1.0, 1.0 - fry_depth)
        y *= amp
    rng = np.random.default_rng(seed)
    y += rng.standard_normal(t.shape) * 0.002  # faint breath noise
    y *= 0.8 / np.max(np.abs(y))
    return y


def write_wav(name, y):
    pcm = (np.clip(y, -1, 1) * 32767).astype(np.int16)
    with wave.open(f"{OUT}/{name}", "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(f"wrote {name} ({len(y)/SR:.1f}s)")


CASES = [
    ("pure_196.wav", dict(f0=196, dur=2.0)),
    ("pure_98.wav", dict(f0=98, dur=2.0)),
    ("pure_98_vib.wav", dict(f0=98, dur=3.0, vib_rate=5.5, vib_cents=40)),
    ("pure_147_vib.wav", dict(f0=147, dur=3.0, vib_rate=5.5, vib_cents=40)),
    ("fry_196.wav", dict(f0=196, dur=2.0, fry_depth=0.65)),
    ("fry_196_vib.wav", dict(f0=196, dur=3.0, vib_rate=5.5, vib_cents=40, fry_depth=0.65)),
    ("fry_196_soft.wav", dict(f0=196, dur=2.0, fry_depth=0.4)),
    ("fry_131.wav", dict(f0=131, dur=2.0, fry_depth=0.65)),
]

if __name__ == "__main__":
    for name, kw in CASES:
        write_wav(name, harmonic_tone(**kw))
