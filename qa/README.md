# Pitch QA

Synthetic test audio + runner for `DSP.pitchTrack`, focused on the
octave-down failure mode (YIN locking onto fry/creak subharmonics).

## Regenerate audio

```bash
python gen_pitch_tests.py
```

Writes 8 mono 16-bit 44.1 kHz WAVs with known ground truth (see the
docstring in `gen_pitch_tests.py`). The `fry_*` files model creaky
delivery via period doubling: plain YIN reports them one octave low.

## Run tests

```bash
node run_pitch_tests.js
```

Runs the real `DSP.pitchTrack` from `../static/dsp.js` on each file and
asserts the median voiced f0 against ground truth. Exit 0 = all pass.

## What it guards

- `pure_*`: genuine low tones must NOT be "corrected" upward (no false
  octave-up). This is the safety rail around the `octaveThreshold`.
- `fry_*`: period-doubled tones must be corrected to the true f0.
- If you retune `octaveThreshold` in `pitchTrack`, all 8 must still pass.
