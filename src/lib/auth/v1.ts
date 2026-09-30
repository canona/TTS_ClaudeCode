import 'server-only';
import { authenticate, type ApiClient } from './clients';

/**
 * Helpers shared by the /api/v1 routes: one error format for partners,
 * `{ "error": { "code": "...", "message": "..." } }`. `code` is stable and
 * meant for programs; `message` is in Vietnamese when the request's
 * Accept-Language starts with "vi", in English otherwise.
 */

export type ApiErrorCode =
  | 'missing_key'
  | 'invalid_key'
  | 'client_disabled'
  | 'invalid_request'
  | 'text_too_long'
  | 'engine_not_allowed'
  | 'voice_not_found'
  | 'cloning_not_allowed'
  | 'voice_limit_reached'
  | 'rate_limited'
  | 'too_many_concurrent'
  | 'server_busy'
  | 'quota_exceeded'
  | 'engine_unavailable'
  | 'synthesis_failed'
  | 'internal_error';

const STATUS: Record<ApiErrorCode, number> = {
  missing_key: 401,
  invalid_key: 401,
  client_disabled: 403,
  invalid_request: 400,
  text_too_long: 413,
  engine_not_allowed: 403,
  voice_not_found: 404,
  cloning_not_allowed: 403,
  voice_limit_reached: 409,
  rate_limited: 429,
  too_many_concurrent: 429,
  server_busy: 503,
  quota_exceeded: 429,
  engine_unavailable: 503,
  synthesis_failed: 502,
  internal_error: 500,
};

const DEFAULT_MESSAGES: Partial<Record<ApiErrorCode, { en: string; vi: string }>> = {
  missing_key: { en: 'Missing API key: send "Authorization: Bearer <key>".', vi: 'Thiếu API key: gửi header "Authorization: Bearer <key>".' },
  invalid_key: { en: 'Invalid API key.', vi: 'API key không hợp lệ.' },
  client_disabled: { en: 'This API client is disabled.', vi: 'Tài khoản API này đã bị khóa.' },
  voice_not_found: { en: 'Voice not found.', vi: 'Không tìm thấy giọng đọc.' },
  cloning_not_allowed: { en: 'Voice cloning is not enabled for this client.', vi: 'Tài khoản chưa được bật tính năng nhân bản giọng.' },
  rate_limited: { en: 'Too many requests, retry later.', vi: 'Gửi quá nhiều yêu cầu, hãy thử lại sau.' },
  too_many_concurrent: {
    en: 'Another request of this client is still running: wait for it to finish.',
    vi: 'Một yêu cầu khác của tài khoản đang chạy: hãy chờ nó xong.',
  },
  server_busy: { en: 'The server is busy, retry later.', vi: 'Máy chủ đang bận, hãy thử lại sau.' },
  internal_error: { en: 'Internal error.', vi: 'Lỗi hệ thống.' },
};

export interface Bilingual {
  en: string;
  vi: string;
}

export function wantsVietnamese(request: Request): boolean {
  return /^\s*vi\b/i.test(request.headers.get('accept-language') ?? '');
}

export function apiError(
  request: Request,
  code: ApiErrorCode,
  message?: Bilingual | string,
  headers?: Record<string, string>,
): Response {
  const m = message ?? DEFAULT_MESSAGES[code] ?? { en: code, vi: code };
  const text = typeof m === 'string' ? m : wantsVietnamese(request) ? m.vi : m.en;
  return Response.json({ error: { code, message: text } }, { status: STATUS[code], headers: { 'Cache-Control': 'no-store', ...headers } });
}

/** The calling client, or the error response to return. */
export async function requireClient(request: Request): Promise<{ client: ApiClient } | { response: Response }> {
  const auth = await authenticate(request);
  if (auth.ok) return { client: auth.client };
  return { response: apiError(request, auth.reason, undefined, { 'WWW-Authenticate': 'Bearer' }) };
}
