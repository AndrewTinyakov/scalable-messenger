export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="brand-mark">
      <defs>
        <linearGradient
          id="brand-gradient"
          x1="8"
          y1="4"
          x2="56"
          y2="60"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#5cb2ff" />
          <stop offset="1" stopColor="#2a63e6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="20" fill="url(#brand-gradient)" />
      <path
        d="M32 14c-10.5 0-19 7.4-19 16.6 0 5.4 2.9 10.1 7.4 13.2-.3 2.3-1.3 4.4-2.9 6.2 3.5-.2 6.7-1.3 9.4-3.3 1.6.3 3.3.5 5.1.5 10.5 0 19-7.4 19-16.6S42.5 14 32 14Z"
        fill="#fff"
      />
      <path
        d="m24 31 6 6 11-12"
        fill="none"
        stroke="#2a63e6"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
