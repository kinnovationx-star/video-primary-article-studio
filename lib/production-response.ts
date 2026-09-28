type Json = Record<string, unknown>;

export function parseGeneratedJson(value: string): Json {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("AIの出力が不完全でした。入力内容を保持したまま再実行できます。");
  try {
    const result: unknown = JSON.parse(cleaned.slice(start, end + 1));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result as Json;
  } catch {
    throw new Error("AIの出力形式を確認できませんでした。入力内容を保持したまま再実行できます。");
  }
}

export function generatedText(payload: Json): string {
  if (payload.stop_reason === "max_tokens")
    throw new Error("AIの出力が長さの上限に達しました。記事を再生成してください。");
  if (payload.stop_reason === "refusal")
    throw new Error("AIがこの内容を生成できませんでした。入力内容を確認してください。");
  const content = Array.isArray(payload.content) ? payload.content : [];
  const value = content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
  if (!value.trim()) throw new Error("AIから記事を受信できませんでした。再実行してください。");
  return value;
}

// Never leave sibling writes running after the caller marks the batch failed.
export async function settleProductionBatch<T>(operations: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(operations);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}
