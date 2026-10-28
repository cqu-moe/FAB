export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? 'GET';
  const body = init.body ?? (method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}));
  const response = await fetch(path, {
    ...init,
    body,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }

  return payload as T;
}
