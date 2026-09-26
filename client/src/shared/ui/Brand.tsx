export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand-compact' : ''}`} aria-label="Relay messenger">
      <span className="brand-mark" aria-hidden="true"><span /></span>
      <span className="brand-word">relay<span className="brand-period">.</span></span>
    </div>
  )
}
