import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { makeScratchPreviewSource, renderScratchPreview, SCRATCH_SOURCE_WINDOW_SECONDS } from './audio/scratch-preview'
import { decodeLocalAudioFile } from './audio/beatAnalysis'
import ahhSampleUrl from './assets/ahh-hy96.mp3?url'
import './ScratchEditor.css'

const POINT_COUNT = 48
const PREVIEW_SECONDS = 1.5
const starterPositions = Array.from({ length: POINT_COUNT }, (_, index) => {
  const phase = index / (POINT_COUNT - 1)
  return phase < 0.42 ? phase / 0.42 : 1 - (phase - 0.42) / 0.58
})
const starterFader = Array.from({ length: POINT_COUNT }, (_, index) => (
  index % 12 < 7 || (index % 12 >= 9 && index % 12 < 11)
))

export interface ScratchEditorProps {
  active: boolean
  samples: readonly { id: string; name: string; file: File }[]
  onBeforePreview: () => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function pointsPath(values: readonly number[], width: number, height: number): string {
  return values.map((value, index) => {
    const x = (index / (values.length - 1)) * width
    const y = (1 - value) * height
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
}

function setInterpolatedValue(values: readonly number[], fromIndex: number, toIndex: number, fromValue: number, toValue: number): number[] {
  const next = [...values]
  const span = Math.abs(toIndex - fromIndex)
  for (let offset = 0; offset <= span; offset += 1) {
    const index = fromIndex + Math.sign(toIndex - fromIndex) * offset
    const ratio = span === 0 ? 1 : offset / span
    next[index] = fromValue + (toValue - fromValue) * ratio
  }
  return next
}

function drawGrid() {
  return <>
    {Array.from({ length: 17 }, (_, index) => <line key={`v${index}`} x1={`${index * 100 / 16}%`} x2={`${index * 100 / 16}%`} y1="0" y2="100%" className={index % 4 === 0 ? 'scratch-editor__grid-major' : 'scratch-editor__grid'} />)}
    {[0.25, 0.5, 0.75].map((ratio) => <line key={ratio} x1="0" x2="100%" y1={`${ratio * 100}%`} y2={`${ratio * 100}%`} className="scratch-editor__grid" />)}
  </>
}

export function ScratchEditor({ active, samples, onBeforePreview }: ScratchEditorProps) {
  const [sourceId, setSourceId] = useState('starter')
  const [positions, setPositions] = useState(starterPositions)
  const [fader, setFader] = useState(starterFader)
  const [selectedPoint, setSelectedPoint] = useState(0)
  const [previewing, setPreviewing] = useState(false)
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [message, setMessage] = useState('Ready to preview.')
  const audioRef = useRef<{ context: AudioContext; source: AudioBufferSourceNode; startedAt: number; frame: number } | null>(null)
  const pendingContextRef = useRef<AudioContext | null>(null)
  const requestIdRef = useRef(0)
  const activeRef = useRef(active)
  const pointerRef = useRef<{ lane: 'record' | 'fader'; lastIndex: number; lastValue: number; pointerId: number } | null>(null)
  const [preparing, setPreparing] = useState(false)
  const selectedSample = samples.find((sample) => sample.id === sourceId)
  const resolvedSourceId = sourceId === 'ahh' || selectedSample ? sourceId : 'starter'

  const stopPreview = (status = 'Preview stopped.') => {
    const wasActive = Boolean(pendingContextRef.current || audioRef.current)
    requestIdRef.current += 1
    pointerRef.current = null
    const pending = pendingContextRef.current
    pendingContextRef.current = null
    if (pending && pending.state !== 'closed') void pending.close()
    const playback = audioRef.current
    if (playback) {
      audioRef.current = null
      window.cancelAnimationFrame(playback.frame)
      try { playback.source.stop() } catch { /* A finished source is already stopped. */ }
      void playback.context.close()
    }
    setPreviewing(false)
    setPlayhead(null)
    setPreparing(false)
    if (status && wasActive) setMessage(status)
  }

  useEffect(() => {
    activeRef.current = active
    if (!active) stopPreview('Preview stopped when leaving Scratch Editor.')
  }, [active])

  useEffect(() => () => stopPreview(''), [])

  useEffect(() => {
    if (sourceId !== resolvedSourceId) setSourceId(resolvedSourceId)
  }, [resolvedSourceId, sourceId])

  const animatePlayhead = () => {
    const playback = audioRef.current
    if (!playback) return
    const { context, startedAt } = playback
    const outputTime = context.getOutputTimestamp?.().contextTime
    const heardTime = outputTime && Number.isFinite(outputTime) ? outputTime : context.currentTime
    const progress = clamp((heardTime - startedAt) / PREVIEW_SECONDS, 0, 1)
    if (progress >= 1) {
      stopPreview('Preview finished.')
      return
    }
    setPlayhead(progress)
    playback.frame = window.requestAnimationFrame(animatePlayhead)
  }

  const startPreview = async () => {
    stopPreview('')
    const requestId = requestIdRef.current
    setPreparing(true)
    setMessage('Preparing preview…')
    onBeforePreview()

    let context: AudioContext | null = null
    try {
      context = new AudioContext()
      pendingContextRef.current = context
      await context.resume()
      if (requestId !== requestIdRef.current) return
      let channels: readonly Float32Array[]
      let sourceSampleRate = context.sampleRate
      if (resolvedSourceId === 'starter') {
        channels = [makeScratchPreviewSource(context.sampleRate)]
      } else {
        let decoded: AudioBuffer
        if (resolvedSourceId === 'ahh') {
          const response = await fetch(ahhSampleUrl)
          if (!response.ok) throw new Error('The built-in Ahh sample could not load. Try again.')
          const bytes = await response.arrayBuffer()
          if (requestId !== requestIdRef.current) return
          decoded = await context.decodeAudioData(bytes)
        } else {
          if (!selectedSample) throw new Error('Choose an available scratch sound.')
          decoded = await decodeLocalAudioFile(context, selectedSample.file)
        }
        channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index))
        sourceSampleRate = decoded.sampleRate
      }

      if (requestId !== requestIdRef.current || !activeRef.current) return
      const rendered = renderScratchPreview({
        channels,
        sourceSampleRate,
        outputSampleRate: context.sampleRate,
        durationSeconds: PREVIEW_SECONDS,
        positions,
        fader,
      })
      const buffer = context.createBuffer(rendered.length, rendered[0]?.length ?? 1, context.sampleRate)
      rendered.forEach((channel, index) => buffer.copyToChannel(channel, index))
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      const startedAt = context.currentTime + 0.025
      const playback = { context, source, startedAt, frame: 0 }
      pendingContextRef.current = null
      audioRef.current = playback
      source.start(startedAt)
      setPreparing(false)
      setPreviewing(true)
      const sourceName = resolvedSourceId === 'ahh' ? 'Ahh vocal' : selectedSample?.name ?? 'starter sound'
      setMessage(`Playing ${sourceName}.`)
      playback.frame = window.requestAnimationFrame(animatePlayhead)
    } catch (error) {
      if (requestId !== requestIdRef.current || !activeRef.current) return
      setPreparing(false)
      stopPreview('')
      setMessage(`Preview could not start. ${error instanceof Error ? error.message : 'Check the selected audio file and try again.'}`)
    }
  }

  const pointFromPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1)
    const index = event.currentTarget.classList.contains('scratch-editor__canvas--fader')
      ? Math.min(POINT_COUNT - 1, Math.floor(ratio * POINT_COUNT))
      : Math.round(ratio * (POINT_COUNT - 1))
    const value = clamp(1 - (event.clientY - bounds.top) / bounds.height, 0, 1)
    return { index, value }
  }

  const handleRecordPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (previewing || preparing || pointerRef.current || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointFromPointer(event)
    pointerRef.current = { lane: 'record', lastIndex: point.index, lastValue: point.value, pointerId: event.pointerId }
    setSelectedPoint(point.index)
    setPositions((current) => setInterpolatedValue(current, point.index, point.index, point.value, point.value))
  }

  const handleFaderPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (previewing || preparing || pointerRef.current || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointFromPointer(event)
    const firstValue = !fader[point.index]
    pointerRef.current = { lane: 'fader', lastIndex: point.index, lastValue: Number(firstValue), pointerId: event.pointerId }
    setSelectedPoint(point.index)
    setFader((current) => current.slice().fill(firstValue, point.index, point.index + 1))
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drawing = pointerRef.current
    if (!drawing || drawing.pointerId !== event.pointerId) return
    const point = pointFromPointer(event)
    const lastIndex = drawing.lastIndex
    const lastValue = drawing.lastValue
    setSelectedPoint(point.index)
    if (drawing.lane === 'record') {
      setPositions((current) => setInterpolatedValue(current, lastIndex, point.index, lastValue, point.value))
      drawing.lastValue = point.value
    } else {
      setFader((current) => current.slice().fill(Boolean(lastValue), Math.min(lastIndex, point.index), Math.max(lastIndex, point.index) + 1))
    }
    drawing.lastIndex = point.index
  }

  const endPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (pointerRef.current?.pointerId === event.pointerId) pointerRef.current = null
  }

  const handleKeyboard = (lane: 'record' | 'fader', event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (previewing || preparing) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      setSelectedPoint((current) => clamp(current + (event.key === 'ArrowRight' ? 1 : -1), 0, POINT_COUNT - 1))
    } else if (lane === 'record' && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      const delta = event.key === 'ArrowUp' ? 0.05 : -0.05
      setPositions((current) => current.map((value, index) => index === selectedPoint ? clamp(value + delta, 0, 1) : value))
    } else if (lane === 'fader' && [' ', 'Enter', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault()
      setFader((current) => {
        const open = event.key === 'ArrowUp' || (event.key !== 'ArrowDown' && !current[selectedPoint])
        return current.slice().fill(open, selectedPoint, selectedPoint + 1)
      })
    }
  }

  const resetPattern = () => {
    if (previewing || preparing) return
    setPositions(starterPositions)
    setFader(starterFader)
    setSelectedPoint(0)
    setMessage('Starter scratch restored.')
  }

  return <section id="scratch-editor" className="workspace-section scratch-editor" aria-labelledby="scratch-editor-heading">
    <div className="scratch-editor__heading">
      <div>
        <h2 id="scratch-editor-heading">Scratch editor</h2>
        <p>Draw how the record moves, then cut it with the fader. Preview your pattern immediately.</p>
      </div>
      <button className="button" type="button" onClick={resetPattern} disabled={previewing || preparing}>Reset pattern</button>
    </div>

    <div className="scratch-editor__toolbar">
      <label className="scratch-editor__source" htmlFor="scratch-editor-source">
        <span>Scratch sound</span>
        <select id="scratch-editor-source" value={resolvedSourceId} onChange={(event) => setSourceId(event.currentTarget.value)} disabled={previewing || preparing}>
          <option value="starter">Starter sound</option>
          <option value="ahh">Ahh vocal</option>
          {samples.map((sample) => <option key={sample.id} value={sample.id}>{sample.name}</option>)}
        </select>
      </label>
      <div className="scratch-editor__actions">
        <button className={previewing || preparing ? 'button button--stop' : 'button button--play'} type="button" onClick={() => {
          if (previewing || preparing) stopPreview()
          else void startPreview()
        }}>
          {preparing ? 'Cancel preview' : previewing ? 'Stop preview' : 'Play scratch'}
        </button>
        <span className="scratch-editor__duration">1.5 sec preview</span>
      </div>
    </div>

    <div className={`scratch-editor__lanes${previewing ? ' scratch-editor__lanes--playing' : ''}`}>
      <div className="scratch-editor__lane-heading">
        <div><h3>Record movement</h3><p>Draw a rising line to move forward or a falling line to rewind. The lane covers the first {SCRATCH_SOURCE_WINDOW_SECONDS} seconds of the sound.</p></div>
        <div className="scratch-editor__position-labels"><span>Region end</span><span>Region start</span></div>
      </div>
      <svg
        className="scratch-editor__canvas scratch-editor__canvas--record"
        viewBox="0 0 960 120"
        preserveAspectRatio="none"
        role="slider"
        aria-label="Record position across the sound"
        aria-describedby="scratch-editor-keys"
        aria-disabled={previewing || preparing}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((positions[selectedPoint] ?? 0) * 100)}
        aria-valuetext={`${Math.round((positions[selectedPoint] ?? 0) * 100)} percent into the sound at ${(selectedPoint / (POINT_COUNT - 1) * PREVIEW_SECONDS).toFixed(2)} seconds`}
        tabIndex={0}
        onKeyDown={(event) => handleKeyboard('record', event)}
        onPointerDown={handleRecordPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
      >
        {drawGrid()}
        <path d={pointsPath(positions, 960, 120)} className="scratch-editor__movement" />
        <circle cx={(selectedPoint / (POINT_COUNT - 1)) * 960} cy={(1 - (positions[selectedPoint] ?? 0)) * 120} r="5" className="scratch-editor__selected" />
        {playhead !== null && <line x1={playhead * 960} x2={playhead * 960} y1="0" y2="100%" className="scratch-editor__playhead" />}
      </svg>
      <div className="scratch-editor__time-axis" aria-hidden="true"><span>0 sec</span><span>0.75 sec</span><span>1.5 sec</span></div>

      <div className="scratch-editor__lane-heading scratch-editor__lane-heading--fader">
        <div><h3>Crossfader cuts</h3><p>Start on a closed step to paint it open, or on an open step to cut.</p></div>
        <div className="scratch-editor__fader-key"><i className="scratch-editor__fader-open" />Open<i className="scratch-editor__fader-closed" />Closed</div>
      </div>
      <svg
        className="scratch-editor__canvas scratch-editor__canvas--fader"
        viewBox="0 0 960 64"
        preserveAspectRatio="none"
        role="slider"
        aria-label="Crossfader cuts, open or closed"
        aria-describedby="scratch-editor-keys"
        aria-disabled={previewing || preparing}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Number(fader[selectedPoint])}
        aria-valuetext={`Fader ${fader[selectedPoint] ? 'open' : 'closed'} at ${Math.round(selectedPoint / (POINT_COUNT - 1) * 100)} percent through the scratch`}
        tabIndex={0}
        onKeyDown={(event) => handleKeyboard('fader', event)}
        onPointerDown={handleFaderPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
      >
        {drawGrid()}
        {fader.map((open, index) => <rect
          key={index}
          x={(index / POINT_COUNT) * 960 + 1}
          y={open ? 9 : 27}
          width={960 / POINT_COUNT - 2}
          height={open ? 46 : 10}
          rx="1"
          className={open ? 'scratch-editor__fader-cell scratch-editor__fader-cell--open' : 'scratch-editor__fader-cell scratch-editor__fader-cell--closed'}
        />)}
        <line x1={((selectedPoint + 0.5) / POINT_COUNT) * 960} x2={((selectedPoint + 0.5) / POINT_COUNT) * 960} y1="0" y2="100%" className="scratch-editor__selected-line" />
        {playhead !== null && <line x1={playhead * 960} x2={playhead * 960} y1="0" y2="100%" className="scratch-editor__playhead" />}
      </svg>
      <div className="scratch-editor__time-axis scratch-editor__time-axis--bottom" aria-hidden="true"><span>0 sec</span><span>0.75 sec</span><span>1.5 sec</span></div>
    </div>

    <p id="scratch-editor-keys" className="scratch-editor__hint">Draw with a mouse or touch. Use left and right arrows to select a point, up and down arrows to edit it, and Space to toggle the fader.</p>
    <p className="scratch-editor__status" role="status" aria-live="polite">{message}</p>
  </section>
}
