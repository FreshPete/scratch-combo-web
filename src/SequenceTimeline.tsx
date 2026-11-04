import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { CycleSlot } from './audio'
import { REST_SAMPLE_ID, type Fixture, type Preset } from './domain'
import { SYNTHETIC_SAMPLE_IDS } from './domain/demo'
import { getTtmGuide, suggestedGuideForSampleName, ttmMotionSvgPath, TTM_GUIDES, type TtmSampleGuideSelection } from './notation/ttm-guides'
import {
  loadWaveform, timelineUnitsToSeconds, waveformDisplayGeometry,
  WAVEFORM_VIEWBOX_HEIGHT, type WaveformData,
} from './waveforms/waveform'
import { sampleColorForName } from './waveforms/sample-color'

const TIMELINE_LABEL_COLUMN_WIDTH = 150
const TIMELINE_MIN_TICK_WIDTH = 8
const TIMELINE_BOARD_HORIZONTAL_PADDING = 24
const TIMELINE_MIN_BOARD_WIDTH = 760

export type TimelineView = 'waveform' | 'ttm'
export type TimelineLayout = 'grid' | 'inline'

type TimelineGuideState = 'suggested' | 'assigned' | 'unassigned' | 'untranscribed'

function timelineGuideForSample(
  sampleId: string,
  sampleName: string,
  annotations: Readonly<Record<string, TtmSampleGuideSelection>>,
): { guide: ReturnType<typeof getTtmGuide>; state: TimelineGuideState } {
  if (Object.hasOwn(annotations, sampleId)) {
    const selected = annotations[sampleId]!
    if (typeof selected === 'string') return { guide: getTtmGuide(selected), state: 'assigned' }
    return { guide: null, state: 'untranscribed' }
  }

  const suggestion = suggestedGuideForSampleName(sampleName)
  return suggestion
    ? { guide: getTtmGuide(suggestion), state: 'suggested' }
    : { guide: null, state: 'unassigned' }
}

