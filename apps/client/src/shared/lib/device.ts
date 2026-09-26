const deviceKey = "folio.device";
export function deviceId(): string {
  let value = localStorage.getItem(deviceKey);
  if (!value) {
    value = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem(deviceKey, value);
  }
  return value;
}
