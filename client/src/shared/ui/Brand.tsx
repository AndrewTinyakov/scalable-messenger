export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="brand-mark">
      <path
        d="M32 8C18.7 8 8 17.4 8 29c0 6.8 3.7 12.9 9.5 16.7-.4 2.9-1.7 5.7-3.7 7.9 4.4-.2 8.4-1.7 11.9-4.2 2 .4 4.1.6 6.3.6 13.3 0 24-9.4 24-21S45.3 8 32 8Z"
        fill="currentColor"
      />
    </svg>
  )
}
