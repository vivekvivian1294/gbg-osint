/** `request.ip` can be undefined (e.g. unix sockets, injected test requests). */
export function clientKey(ip: string | undefined): string {
  return ip ?? 'unknown';
}
