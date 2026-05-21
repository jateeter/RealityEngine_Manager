/**
 * Algorithmic Vector Generation Utilities
 *
 * Generates universal perceptual input vectors using various algorithmic patterns.
 * All vectors span the configured perceptual space dimension (PERCEPTUAL_DIM).
 */

import { PERCEPTUAL_DIM } from '../constants';

/**
 * Generate a sequence of vectors using sine wave pattern
 */
export function generateSineWave(count: number, dimension: number = PERCEPTUAL_DIM): number[][] {
  const vectors: number[][] = [];
  const frequency = 0.1; // Controls wave frequency
  const amplitude = 1.0; // Max amplitude

  for (let t = 0; t < count; t++) {
    const vector = new Array(dimension).fill(0);
    for (let i = 0; i < dimension; i++) {
      // Sine wave with phase shift based on position
      const phase = (i / dimension) * Math.PI * 2;
      const value = (Math.sin(t * frequency + phase) + 1) / 2; // Normalize to [0, 1]
      vector[i] = value * amplitude;
    }
    vectors.push(vector);
  }

  return vectors;
}

/**
 * Generate a sequence of vectors using square wave pattern
 */
export function generateSquareWave(count: number, dimension: number = PERCEPTUAL_DIM): number[][] {
  const vectors: number[][] = [];
  const period = 10; // Wave period

  for (let t = 0; t < count; t++) {
    const vector = new Array(dimension).fill(0);
    const isHigh = Math.floor(t / period) % 2 === 0;

    for (let i = 0; i < dimension; i++) {
      // Binary square wave
      vector[i] = isHigh ? 1.0 : 0.0;
    }
    vectors.push(vector);
  }

  return vectors;
}

/**
 * Generate a sequence of vectors using sawtooth pattern
 */
export function generateSawtooth(count: number, dimension: number = PERCEPTUAL_DIM): number[][] {
  const vectors: number[][] = [];
  const period = 20; // Ramp period

  for (let t = 0; t < count; t++) {
    const vector = new Array(dimension).fill(0);
    const phase = (t % period) / period; // Ramp from 0 to 1

    for (let i = 0; i < dimension; i++) {
      // Linear ramp with offset per dimension
      const offset = (i / dimension);
      const value = (phase + offset) % 1.0;
      vector[i] = value;
    }
    vectors.push(vector);
  }

  return vectors;
}

/**
 * Simple Perlin noise implementation
 */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(t: number, a: number, b: number): number {
  return a + t * (b - a);
}

function grad(hash: number, x: number, y: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : 0;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

// Permutation table for Perlin noise
const p: number[] = [];
for (let i = 0; i < 256; i++) p[i] = i;
for (let i = 255; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [p[i], p[j]] = [p[j], p[i]];
}
for (let i = 0; i < 256; i++) p[256 + i] = p[i];

function perlin(x: number, y: number): number {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;

  x -= Math.floor(x);
  y -= Math.floor(y);

  const u = fade(x);
  const v = fade(y);

  const a = p[X] + Y;
  const aa = p[a];
  const ab = p[a + 1];
  const b = p[X + 1] + Y;
  const ba = p[b];
  const bb = p[b + 1];

  return lerp(v,
    lerp(u, grad(p[aa], x, y), grad(p[ba], x - 1, y)),
    lerp(u, grad(p[ab], x, y - 1), grad(p[bb], x - 1, y - 1))
  );
}

/**
 * Generate a sequence of vectors using Perlin noise
 */
export function generatePerlinNoise(count: number, dimension: number = PERCEPTUAL_DIM): number[][] {
  const vectors: number[][] = [];
  const scale = 0.05; // Noise scale

  for (let t = 0; t < count; t++) {
    const vector = new Array(dimension).fill(0);

    for (let i = 0; i < dimension; i++) {
      // Generate smooth noise
      const noise = perlin(i * scale, t * scale);
      const normalized = (noise + 1) / 2; // Normalize to [0, 1]
      vector[i] = Math.max(0, Math.min(1, normalized));
    }
    vectors.push(vector);
  }

  return vectors;
}

/**
 * Generate a sequence of vectors using Fibonacci sequence
 */
export function generateFibonacci(count: number, dimension: number = PERCEPTUAL_DIM): number[][] {
  const vectors: number[][] = [];
  const phi = (1 + Math.sqrt(5)) / 2; // Golden ratio

  for (let t = 0; t < count; t++) {
    const vector = new Array(dimension).fill(0);

    for (let i = 0; i < dimension; i++) {
      // Fibonacci-based pattern using golden ratio
      const fib = Math.pow(phi, (i + t) % 10) % 1.0;
      vector[i] = fib;
    }
    vectors.push(vector);
  }

  return vectors;
}

/**
 * Generate a sequence of vectors using linear ramp
 */
export function generateLinearRamp(count: number, dimension: number = PERCEPTUAL_DIM): number[][] {
  const vectors: number[][] = [];

  for (let t = 0; t < count; t++) {
    const vector = new Array(dimension).fill(0);
    const progress = t / count; // Overall progress

    for (let i = 0; i < dimension; i++) {
      // Linear gradient
      const value = (i / dimension) * progress;
      vector[i] = Math.min(1.0, value);
    }
    vectors.push(vector);
  }

  return vectors;
}

/**
 * Generate a sequence of vectors using exponential growth
 */
export function generateExponential(count: number, dimension: number = PERCEPTUAL_DIM): number[][] {
  const vectors: number[][] = [];
  const base = 1.05; // Exponential base

  for (let t = 0; t < count; t++) {
    const vector = new Array(dimension).fill(0);

    for (let i = 0; i < dimension; i++) {
      // Exponential growth pattern
      const exp = Math.pow(base, (i + t) / 10);
      const normalized = (exp % 1.0); // Keep in [0, 1]
      vector[i] = normalized;
    }
    vectors.push(vector);
  }

  return vectors;
}

/**
 * Main generator function that dispatches to specific pattern generators
 */
export function generateAlgorithmicVectors(
  pattern: string,
  count: number,
  dimension: number = PERCEPTUAL_DIM
): number[][] {
  switch (pattern) {
    case 'sine-wave':
      return generateSineWave(count, dimension);
    case 'square-wave':
      return generateSquareWave(count, dimension);
    case 'sawtooth':
      return generateSawtooth(count, dimension);
    case 'perlin-noise':
      return generatePerlinNoise(count, dimension);
    case 'fibonacci':
      return generateFibonacci(count, dimension);
    case 'linear-ramp':
      return generateLinearRamp(count, dimension);
    case 'exponential':
      return generateExponential(count, dimension);
    default:
      console.warn(`Unknown pattern: ${pattern}, defaulting to sine-wave`);
      return generateSineWave(count, dimension);
  }
}

/**
 * Apply machine-specific override to a universal vector
 * This allows the user to override specific bytes that affect a machine's input region
 */
export function applyMachineOverride(
  universalVector: number[],
  machineOffset: number,
  machineLength: number,
  overrideValues: number[]
): number[] {
  const result = [...universalVector];

  // Only override the bytes in the machine's input region
  for (let i = 0; i < Math.min(overrideValues.length, machineLength); i++) {
    const targetIndex = machineOffset + i;
    if (targetIndex < result.length) {
      result[targetIndex] = overrideValues[i];
    }
  }

  return result;
}
