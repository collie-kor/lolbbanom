// 먼저봄 — API 공유 코어 (Vercel Function + 로컬 Express 양쪽에서 사용)
import rules from "../public/data/rules.json" with { type: "json" };

export { rules };

const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const KAKAO_JS_KEY = process.env.KAKAO_JS_KEY || "";

export const AI_OBSTACLES = ["curb", "stairs_only", "blocked_path", "obstruction"];

export function getConfig() {
  return {
    aiEnabled: Boolean(API_KEY),
    mapEnabled: Boolean(KAKAO_JS_KEY),
    kakaoKey: KAKAO_JS_KEY, // 도메인 제한 방식이라 프론트 노출 무방(기획서 §9)
    model: MODEL,
  };
}

// ── Gemini 호출 ────────────────────────────────────────────
async function callGemini(parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  // Serverless maxDuration(15초) 이내로 자체 중단 (여유 2초)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 13000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/[{[][\s\S]*[}\]]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ── 분석: 사진 → 장애 요소 후보 ────────────────────────────
export async function analyze({ imageBase64, mimeType }) {
  if (!imageBase64 || !mimeType) {
    return { status: 400, body: { error: "이미지가 없습니다." } };
  }
  if (!API_KEY) {
    return { status: 200, body: { ok: false, fallback: true, reason: "no_key" } };
  }

  const labels = AI_OBSTACLES.map(
    (id) => `- ${id}: ${rules.obstacles[id].label} (${rules.obstacles[id].hint})`
  ).join("\n");

  const prompt = `당신은 건물 출입 접근성을 관찰하는 보조 도구입니다. 판정하지 말고 사진에서 보이는 것만 관찰하세요.

사진에서 아래 4가지 장애 요소가 보이는지 확인하세요:
${labels}

규칙:
- 위 4가지 중 실제로 사진에서 관찰되는 것만 후보로 고르세요. 없으면 빈 배열.
- 최대 4개, 최소 0개.
- "무거운 문"이나 "안내 부족"은 사진으로 판단하지 말고 절대 포함하지 마세요.
- 출입구·통로·바닥 같은 이동 동선이 사진에 전혀 보이지 않으면 sceneRecognized 를 false 로 하세요.
- reason 은 판정이 아니라 관찰 문장으로("~가 보입니다", "~로 보입니다").

아래 JSON 형식으로만 답하세요:
{"sceneRecognized": true, "candidates": [{"id": "curb", "reason": "출입구 앞에 낮은 단차가 보입니다"}]}`;

  try {
    const text = await callGemini([
      { text: prompt },
      { inline_data: { mime_type: mimeType, data: imageBase64 } },
    ]);
    const parsed = parseJsonLoose(text);
    if (!parsed) throw new Error("파싱 실패");

    const candidates = Array.isArray(parsed.candidates)
      ? parsed.candidates
          .filter((c) => AI_OBSTACLES.includes(c.id))
          .slice(0, 4)
          .map((c) => ({ id: c.id, reason: String(c.reason || "").slice(0, 120) }))
      : [];

    return {
      status: 200,
      body: { ok: true, sceneRecognized: parsed.sceneRecognized !== false, candidates },
    };
  } catch (err) {
    console.error("[analyze]", err.message);
    return { status: 200, body: { ok: false, fallback: true, reason: "api_error" } };
  }
}

// ── 작성: 확인된 정보 → 요청문 초안 ────────────────────────
export async function compose({ receiverId, obstacleId, userIds, improvement, location }) {
  const receiver = rules.receivers[receiverId];
  const obstacle = rules.obstacles[obstacleId];
  if (!receiver || !obstacle || !improvement) {
    return { status: 400, body: { error: "요청 정보가 부족합니다." } };
  }

  const phrases = (userIds || [])
    .map((uid) => rules.matrix[`${obstacleId}_${uid}`])
    .filter((cell) => cell && cell.applicable)
    .map((cell) => cell.phrase);

  const userLabels = (userIds || [])
    .map((uid) => rules.users[uid]?.short)
    .filter(Boolean);

  const loc = normalizeLocation(location);
  const fallbackLetter = buildFallbackLetter({
    receiver,
    obstacle,
    userLabels,
    phrases,
    improvement,
    loc,
  });

  if (!API_KEY) {
    return { status: 200, body: { ok: false, fallback: true, text: fallbackLetter } };
  }

  const prompt = `아래 정보를 바탕으로 접근성 개선을 요청하는 짧은 초안을 작성하세요.

수신자: ${receiver.label}
어조: ${receiver.tone}
위치(주소): ${loc.address || "미기재"}
세부 위치: ${loc.detail || "미기재"}
관찰된 장애 요소: ${obstacle.label}
영향을 받는 이용자: ${userLabels.join(", ") || "미상"}
이용자별 부담(명사구): ${phrases.join(" / ") || "정보 없음"}
요청할 개선안: ${improvement.title} — ${improvement.detail}

작성 규칙:
- 한국어. 250자 안팎, 최대 350자.
- 위치는 위에 주어진 "위치(주소)"와 "세부 위치" 값을 **그대로만** 사용하세요. 두 값이 모두 미기재면 위치 문장을 아예 쓰지 말고, 절대 임의의 장소명(본관·현관·강당 등)을 지어내지 마세요.
- 위 "관찰된 장애 요소", "영향을 받는 이용자", "요청할 개선안" 외의 다른 장애물·개선안을 추가하지 마세요.
- "접근 불가능", "위법" 같은 판정 표현 금지. "관찰됩니다", "어려울 수 있습니다" 같은 관찰 어조.
- "민원을 넣으면 해결된다" 같은 표현 금지.
- 마지막에 현장 확인을 정중히 요청하는 문장 한 줄.
- 인사 → 위치(있을 때만) → 관찰 → 이용자 영향 → 개선 요청 → 현장 확인 요청 순서.

아래 JSON 형식으로만 답하세요:
{"text": "요청문 전체"}`;

  try {
    const text = await callGemini([{ text: prompt }]);
    const parsed = parseJsonLoose(text);
    const letter = parsed?.text ? String(parsed.text) : "";
    if (!letter) throw new Error("빈 응답");
    return { status: 200, body: { ok: true, text: letter } };
  } catch (err) {
    console.error("[compose]", err.message);
    return { status: 200, body: { ok: false, fallback: true, text: fallbackLetter } };
  }
}

function normalizeLocation(location) {
  const address = (location?.address || "").toString().trim();
  const detail = (location?.detail || "").toString().trim();
  return { address, detail };
}

function buildFallbackLetter({ receiver, obstacle, userLabels, phrases, improvement, loc }) {
  const locLine =
    loc.address || loc.detail
      ? `위치: ${[loc.address, loc.detail].filter(Boolean).join(" ")}\n\n`
      : "";
  const who = userLabels.length ? userLabels.join(", ") + " 등 " : "";
  const impact = phrases.length
    ? ` ${who}이용자에게 ${phrases.join(", ")} 같은 부담이 나타날 수 있습니다.`
    : "";
  return (
    `안녕하세요. ${receiver.label}께 접근성 개선을 요청드립니다.\n\n` +
    locLine +
    `해당 공간의 출입 동선에서 ${obstacle.label}이(가) 관찰되었습니다.${impact}\n\n` +
    `가장 실행하기 쉬운 조치로 '${improvement.title}'을(를) 제안드립니다. ${improvement.detail}\n\n` +
    `사진으로 확인한 내용이라 현장 상황과 다를 수 있으니, 한 번 직접 확인해 주시면 감사하겠습니다.`
  );
}

// ── Node http 핸들러 어댑터 (Vercel Function = Express 핸들러 공용) ──
export function makeHandler(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req.body || {});
      res.status(result.status).json(result.body);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "서버 오류" });
    }
  };
}
