/** Shared District HTTP transport, host validation, poster extraction, and JSON guards. */
import { cleanWatchInput } from "./movie-model.ts";
import { BmsError } from "./provider-error.ts";

export type JsonObject = Record<string, unknown>;

const GENERIC_ASSET_RE = /(?:favicon|apple-touch-icon|site-logo|default-share|\/logo[./_-])/i;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

export function isDistrictCandidate(raw: string): boolean {
  return /^(?:https?:\/\/)?(?:[^/?#@]+@)?(?:[a-z0-9-]+\.)*district\.in(?:[:/?#]|$)/i.test(raw);
}

export function parseDistrictHostUrl(
  input: string,
  malformedMessage: string,
  wrongHostMessage: string,
): URL {
  const cleaned = cleanWatchInput(input);
  let url: URL;
  try {
    const normalized = cleaned.replace(/^(?=(?:(?:www|m)\.)?district\.in(?:\/|$))/i, "https://");
    url = new URL(normalized);
  } catch {
    throw new BmsError("bad_url", malformedMessage);
  }

  const host = url.hostname.toLowerCase();
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !["district.in", "www.district.in", "m.district.in"].includes(host) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new BmsError("bad_url", wrongHostMessage);
  }
  return url;
}

function validHttpsPoster(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("https://") || GENERIC_ASSET_RE.test(trimmed)) return undefined;
  return trimmed;
}

export function extractDistrictPoster(candidates: unknown[], html: string): string | undefined {
  for (const candidate of candidates) {
    const url = validHttpsPoster(candidate);
    if (url) return url;
  }
  const og =
    html.match(
      /<meta\b[^>]*\bproperty=["']og:image["'][^>]*\bcontent=["'](https:\/\/[^"']+)["']/i,
    )?.[1] ??
    html.match(
      /<meta\b[^>]*\bcontent=["'](https:\/\/[^"']+)["'][^>]*\bproperty=["']og:image["']/i,
    )?.[1];
  return validHttpsPoster(og);
}

export async function fetchDistrictHtml(
  url: string,
  label: string,
  notFoundMessage: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  } catch (e) {
    throw new BmsError("network", `${label} request failed: ${(e as Error).message}`);
  }

  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    throw new BmsError("not_found", notFoundMessage);
  }
  if (!res.ok) {
    const retryAfter = res.headers.get("retry-after")?.trim();
    await res.body?.cancel().catch(() => {});
    const suffix = retryAfter ? ` (Retry-After: ${retryAfter})` : "";
    throw new BmsError("blocked", `${label} HTTP ${res.status}${suffix}`);
  }

  return res.text();
}
