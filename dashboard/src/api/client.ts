import { fetchAuthSession } from 'aws-amplify/auth';

const API_URL = (import.meta.env.VITE_API_URL as string) || '';

async function getToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) {
    window.location.href = '/login';
    throw new Error('Unauthenticated');
  }
  return token;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  params?: Record<string, string>,
): Promise<T> {
  const token = await getToken();

  const url = new URL(`${API_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  return request<T>(path, { method: 'GET' }, params);
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}
