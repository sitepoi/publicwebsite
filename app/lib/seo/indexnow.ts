/**
 * IndexNow ping (M4) — one-call submission to api.indexnow.org.
 * NEVER fatal: callers log + swallow failures (publishing must not break).
 */
export interface IndexNowNotifyInput {
  /** Full https URL to submit. */
  url: string
  /** IndexNow key (INDEXNOW_API_KEY env). */
  key: string
}

export async function notifyIndexNow(
  input: IndexNowNotifyInput,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return false
  }
  const body = {
    host: parsed.host,
    key: input.key,
    keyLocation: `https://${parsed.host}/${input.key}.txt`,
    urlList: [input.url],
  }
  try {
    const response = await fetchFn('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return response.ok || response.status === 202
  } catch {
    return false
  }
}
