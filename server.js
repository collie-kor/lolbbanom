// 로컬 개발 서버 — Vercel Function 핸들러를 그대로 재사용 (npm start 로 실행)
import express from "express";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

dotenv.config();

// .env 로드 후 코어/핸들러를 불러온다 (환경변수 반영을 위해 동적 import)
const { default: analyzeHandler } = await import("./api/analyze.js");
const { default: composeHandler } = await import("./api/compose.js");
const { default: configHandler } = await import("./api/config.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "12mb" }));

app.get("/api/config", configHandler);
app.post("/api/analyze", analyzeHandler);
app.post("/api/compose", composeHandler);

app.use(express.static(join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`먼저봄 서버 실행: http://localhost:${PORT}`);
  console.log(`AI 호출: ${process.env.GEMINI_API_KEY ? "활성" : "비활성 — 폴백 경로로 동작"}`);
});
