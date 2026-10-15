/* Pitch accuracy tests: run the REAL DSP.pitchTrack on synthetic audio with
 * known ground truth. Usage: node run_pitch_tests.js
 * Exit code 0 = all pass, 1 = any failure.
 */
const fs = require('fs');
const path = require('path');
const DSP = require('../static/dsp.js');

function readWavMono(p) {
  const b = fs.readFileSync(p);
  // minimal parse: assumes 16-bit PCM mono, standard 44-byte header
  const sr = b.readUInt32LE(24);
  const data = b.subarray(44);
  const n = Math.floor(data.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return { mono: out, sr };
}

function medianVoiced(f0) {
  const v = [];
  for (let i = 0; i < f0.length; i++) if (f0[i] > 0) v.push(f0[i]);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

const CASES = [
  // [file, expected Hz, tolerance (fraction), label]
  ['pure_196.wav', 196, 0.03, 'pure G3'],
  ['pure_98.wav', 98, 0.03, 'pure G2 (must NOT octave-up)'],
  ['pure_98_vib.wav', 98, 0.04, 'true G2 + vibrato (must NOT octave-up)'],
  ['pure_147_vib.wav', 147, 0.04, 'true D3 + vibrato (must NOT octave-up)'],
  ['fry_196.wav', 196, 0.06, 'creaky G3 (YIN alone says G2)'],
  ['fry_196_vib.wav', 196, 0.06, 'creaky G3 + vibrato'],
  ['fry_196_soft.wav', 196, 0.06, 'mild creak G3'],
  ['fry_131.wav', 131, 0.06, 'creaky C3 "Leo case" (YIN alone says ~65)'],
];

let fails = 0;
for (const [file, expect, tol, label] of CASES) {
  const { mono, sr } = readWavMono(path.join(__dirname, file));
  const r = DSP.pitchTrack(mono, sr, {});
  const med = medianVoiced(r.f0);
  const voicedPct = (r.f0.filter(v => v > 0).length / r.f0.length) * 100;
  const err = Math.abs(med - expect) / expect;
  const ok = err <= tol;
  if (!ok) fails++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${file}  median=${med.toFixed(1)} Hz  ` +
    `expected=${expect}  err=${(err * 100).toFixed(1)}%  voiced=${voicedPct.toFixed(0)}%  [${label}]`
  );
}
console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
process.exit(fails ? 1 : 0);