export function SequenceTimeline({
  fixture, preset, assets, progress, isPlaying, isPaused, presentationStarted, presentationPositionUnits, presentationCycleSlotKind,
  presentationCyclePlanIndex, activeSampleId, activeEventId, auditionedSampleId, timebase, unitsPerBeat, view: requestedView, layout, ttmAnnotations, onViewChange, onLayoutChange,
}: {
  fixture: Fixture
  preset: Preset
  assets: ReadonlyMap<string, File>
  progress: number
  isPlaying: boolean
  isPaused: boolean
  presentationStarted: boolean
  presentationPositionUnits: number | null
  presentationCycleSlotKind: CycleSlot['kind'] | undefined
  presentationCyclePlanIndex: number | undefined
  activeSampleId: string | null
  activeEventId: string | null
  auditionedSampleId: string | null
  timebase: 'demo' | 'legacy'
  unitsPerBeat: number
  view: TimelineView
  layout: TimelineLayout
  ttmAnnotations: Readonly<Record<string, TtmSampleGuideSelection>>
  onViewChange: (view: TimelineView) => void
  onLayoutChange: (layout: TimelineLayout) => void
}) {
  const [waveforms, setWaveforms] = useState<ReadonlyMap<string, WaveformData>>(() => new Map())
  const waveformGeneration = useRef(0)
  const totalUnits = Math.max(fixture.totalUnits, 1)
  const minBoardWidth = Math.max(
    TIMELINE_MIN_BOARD_WIDTH,
    TIMELINE_LABEL_COLUMN_WIDTH + totalUnits * TIMELINE_MIN_TICK_WIDTH + TIMELINE_BOARD_HORIZONTAL_PADDING,
  )
  const unitsPerBar = unitsPerBeat * 4
  const unitDescription = timebase === 'legacy' ? 'legacy ticks' : 'sixteenth units'
  const view = import.meta.env.DEV ? requestedView : 'waveform'
  const activePlaybackLabel = isPaused ? 'Paused here' : 'Now playing'

  useEffect(() => {
    const generation = waveformGeneration.current + 1
    waveformGeneration.current = generation
    let cancelled = false
    setWaveforms(new Map())

    const filesBySample = new Map<string, File>()
    for (const event of fixture.events) {
      if (event.silent || event.sampleId === REST_SAMPLE_ID || SYNTHETIC_SAMPLE_IDS.has(event.sampleId)) continue
      if (filesBySample.has(event.sampleId)) continue
      const file = assets.get(event.sampleId)
      if (file) filesBySample.set(event.sampleId, file)
    }

    const candidates = Array.from(filesBySample)
    let nextCandidate = 0
    const worker = async () => {
      while (!cancelled && waveformGeneration.current === generation) {
        const candidate = candidates[nextCandidate]
        nextCandidate += 1
        if (!candidate) return
        const [sampleId, file] = candidate
        const waveform = await loadWaveform(file)
        if (cancelled || waveformGeneration.current !== generation) return
        if (waveform) {
          setWaveforms((current) => {
            if (cancelled || waveformGeneration.current !== generation) return current
            const next = new Map(current)
            next.set(sampleId, waveform)
            return next
          })
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, candidates.length) }, () => worker()))

    return () => {
      cancelled = true
    }
  }, [assets, fixture])

  const unitNumbers = Array.from({ length: totalUnits }, (_, index) => index)
  const bars = Array.from({ length: Math.ceil(totalUnits / unitsPerBar) }, (_, index) => {
    const unitsInBar = Math.min(unitsPerBar, totalUnits - index * unitsPerBar)
    return <span className="timeline-bar-label" key={index} style={{ width: (unitsInBar / totalUnits) * 100 + '%' }}>Bar {index + 1}</span>
  })
  const activeSampleIds = new Set(fixture.events.map((event) => event.sampleId))
  const lanes: Array<{ id: string; name: string; note: string; color: string | null }> = preset.samples.filter((sample) => activeSampleIds.has(sample.id)).map((sample) => {
    if (view === 'ttm' && !sample.silent) {
      const resolution = timelineGuideForSample(sample.id, sample.name, ttmAnnotations)
      const note = resolution.state === 'suggested'
        ? 'Suggested: ' + resolution.guide?.label
        : resolution.state === 'assigned'
          ? 'Guide: ' + (resolution.guide?.label ?? 'Unassigned')
          : resolution.state === 'untranscribed' ? 'Untranscribed' : 'Unassigned'
      return { id: sample.id, name: sample.name, note, color: sample.silent ? null : sampleColorForName(sample.name) }
    }
    return {
      id: sample.id,
      name: sample.name,
      note: sample.silent ? 'silent' : sample.durationUnits + (timebase === 'legacy' ? ' ticks' : ' units'),
      color: sample.silent ? null : sampleColorForName(sample.name),
    }
  })
  if (fixture.events.some((event) => event.sampleId === REST_SAMPLE_ID)) {
    lanes.push({ id: REST_SAMPLE_ID, name: 'Rest', note: 'unused time', color: null })
  }
  for (const event of fixture.events) {
    if (!lanes.some((lane) => lane.id === event.sampleId)) {
      lanes.push({ id: event.sampleId, name: event.sampleId, note: 'event', color: event.silent ? null : sampleColorForName(event.sampleId) })
    }
  }
  const eventDescription = fixture.events.map((event, index) => {
    const sample = preset.samples.find((candidate) => candidate.id === event.sampleId)
    const name = event.sampleId === REST_SAMPLE_ID ? 'Rest' : sample?.name ?? event.sampleId
    const startLabel = timebase === 'legacy' ? 'legacy tick ' : 'sixteenth unit '
    const durationLabel = timebase === 'legacy' ? ' legacy ticks' : ' units'
    const guideResolution = sample && !event.silent
      ? timelineGuideForSample(event.sampleId, sample.name, ttmAnnotations)
      : null
    const guideDescription = view === 'ttm' && !event.silent
      ? guideResolution?.guide
        ? (guideResolution.state === 'suggested' ? ', suggested illustrative TTM guide: ' : ', illustrative TTM guide: ')
          + guideResolution.guide.label + ', not an audio transcription'
        : guideResolution?.state === 'unassigned' ? ', TTM guide: Unassigned (Untranscribed)' : ', TTM guide: Untranscribed'
      : ''
    return <li key={event.id}>Event {index + 1}: {name}, starts at {startLabel}{event.startUnits + 1}, lasts {event.durationUnits}{durationLabel}{event.silent ? ', silent' : ''}{event.id === activeEventId ? (isPaused ? ', playback paused here' : ', now playing') : ''}{guideDescription}</li>
  })
  const renderSequenceEvent = (event: Fixture['events'][number], inline = false, eventNumber = 0) => {
    const waveform = event.silent ? undefined : waveforms.get(event.sampleId)
    const sample = preset.samples.find((candidate) => candidate.id === event.sampleId)
    const name = event.sampleId === REST_SAMPLE_ID ? 'Rest' : sample?.name ?? event.sampleId
    const guideResolution = !event.silent
      ? timelineGuideForSample(event.sampleId, sample?.name ?? event.sampleId, ttmAnnotations)
      : null
    const guide = guideResolution?.guide ?? null
    const sampleColor = event.silent ? null : sampleColorForName(sample?.name ?? event.sampleId)
    const active = event.id === activeEventId
    const slotDurationSeconds = timelineUnitsToSeconds(event.durationUnits, preset.bpm, unitsPerBeat)
    const geometry = waveform && slotDurationSeconds
      ? waveformDisplayGeometry(waveform.durationSeconds, slotDurationSeconds, waveform.peaks.length)
      : null
    const waveformClass = view === 'waveform' && waveform && geometry ? ' sequence-event--waveform' : ''
    const guideClass = view === 'ttm' && !event.silent
      ? guide ? ' sequence-event--ttm-guide' : ' sequence-event--ttm-' + guideResolution?.state
      : ''
    const sampleColorClass = sampleColor ? ' sequence-event--colored' : ''
    const inlineClass = inline ? ' sequence-event--inline' : ''
    const activeClass = active ? ' sequence-event--active' : ''
    const guideDescription = guide
      ? (guideResolution?.state === 'suggested' ? ' Suggested illustrative TTM guide: ' : ' Illustrative TTM guide: ')
        + guide.label + '; not an audio transcription.'
      : guideResolution?.state === 'unassigned'
        ? ' TTM guide is unassigned (Untranscribed).'
        : guideResolution?.state === 'untranscribed' ? ' TTM guide is explicitly set to Untranscribed.' : ''

    return (
      <span
        key={event.id}
        data-event-id={event.id}
        data-active={active ? 'true' : undefined}
        className={'sequence-event' + (event.silent ? ' sequence-event--silent' : '') + sampleColorClass + waveformClass + guideClass + inlineClass + activeClass}
        style={{ ...(sampleColor ? { '--sample-color': sampleColor } : {}), left: (event.startUnits / totalUnits) * 100 + '%', width: (event.durationUnits / totalUnits) * 100 + '%' } as CSSProperties}
        title={event.silent ? name + ': silent event' : (active ? activePlaybackLabel + ' · ' : '') + name + ': ' + event.durationUnits + ' units' + guideDescription}
      >
        {inline && <span className={view === 'ttm' ? 'sequence-inline-event-label sequence-inline-event-label--ttm' : 'sequence-inline-event-label'}>{view === 'ttm' ? eventNumber + ' · ' + name : (active ? activePlaybackLabel + ' · ' : '') + name}</span>}
        {view === 'waveform' && waveform && geometry && (
          <svg
            className="sequence-waveform"
            aria-hidden="true"
            preserveAspectRatio="none"
            viewBox={'0 0 ' + geometry.viewBoxWidth + ' ' + WAVEFORM_VIEWBOX_HEIGHT}
            style={{ width: geometry.widthPercent + '%' }}
          >
            <line x1="0" y1={WAVEFORM_VIEWBOX_HEIGHT / 2} x2={waveform.peaks.length} y2={WAVEFORM_VIEWBOX_HEIGHT / 2} />
            <path d={waveform.path} />
          </svg>
        )}
        {view === 'ttm' && guide && (
          <>
            <svg className="sequence-ttm-motion" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 100">
              <path d={ttmMotionSvgPath(guide.motion)} />
            </svg>
            <span className="sequence-ttm-fader" aria-hidden="true">
              {guide.faderIntervals.map((interval, index) => (
                <span
                  className={'sequence-ttm-fader__interval sequence-ttm-fader__interval--' + interval.state}
                  key={guide.id + '-fader-' + index}
                  style={{ left: (6 + interval.start * 88) + '%', width: ((interval.end - interval.start) * 88) + '%' }}
                ><span>{interval.state === 'open' ? 'OPEN' : 'CUT'}</span></span>
              ))}
            </span>
          </>
        )}
        {view === 'ttm' && !event.silent && !guide && (
          <span className="sequence-ttm-placeholder-mark" aria-hidden="true">
            {guideResolution?.state === 'untranscribed' ? '—' : '?'}
          </span>
        )}
      </span>
    )
  }

  return (
    <figure className="timeline-figure" aria-labelledby="timeline-caption">
      <figcaption id="timeline-caption" className="timeline-caption">
        <span>
          <strong>Sequence timeline</strong>
          <span>{fixture.totalUnits} {unitDescription} across {Math.ceil(fixture.totalUnits / unitsPerBar)} bars</span>
        </span>
        <fieldset className="timeline-layout-control" aria-label="Timeline layout">
          <legend>Layout</legend>
          <label><input type="radio" name="timeline-layout" value="grid" checked={layout === 'grid'} onChange={() => onLayoutChange('grid')} />Grid</label>
          <label><input type="radio" name="timeline-layout" value="inline" checked={layout === 'inline'} onChange={() => onLayoutChange('inline')} />Inline</label>
        </fieldset>
        <fieldset className="timeline-view-control" aria-label="Timeline view">
          <legend>View</legend>
          <label><input type="radio" name="timeline-view" value="waveform" checked={view === 'waveform'} onChange={() => onViewChange('waveform')} />Waveform</label>
          <label className={import.meta.env.DEV ? undefined : 'timeline-view-option--disabled'}>
            <input type="radio" name="timeline-view" value="ttm" checked={view === 'ttm'} disabled={!import.meta.env.DEV} onChange={() => { if (import.meta.env.DEV) onViewChange('ttm') }} />
            TTM practice guides{!import.meta.env.DEV && <small>Local debug only</small>}
          </label>
        </fieldset>
        <span className="timing-readout">{fixture.events.length} events</span>
      </figcaption>
      {view === 'ttm' && <div className="ttm-guide-legend" aria-label="TTM notation key">
        <span className="ttm-guide-legend__example">
          <svg viewBox="0 0 100 100" aria-hidden="true"><path d={ttmMotionSvgPath(TTM_GUIDES['baby-rub'].motion)} /></svg>
          <span>Example · {TTM_GUIDES['baby-rub'].label}</span>
        </span>
        <span>Time → · record forward ↑ / backward ↓</span>
        <span className="ttm-guide-legend__key"><span className="ttm-guide-legend__gate ttm-guide-legend__gate--open">OPEN</span> audible <span className="ttm-guide-legend__gate ttm-guide-legend__gate--closed">CUT</span> closed / muted</span>
        <span className="ttm-guide-legend__disclaimer">Illustrative guides only · not WAV transcriptions</span>
      </div>}
      <div
        className="timeline-scroll"
        role="img"
        tabIndex={0}
        aria-label={'Sequence timeline: ' + fixture.totalUnits + ' ' + unitDescription + ', ' + fixture.events.length + ' events'}
        data-presentation-started={presentationStarted ? 'true' : 'false'}
        data-presentation-position-units={presentationPositionUnits === null ? undefined : String(presentationPositionUnits)}
        data-cycle-slot-kind={presentationCycleSlotKind}
        data-cycle-plan-index={presentationCyclePlanIndex}
      >
        <div className="timeline-board" style={{ minWidth: minBoardWidth }}>
          <div className="timeline-bar-row">
            <span className="timeline-axis-label">BAR</span>
            <div className="timeline-bar-labels">{bars}</div>
          </div>
          <div className="timeline-ruler-row">
            <span className="timeline-axis-label">BEAT</span>
            <div className="timeline-ruler" style={{ gridTemplateColumns: 'repeat(' + totalUnits + ', minmax(8px, 1fr))' }}>
              {unitNumbers.map((unit) => <span className={unit % unitsPerBeat === 0 ? 'ruler-cell ruler-cell--beat' : 'ruler-cell'} key={unit}>{unit % unitsPerBeat === 0 ? String((Math.floor(unit / unitsPerBeat) % 4) + 1) : ''}</span>)}
            </div>
          </div>
          {layout === 'grid' && lanes.map((lane) => {
            const events = fixture.events.filter((event) => event.sampleId === lane.id)
            return (
              <div className={'timeline-lane' + (view === 'ttm' ? ' timeline-lane--ttm' : '') + (lane.id === auditionedSampleId ? ' timeline-lane--auditioned' : '') + (lane.id === activeSampleId ? ' timeline-lane--active' : '')} key={lane.id} style={lane.color ? { '--sample-color': lane.color } as CSSProperties : undefined}>
                <span className={view === 'ttm' ? 'timeline-lane-label timeline-lane-label--ttm' : 'timeline-lane-label'}>
                  <span className="timeline-lane-name"><span className={lane.color ? 'timeline-color-swatch' : 'timeline-color-swatch timeline-color-swatch--silent'} aria-hidden="true" /><span className="timeline-lane-name-text">{lane.name}</span></span>
                  <small>{lane.note}</small>
                  {lane.id === activeSampleId && <span className="timeline-now-playing">{activePlaybackLabel}</span>}
                </span>
                <span className={view === 'ttm' ? 'timeline-track timeline-track--ttm' : 'timeline-track'} aria-hidden="true" style={{ gridTemplateColumns: 'repeat(' + totalUnits + ', minmax(8px, 1fr))' }}>
                  {unitNumbers.map((unit) => <span className={unit % unitsPerBeat === 0 ? 'timeline-tick timeline-tick--beat' : 'timeline-tick'} key={unit} />)}
                  {events.map((event) => renderSequenceEvent(event, false, fixture.events.findIndex((candidate) => candidate.id === event.id) + 1))}
                  {isPlaying && <span className="timeline-playhead" style={{ left: Math.min(Math.max(progress, 0), 1) * 100 + '%' }} />}
                </span>
              </div>
            )
          })}
          {layout === 'inline' && (
            <div className="timeline-inline-row">
              <span className="timeline-axis-label">EVENT</span>
              <span className={view === 'ttm' ? 'timeline-track timeline-track--inline timeline-track--inline-ttm' : 'timeline-track timeline-track--inline'} aria-hidden="true" style={{ gridTemplateColumns: 'repeat(' + totalUnits + ', minmax(8px, 1fr))' }}>
                {unitNumbers.map((unit) => <span className={unit % unitsPerBeat === 0 ? 'timeline-tick timeline-tick--beat' : 'timeline-tick'} key={unit} />)}
                {fixture.events.map((event, index) => renderSequenceEvent(event, true, index + 1))}
                {isPlaying && <span className="timeline-playhead" style={{ left: Math.min(Math.max(progress, 0), 1) * 100 + '%' }} />}
              </span>
            </div>
          )}
        </div>
      </div>
      {view === 'ttm' && <p className="timeline-guide-note">TTM practice guides are finite teaching examples, not WAV transcriptions. Exact labels Baby, Baby (F), Baby F, Baby(F), Baby (R), Baby Rev, Baby(R), and Chirp may suggest an example; other labels stay Unassigned. Baby scratch / rub keeps the fader open, forward movement is one open stroke, forward scratch / cut mutes the return, and Chirp shows a narrow illustrative cut at the turn. <a href="#sample-section">Edit a sample</a> to assign a guide or explicitly choose Untranscribed. <a href="https://www.ttm-dj.com/ttm-01-01-basics/" target="_blank" rel="noreferrer">TTM basics</a>.</p>}
      <ol className="visually-hidden" aria-label="Sequence events">{eventDescription}</ol>
    </figure>
  )
}
