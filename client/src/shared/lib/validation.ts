export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length === 26 && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)
  )
}

export function isDateTime(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value) return false
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    )
  if (!match) return false
  const [
    ,
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
    ,
    offsetHour,
    offsetMinute,
  ] = match
  const year = Number(yearValue)
  const month = Number(monthValue)
  const day = Number(dayValue)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    Number(hourValue) <= 23 &&
    Number(minuteValue) <= 59 &&
    Number(secondValue) <= 59 &&
    (offsetHour === undefined || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59)) &&
    Number.isFinite(Date.parse(value))
  )
}

export function isSequence(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  )
}

export function isStreamId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    /^[0-9]{1,20}-[0-9]{1,20}$/.test(value) &&
    value.split('-').every((part) => BigInt(part) <= 18446744073709551615n)
  )
}
const sendRejectionReasons = new Set([
  'NOT_A_MEMBER',
  'CHAT_NOT_FOUND',
  'RECIPIENT_NOT_FOUND',
  'INVALID_RECIPIENT',
  'INVALID_REPLY_TARGET',
  'EMPTY_BODY',
  'BODY_TOO_LONG',
  'REQUEST_ID_CONFLICT',
  'PROCESSING_FAILED',
])

export function isSendRejectionReason(value: unknown): value is string {
  return typeof value === 'string' && sendRejectionReasons.has(value)
}
