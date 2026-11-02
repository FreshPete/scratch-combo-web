import './PracticeLibrary.css'
import type { SavedRecordSummary } from './session-library/storage'

export interface PracticeLibraryProps {
  sessionName: string
  favoriteName: string
  sessions: readonly SavedRecordSummary[]
  favorites: readonly SavedRecordSummary[]
  lastSavedSessionId: string | null
  selectedSessionId: string
  selectedFavoriteId: string
  currentSessionName: string
  busy: boolean
  canSave: boolean
  available: boolean
  hasFixture: boolean
  message: string
  error: string | null
  onSessionNameChange: (value: string) => void
  onFavoriteNameChange: (value: string) => void
  onSelectedSessionChange: (value: string) => void
  onSelectedFavoriteChange: (value: string) => void
  onSaveSession: () => void
  onSaveSessionAsNew: () => void
  onLoadSession: () => void
  onReloadLast: () => void
  onDeleteSession: () => void
  onSaveFavorite: () => void
  onLoadFavorite: () => void
  onDeleteFavorite: () => void
}

function savedLabel(record: SavedRecordSummary): string {
  const date = new Date(record.updatedAt)
  const when = Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
  return when ? `${record.name} · ${when}` : record.name
}

export function PracticeLibrary({
  sessionName,
  favoriteName,
  sessions,
  favorites,
  lastSavedSessionId,
  selectedSessionId,
  selectedFavoriteId,
  currentSessionName,
  busy,
  canSave,
  available,
  hasFixture,
  message,
  error,
  onSessionNameChange,
  onFavoriteNameChange,
  onSelectedSessionChange,
  onSelectedFavoriteChange,
  onSaveSession,
  onSaveSessionAsNew,
  onLoadSession,
  onReloadLast,
  onDeleteSession,
  onSaveFavorite,
  onLoadFavorite,
  onDeleteFavorite,
}: PracticeLibraryProps) {
  const selectedSession = sessions.find((record) => record.id === selectedSessionId)
  const selectedFavorite = favorites.find((record) => record.id === selectedFavoriteId)
  const latestSession = sessions.find((record) => record.id === lastSavedSessionId)

  return (
    <section className="practice-library" aria-labelledby="practice-library-heading">
      <div className="practice-library__heading">
        <div>
          <h3 id="practice-library-heading">Saved sessions</h3>
          <p>Saved locally in this browser only. Nothing is uploaded.</p>
        </div>
        <span className="practice-library__count">{sessions.length} sessions · {favorites.length} favourites</span>
      </div>

      <div className="practice-library__quick-row">
        <label className="practice-library__field" htmlFor="saved-sessions-select">
          <span>Session</span>
          <select
            id="saved-sessions-select"
            data-testid="saved-sessions-select"
            value={selectedSessionId}
            disabled={!available || busy || sessions.length === 0}
            onChange={(event) => onSelectedSessionChange(event.currentTarget.value)}
          >
            <option value="">No saved sessions</option>
            {sessions.map((record) => <option key={record.id} value={record.id}>{savedLabel(record)}</option>)}
          </select>
        </label>
        <button className="button button--primary" type="button" data-testid="load-session" disabled={!available || busy || !selectedSession} onClick={onLoadSession}>Load session</button>
        <button className="button" type="button" data-testid="reload-last-session" disabled={!available || busy || !latestSession} onClick={onReloadLast}>Reload last saved</button>
      </div>

      <details className="practice-library__manage">
        <summary>Save and manage sessions</summary>
        <div className="practice-library__favorite-load">
          <label className="practice-library__field" htmlFor="favorite-combos-select">
            <span>Favourite combo</span>
            <select
              id="favorite-combos-select"
              data-testid="favorite-combos-select"
              value={selectedFavoriteId}
              disabled={!available || busy || favorites.length === 0}
              onChange={(event) => onSelectedFavoriteChange(event.currentTarget.value)}
            >
              <option value="">No favourite combos</option>
              {favorites.map((record) => <option key={record.id} value={record.id}>{savedLabel(record)}</option>)}
            </select>
          </label>
          <button className="button" type="button" data-testid="load-favorite" disabled={!available || busy || !selectedFavorite} onClick={onLoadFavorite}>Load favourite combo</button>
        </div>
        <p className="practice-library__manage-copy">Save session updates the session you loaded. Save as new session keeps it and creates another copy.</p>
        <div className="practice-library__manage-group">
          <h4>Session</h4>
          <div className="practice-library__save-row">
            <label className="practice-library__field" htmlFor="saved-session-name">
              <span>Session name</span>
              <input
                id="saved-session-name"
                data-testid="saved-session-name"
                type="text"
                maxLength={64}
                placeholder={currentSessionName}
                value={sessionName}
                disabled={!available || busy || !canSave}
                onChange={(event) => onSessionNameChange(event.currentTarget.value)}
              />
            </label>
            <div className="practice-library__save-actions">
              <button className="button button--primary" type="button" data-testid="save-session" disabled={!available || busy || !canSave} onClick={onSaveSession}>Save session</button>
              <button className="button" type="button" data-testid="save-session-as-new" disabled={!available || busy || !canSave} onClick={onSaveSessionAsNew}>Save as new session</button>
            </div>
          </div>
          <div className="practice-library__manage-actions">
            <button className="button button--danger" type="button" data-testid="delete-session" disabled={!available || busy || !selectedSession} onClick={onDeleteSession}>Delete selected session</button>
          </div>
        </div>

        <div className="practice-library__manage-group">
          <h4>Favourite combo</h4>
          <div className="practice-library__save-row">
            <label className="practice-library__field" htmlFor="favorite-name">
              <span>Favourite combo name</span>
              <input
                id="favorite-name"
                data-testid="favorite-name"
                type="text"
                maxLength={64}
                placeholder={currentSessionName + ' combo'}
                value={favoriteName}
                disabled={!available || busy || !canSave}
                onChange={(event) => onFavoriteNameChange(event.currentTarget.value)}
              />
            </label>
            <button className="button" type="button" data-testid="save-favorite" disabled={!available || busy || !canSave || !hasFixture} onClick={onSaveFavorite}>Save combo as favourite</button>
          </div>
          <div className="practice-library__manage-actions">
            <button className="button button--danger" type="button" data-testid="delete-favorite" disabled={!available || busy || !selectedFavorite} onClick={onDeleteFavorite}>Delete selected favourite</button>
          </div>
        </div>
      </details>

      {!available && !message && <p className="practice-library__notice" role="status">Checking local browser storage…</p>}
      {message && <p className="practice-library__notice" role="status" aria-live="polite">{message}</p>}
      {error && <p className="practice-library__error" role="alert">{error}</p>}
    </section>
  )
}
