export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand-compact' : ''}`} aria-label="Messenger">
      <span className="brand-mark" aria-hidden="true">
        <span />
      </span>
      <span className="brand-word">Messenger</span>
    </div>
  )
}
