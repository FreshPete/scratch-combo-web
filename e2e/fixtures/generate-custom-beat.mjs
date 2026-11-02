import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Regenerate with lamejs 1.2.1 installed outside the app dependencies:
//   npm install --prefix "$env:TEMP/custom-beat-mp3-generator" --no-save --no-package-lock lamejs@1.2.1
//   $env:CUSTOM_BEAT_LAMEJS_PACKAGE_DIR = "$env:TEMP/custom-beat-mp3-generator/node_modules/lamejs"
//   node e2e/fixtures/generate-custom-beat.mjs
// lamejs 1.2.1's CommonJS modules expect these two exports on the global object.
const require = createRequire(import.meta.url)
const lamejsPackage = process.env.CUSTOM_BEAT_LAMEJS_PACKAGE_DIR
if (!lamejsPackage) throw new Error('Set CUSTOM_BEAT_LAMEJS_PACKAGE_DIR to the installed lamejs package directory.')

const MPEGMode = require(path.join(lamejsPackage, 'src/js/MPEGMode.js'))
globalThis.MPEGMode = MPEGMode
globalThis.Lame = require(path.join(lamejsPackage, 'src/js/Lame.js'))
globalThis.BitStream = require(path.join(lamejsPackage, 'src/js/BitStream.js'))
const lamejs = require(lamejsPackage)

const bpm = 128
const beatCount = 24
const sampleRate = 44_100
const sourceSampleCount = Math.round(sampleRate * beatCount * 60 / bpm)
const encoderFrameSize = 1_152
const paddedSampleCount = Math.ceil(sourceSampleCount / encoderFrameSize) * encoderFrameSize
const pcm = new Int16Array(paddedSampleCount)

for (let index = 0; index < sourceSampleCount; index += 1) {
  const time = index / sampleRate
  const beatPhase = time * bpm / 60
  const beatOffset = (beatPhase - Math.floor(beatPhase)) * 60 / bpm
  const envelope = beatOffset < 0.075 ? Math.exp(-beatOffset * 42) : 0
  const sample = envelope * (
    0.04 * Math.sin(2 * Math.PI * 80 * beatOffset)
    + 0.30 * Math.sin(2 * Math.PI * 220 * beatOffset)
    + 0.05 * Math.sin(2 * Math.PI * 1_000 * beatOffset)
    + 0.04 * Math.sin(2 * Math.PI * 1_900 * beatOffset)
  )
  pcm[index] = Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767)))
}

const encoder = new lamejs.Mp3Encoder(1, sampleRate, 192)
const chunks = []
for (let offset = 0; offset < pcm.length; offset += encoderFrameSize) {
  const chunk = encoder.encodeBuffer(pcm.subarray(offset, offset + encoderFrameSize))
  if (chunk.length > 0) chunks.push(Buffer.from(chunk))
}
const tail = encoder.flush()
if (tail.length > 0) chunks.push(Buffer.from(tail))

const outputPath = fileURLToPath(new URL('./custom-beat-128-bpm.mp3', import.meta.url))
await writeFile(outputPath, Buffer.concat(chunks))
process.stdout.write(`Wrote synthetic ${bpm} BPM ${beatCount}-beat MP3 to ${outputPath}\n`)
