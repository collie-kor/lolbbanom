# 먼저봄

사진 한 장에서 접근성 장애 요소를 찾아, 이용자(휠체어·유모차·목발)별 부담을 비교하고, **위치를 지정해** 수신자 맞춤 개선 요청문까지 만드는 웹 서비스.
2026 전국 청소년 SW·AI 경진대회 본선 산출물.

## 로컬 실행

```bash
npm install
cp .env.example .env       # (cmd: copy .env.example .env)
# .env 에 GEMINI_API_KEY, KAKAO_JS_KEY 를 채웁니다 (아래 참고). 없어도 폴백으로 동작.
npm start
```

브라우저에서 http://localhost:3000 접속.

> Windows cmd에서 한글이 깨지면 `chcp 65001` 실행 후 다시 시도.

## 키 발급

| 키 | 용도 | 발급처 | 노출 |
|---|---|---|---|
| `GEMINI_API_KEY` | 사진 분석 · 요청문 생성 | https://aistudio.google.com/apikey | 서버 전용 (절대 프론트 금지, `VITE_` 접두사 금지) |
| `KAKAO_JS_KEY` | 지도 위치 선택 · 좌표→주소 변환 | https://developers.kakao.com | 프론트 노출 무방 (도메인 제한 방식) |

**Kakao 도메인 등록 필수** (플랫폼 > Web): `http://localhost:3000` 과 배포 도메인 둘 다.
빠뜨리면 로컬은 되고 배포판에서만 지도가 안 뜬다 — 가장 흔한 실패 지점.

## 키 없이도 끝까지 동작 (폴백, 기획서 §12)

| 상황 | 동작 |
|---|---|
| Gemini 키 없음 / 사진 분석 실패 | 장애물을 직접 선택하는 체크박스 경로로 전환 |
| 요청문 생성 실패 | 사전 작성 템플릿에 값만 주입 |
| Kakao 키 없음 / 지도 로드 실패 | 주소·세부위치를 텍스트로 직접 입력 |
| 접근성과 무관한 사진 | "출입 동선이 확인되지 않습니다" 안내 후 수동 경로 |

가운데 **이용자별 비교 매트릭스는 규칙표(`public/data/rules.json`) 계산**이라 AI 없이 작동한다.

## 구조 (Vercel 배포 대응, 기획서 §10)

```
api/
  analyze.js     → POST /api/analyze  사진 → 장애 요소 후보 (Gemini)
  compose.js     → POST /api/compose  확인 정보+위치 → 요청문 초안 (Gemini)
  config.js      → GET  /api/config   키 유무·Kakao 키 전달
lib/
  core.js        → 위 함수들의 공유 로직 (Vercel Function + 로컬 Express 공용)
public/
  index.html     단계형 SPA (1 사진 — 2 확인 — 3 비교 — 4 요청문)
  styles.css     디자인 토큰 (기획서 §11)
  app.js         단계 전환·검증·규칙표 계산·지도·요청문
  data/rules.json  장애물 6종·이용자 3종·18칸 매트릭스·개선안·수신자 안내
server.js        로컬 개발 서버 (api 핸들러를 그대로 마운트)
vercel.json      함수 설정
```

AI 호출은 **두 곳뿐**(`/api/analyze`, `/api/compose`). 키는 서버 환경변수에만 존재하고 브라우저는 프록시만 호출한다.

## Vercel 배포 순서 (기획서 §10)

1. GitHub 저장소 연결 → Vercel 자동 배포
2. Settings > Environment Variables 에 `GEMINI_API_KEY`, `KAKAO_JS_KEY` 등록 후 **재배포**
3. 배포 도메인을 Kakao 플랫폼 Web 설정에 추가
4. 배포판에서 사진 → 지도 → 요청문까지 **한 번 끝까지** 돌려본다
5. 제출 최소 2시간 전 배포하고 실기기에서 확인. Serverless 타임아웃(기본 10초) 대응으로 Gemini 호출은 8초 자체 중단 처리됨.

## 절대 원칙 (기획서 §17)

1. 판정하지 않는다 — 관찰과 현장 확인 요청까지만
2. 문제 없는 공간에는 문제가 없다고 답한다 — "문제 없음" 분기는 필수 기능
3. 자동으로 보내지 않는다 — 사용자가 확인하고 직접 복사해 전달
