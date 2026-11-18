import type {Json} from './json.ts';

export function unpack(result: Json, allowText = false): Json {
  if (result.structuredContent) { if (result.isError && !problem(result.structuredContent)) throw new Error("District returned a tool error. No action was retried."); return result.structuredContent; }
  for (const c of result.content ?? []) if (c.type === "text") { try { const data = JSON.parse(c.text); if (result.isError && !problem(data)) throw new Error("District returned a tool error. No action was retried."); return data; } catch (e) { if (e instanceof Error && !(e instanceof SyntaxError)) throw e; } }
  const text = (result.content ?? []).filter((c: Json) => c.type === "text").map((c: Json) => c.text).join("\n");
  if (/LOGIN_REQUIRED|log.?in required|not logged in|sign.?in required|please log in/i.test(text)) return { code: "LOGIN_REQUIRED" };
  if (result.isError) throw new Error("District rejected the request. No action was retried.");
  const confirmation = text.match(/^CONFIRMATION_REQUIRED: nothing has been done yet\. Show the user exactly this and ask them to confirm: "([\s\S]+?)" If and only if they clearly say yes, call (act|pay) again with the same arguments and confirmation_id "([^"\s]+)" \(valid for (\d+) minutes\)\./);
  if (confirmation) return { code: "CONFIRMATION_REQUIRED", summary: confirmation[1], confirmation_tool: confirmation[2], confirmation_id: confirmation[3] };
  if (allowText && text.trim()) return { message: text, text_response: true };
  throw new Error("District returned an unsupported response. No action was retried.");
}
export function problem(data: Json): string | undefined { return data.error?.code ?? data.code; }
