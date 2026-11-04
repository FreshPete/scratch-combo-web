import { useEffect, useRef } from 'react'
import type { AssetResolution, Preset, PresetAssetResolution, SampleDefinition } from './domain'
import { SYNTHETIC_SAMPLE_IDS } from './domain/demo'
import { suggestedGuideForSampleName, UNTRANSCRIBED, TTM_GUIDES, type TtmSampleGuideSelection } from './notation/ttm-guides'

function sampleFileState(
  sample: SampleDefinition,
  asset: AssetResolution | undefined,
): { label: string; tone: 'ready' | 'missing' | 'muted' } {
  if (sample.silent) return { label: 'Marked silent', tone: 'muted' }
  if (SYNTHETIC_SAMPLE_IDS.has(sample.id)) return { label: 'Demo sound', tone: 'ready' }
  if (asset?.status === 'resolved') return { label: asset.selectedPath ?? sample.fileName, tone: 'ready' }
  if (asset?.status === 'ambiguous') return { label: 'Ambiguous file match', tone: 'missing' }
  return { label: 'WAV needed', tone: 'missing' }
}

function formatWeight(weight: number): string {
  return Number.isInteger(weight) ? String(weight) : weight.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function SampleEditor({
  sample, draft, disabled, ttmGuide, ttmGuideIsExplicit, onDraftChange, onTtmGuideChange, onSave, onCancel,
}: {
  sample: SampleDefinition
  draft: SampleDefinition
  disabled: boolean
  ttmGuide: TtmSampleGuideSelection
  ttmGuideIsExplicit: boolean
  onDraftChange: (next: SampleDefinition) => void
  onTtmGuideChange: (selection: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const durationRef = useRef<HTMLInputElement>(null)
  useEffect(() => { durationRef.current?.focus() }, [sample.id])
  const numericValue = (value: number) => Number.isFinite(value) ? value : ''
  const setNumeric = (field: 'durationUnits' | 'weight' | 'maxRepeat', raw: string) => {
    onDraftChange({ ...draft, [field]: raw === '' ? Number.NaN : Number(raw) })
  }
  const suggestedGuide = suggestedGuideForSampleName(sample.name)
  const selectedGuideId = typeof ttmGuide === 'string'
    ? ttmGuide
    : !ttmGuideIsExplicit && suggestedGuide ? suggestedGuide : UNTRANSCRIBED.kind
  const guideHelperText = !ttmGuideIsExplicit && suggestedGuide
    ? 'Suggested from the exact sample label only: ' + TTM_GUIDES[suggestedGuide].label + '. Choose a guide or Untranscribed; no audio is analyzed.'
    : !ttmGuideIsExplicit
      ? 'No guide is assigned. Choose an illustrative guide or leave this sample Untranscribed.'
      : typeof ttmGuide !== 'string'
        ? 'Explicitly Untranscribed for this session. Choose a guide to add an illustrative pattern.'
        : 'Session-only illustrative guide; this does not change audio or INI data.'
  return (
    <form className="sample-editor" aria-label={'Edit ' + sample.name} noValidate onSubmit={(event) => { event.preventDefault(); onSave() }}>
      <div className="sample-editor__heading">
        <div>
          <h3>Edit {sample.name}</h3>
          <p>These values apply to the next generated combo. File and sample metadata stay read-only.</p>
        </div>
        <span className="sample-editor__id">{sample.id}</span>
      </div>
      <div className="sample-editor__fields">
        <label className="sample-editor__field" htmlFor="sample-duration">
          <span>Duration ticks</span>
          <input ref={durationRef} id="sample-duration" aria-label="Duration ticks" type="number" min="0" max="512" step="1" value={numericValue(draft.durationUnits)} disabled={disabled} onChange={(event) => setNumeric('durationUnits', event.currentTarget.value)} />
        </label>
        <label className="sample-editor__field" htmlFor="sample-weight">
          <span>Play weight</span>
          <input id="sample-weight" aria-label="Play weight" type="number" min="0" max="10000" step="1" value={numericValue(draft.weight)} disabled={disabled} onChange={(event) => setNumeric('weight', event.currentTarget.value)} />
        </label>
        <label className="sample-editor__field" htmlFor="sample-start-direction">
          <span>Start direction</span>
          <select id="sample-start-direction" value={draft.startForward ? 'forward' : 'reverse'} disabled={disabled} onChange={(event) => onDraftChange({ ...draft, startForward: event.currentTarget.value === 'forward' })}>
            <option value="forward">Forward</option><option value="reverse">Reverse</option>
          </select>
        </label>
        <label className="sample-editor__field" htmlFor="sample-end-direction">
          <span>End direction</span>
          <select id="sample-end-direction" value={draft.endForward ? 'forward' : 'reverse'} disabled={disabled} onChange={(event) => onDraftChange({ ...draft, endForward: event.currentTarget.value === 'forward' })}>
            <option value="forward">Forward</option><option value="reverse">Reverse</option>
          </select>
        </label>
        <label className="sample-editor__field" htmlFor="sample-repeat-max">
          <span>Repeat maximum</span>
          <input id="sample-repeat-max" aria-label="Repeat maximum" type="number" min="0" max="8192" step="1" value={numericValue(draft.maxRepeat)} disabled={disabled} onChange={(event) => setNumeric('maxRepeat', event.currentTarget.value)} />
        </label>
        <label className="sample-editor__check" htmlFor="sample-can-repeat">
          <input id="sample-can-repeat" type="checkbox" checked={draft.canRepeat} disabled={disabled} onChange={(event) => onDraftChange({ ...draft, canRepeat: event.currentTarget.checked })} />
          <span>Repeat allowed</span>
        </label>
        <label className="sample-editor__check" htmlFor="sample-use">
          <input id="sample-use" type="checkbox" checked={draft.enabled || draft.silent} disabled={disabled || draft.silent} onChange={(event) => onDraftChange({ ...draft, enabled: event.currentTarget.checked })} />
          <span>{draft.silent ? 'Use sample · always included (silent)' : 'Use sample'}</span>
        </label>
        {import.meta.env.DEV && <label className="sample-editor__field sample-editor__field--guide" htmlFor="sample-ttm-guide">
          <span>TTM guide</span>
          <select id="sample-ttm-guide" aria-label={'TTM guide for ' + sample.name} value={selectedGuideId} disabled={disabled} onChange={(event) => onTtmGuideChange(event.currentTarget.value)}>
            <option value={UNTRANSCRIBED.kind}>{!ttmGuideIsExplicit && !suggestedGuide ? 'Unassigned · Untranscribed' : 'Untranscribed'}</option>
            {Object.values(TTM_GUIDES).map((guide) => <option key={guide.id} value={guide.id}>{!ttmGuideIsExplicit && suggestedGuide === guide.id ? 'Suggested: ' : ''}{guide.label}</option>)}
          </select>
          <small>{guideHelperText}</small>
        </label>}
      </div>
      <div className="sample-editor__actions">
        <button className="button button--small" type="button" disabled={disabled} onClick={onCancel}>Cancel</button>
        <button className="button button--small button--primary" type="submit" disabled={disabled}>Save sample changes</button>
      </div>
    </form>
  )
}

export function SampleTable({
  preset, resolution, actionsDisabled, legacyMode, sourceAvailable, editingSample, saveError, isSavingData,
  ttmAnnotations, onTtmGuideChange, onToggle, onPreview, onEdit, onDraftChange, onSaveEdit, onCancelEdit, onSaveData,
}: {
  preset: Preset
  resolution: PresetAssetResolution | undefined
  actionsDisabled: boolean
  legacyMode: boolean
  sourceAvailable: boolean
  editingSample: SampleDefinition | null
  saveError: string | null
  isSavingData: boolean
  ttmAnnotations: Readonly<Record<string, TtmSampleGuideSelection>>
  onTtmGuideChange: (sampleId: string, selection: string) => void
  onToggle: (sample: SampleDefinition, enabled: boolean) => void
  onPreview: (sample: SampleDefinition) => void
  onEdit: (sample: SampleDefinition) => void
  onDraftChange: (sample: SampleDefinition) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onSaveData: () => void
}) {
  return (
    <section id="sample-section" className="workspace-section sample-section" aria-labelledby="samples-heading">
      <div className="section-heading">
        <div>
          <h2 id="samples-heading">Sample settings</h2>
          <p>{legacyMode ? 'Choose and edit eligible samples for the next generated combo. Silent rows stay included. Changes are held in this session until you save a working INI copy.' : 'Enable or disable samples for the next preview. Source files are never changed.'}</p>
        </div>
        <div className="sample-section__actions">
          {sourceAvailable && <button className="button button--small" type="button" disabled={actionsDisabled || Boolean(editingSample) || isSavingData} onClick={onSaveData}>{isSavingData ? 'Saving…' : 'Save Sample Data'}</button>}
          <span className="sample-count">{preset.samples.length} {preset.samples.length === 1 ? 'sample' : 'samples'}</span>
        </div>
      </div>
      {editingSample && <SampleEditor
        sample={preset.samples.find((sample) => sample.id === editingSample.id) ?? editingSample}
        draft={editingSample}
        disabled={actionsDisabled}
        ttmGuide={ttmAnnotations[editingSample.id] ?? UNTRANSCRIBED}
        ttmGuideIsExplicit={Object.hasOwn(ttmAnnotations, editingSample.id)}
        onDraftChange={onDraftChange}
        onTtmGuideChange={(selection) => onTtmGuideChange(editingSample.id, selection)}
        onSave={onSaveEdit}
        onCancel={onCancelEdit}
      />}
      {saveError && <p className="inline-error" role="alert">{saveError}</p>}
      <div
        className="sample-table-scroll"
        role="region"
        aria-labelledby="samples-heading"
        aria-describedby="sample-table-scroll-help"
        tabIndex={0}
      >
        <span className="visually-hidden" id="sample-table-scroll-help">Use the arrow keys to scroll through the sample rows and columns.</span>
        <table className="sample-table">
          <thead><tr>
            <th scope="col">Sample</th><th scope="col">File reference</th><th scope="col">Length</th>
            <th scope="col">Weight</th><th scope="col">Direction</th><th scope="col">Repeat</th>
            <th scope="col">Use</th>{sourceAvailable && <th scope="col">Edit</th>}<th scope="col">Preview</th>
          </tr></thead>
          <tbody>
            {preset.samples.map((sample) => {
              const asset = resolution?.samplesById.get(sample.id)
              const fileState = sampleFileState(sample, asset)
              return (
                <tr key={sample.id}>
                  <th scope="row"><span className="sample-name">{sample.name}</span><span className="sample-id">{sample.id}</span></th>
                  <td>
                    <span className={'file-state file-state--' + fileState.tone}>{fileState.label}</span>
                    {sample.fileName && <code className="file-reference" title={sample.fileName}>{sample.fileName}</code>}
                    {asset?.status === 'ambiguous' && <span className="file-detail">{asset.candidates.length} matching files</span>}
                  </td>
                  <td className="numeric-cell">{sample.durationUnits} {legacyMode ? 'legacy ticks' : 'units'}</td>
                  <td className="numeric-cell">{formatWeight(sample.weight)}</td>
                  <td><span className="direction-value">{sample.startForward ? 'Forward' : 'Reverse'} / {sample.endForward ? 'Forward' : 'Reverse'}</span><span className="file-detail">start / end</span></td>
                  <td><span>{sample.canRepeat ? 'Repeat flag on' : 'Repeat flag off'}</span><span className="file-detail">Configured value: {sample.maxRepeat}</span></td>
                  <td>
                    <label className="toggle-control">
                      <input type="checkbox" checked={sample.enabled || sample.silent} aria-label={'Enable ' + sample.name + ' for ' + (legacyMode ? 'next combo' : 'preview')} disabled={actionsDisabled || sample.silent} onChange={(event) => onToggle(sample, event.currentTarget.checked)} />
                      <span className="toggle-control__track" aria-hidden="true"><span /></span>
                      <span className="toggle-control__text">{sample.silent ? 'Always included' : sample.enabled ? 'On' : 'Off'}</span>
                    </label>
                  </td>
                  {sourceAvailable && <td><button className="button button--small" type="button" aria-label={'Edit ' + sample.name} disabled={actionsDisabled} onClick={() => onEdit(sample)}>Edit</button></td>}
                  <td>
                    {sample.silent
                      ? <span className="file-state file-state--muted" title="Silent samples remain included in generated combos, but have no audio preview.">Silent</span>
                      : <button className="button button--small" type="button" aria-label={'Preview ' + sample.name} title={actionsDisabled ? 'Wait for the preset import or combo generation to finish.' : undefined} disabled={actionsDisabled} onClick={() => onPreview(sample)}>Preview</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
