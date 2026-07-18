// 먼저봄 — 프론트엔드 로직
"use strict";

const AI_OBSTACLES = ["curb", "stairs_only", "blocked_path", "obstruction"];
const USER_CHECK_OBSTACLES = ["heavy_door", "no_signage"];
const USER_ORDER = ["wheelchair", "stroller", "crutches"];

const state = {
  rules: null,
  aiEnabled: false,
  mapEnabled: false,
  kakaoKey: "",
  imageBase64: null,
  mimeType: null,
  verifyMode: "ai", // 'ai' | 'manual'
  items: {}, // obstacleId -> 'yes' | 'no' | 'maybe' | undefined
  reasons: {}, // obstacleId -> AI 관찰 문장
  confirmed: [], // 확인된 obstacleId 목록
  letter: null,
  map: null, // Kakao 지도 인스턴스
  marker: null, // 선택 마커
  geocoder: null, // 좌표→주소 변환기
  mapReady: false,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── 초기화 ────────────────────────────────────────────────
async function init() {
  state.rules = await fetch("data/rules.json").then((r) => r.json());
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    state.aiEnabled = cfg.aiEnabled;
    state.mapEnabled = cfg.mapEnabled;
    state.kakaoKey = cfg.kakaoKey || "";
  } catch {
    state.aiEnabled = false;
    state.mapEnabled = false;
  }
  bindUpload();
  bindNav();
}

// ── 화면 전환 ─────────────────────────────────────────────
const SCREEN_STEP = {
  "screen-upload": 1,
  "screen-loading": 1,
  "screen-verify": 2,
  "screen-none": 2,
  "screen-compare": 3,
  "screen-letter": 4,
};
function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $("#" + id).classList.add("active");
  updateSteps(SCREEN_STEP[id] || 1);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function updateSteps(step) {
  document.querySelectorAll("#steps .step").forEach((s) => {
    const n = Number(s.dataset.step);
    s.classList.toggle("active", n === step);
    s.classList.toggle("done", n < step);
  });
}

// ── 1단계: 업로드 ─────────────────────────────────────────
function bindUpload() {
  const fileInput = $("#fileInput");
  const dropZone = $("#dropZone");
  const consent = $("#consentCheck");
  const analyzeBtn = $("#analyzeBtn");

  const refresh = () => {
    analyzeBtn.disabled = !(state.imageBase64 && consent.checked);
  };
  consent.addEventListener("change", refresh);

  fileInput.addEventListener("change", (e) => handleFile(e.target.files[0], refresh));
  ["dragover"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.style.borderColor = "var(--ink-soft)";
    })
  );
  dropZone.addEventListener("dragleave", () => (dropZone.style.borderColor = ""));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.style.borderColor = "";
    handleFile(e.dataTransfer.files[0], refresh);
  });

  analyzeBtn.addEventListener("click", runAnalyze);
}

function handleFile(file, refresh) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    downscale(reader.result, (dataUrl, mime) => {
      const comma = dataUrl.indexOf(",");
      state.imageBase64 = dataUrl.slice(comma + 1);
      state.mimeType = mime;
      $("#previewImg").src = dataUrl;
      $("#previewWrap").classList.remove("hidden");
      $("#dropZone").classList.add("hidden");
      refresh();
    });
  };
  reader.readAsDataURL(file);
}

// 큰 사진은 최대 1280px로 축소해 전송(속도·무료티어 대응)
function downscale(dataUrl, cb) {
  const img = new Image();
  img.onload = () => {
    const max = 1280;
    let { width, height } = img;
    if (width > max || height > max) {
      const r = Math.min(max / width, max / height);
      width = Math.round(width * r);
      height = Math.round(height * r);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    cb(canvas.toDataURL("image/jpeg", 0.85), "image/jpeg");
  };
  img.onerror = () => cb(dataUrl, state.mimeType || "image/jpeg");
  img.src = dataUrl;
}

// ── 분석 호출 ─────────────────────────────────────────────
async function runAnalyze() {
  show("screen-loading");
  $("#loadingMsg").textContent = "사진에서 장애 요소를 찾는 중입니다…";

  let result;
  try {
    result = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: state.imageBase64, mimeType: state.mimeType }),
    }).then((r) => r.json());
  } catch {
    result = { ok: false, fallback: true, reason: "network" };
  }

  state.items = {};
  state.reasons = {};

  if (!result.ok && result.fallback) {
    // 폴백: 체크박스로 직접 선택하는 경로
    state.verifyMode = "manual";
    renderVerify();
    show("screen-verify");
    return;
  }

  if (result.sceneRecognized === false) {
    // 접근성과 무관한 사진 → 억지 지적 금지, 수동 경로 제안
    state.verifyMode = "manual";
    renderVerify(
      "이 사진에서는 출입 동선이 뚜렷하게 확인되지 않습니다. 점검하려는 장애 요소가 있다면 직접 선택해 주세요."
    );
    show("screen-verify");
    return;
  }

  // 정상: AI 후보 반영
  state.verifyMode = "ai";
  (result.candidates || []).forEach((c) => {
    state.items[c.id] = undefined;
    state.reasons[c.id] = c.reason;
  });
  renderVerify();
  show("screen-verify");
}

// ── 2단계: 검증 화면 ──────────────────────────────────────
function renderVerify(topNote) {
  const wrap = $("#aiCandidates");
  wrap.innerHTML = "";

  if (topNote) {
    wrap.appendChild(el("div", "notice", esc(topNote)));
  }

  const aiIds =
    state.verifyMode === "manual" ? AI_OBSTACLES : Object.keys(state.reasons);

  if (state.verifyMode === "manual") {
    wrap.appendChild(
      el(
        "div",
        "notice",
        state.aiEnabled
          ? "사진 분석을 사용할 수 없어, 장애 요소를 직접 선택하는 방식으로 전환했습니다."
          : "AI 사진 분석이 설정되지 않아, 장애 요소를 직접 선택하는 방식으로 진행합니다."
      )
    );
  }

  if (aiIds.length === 0 && state.verifyMode === "ai") {
    wrap.appendChild(
      el("div", "notice", "AI가 사진에서 뚜렷한 장애 요소를 찾지 못했습니다. 아래 두 항목만 확인하면 됩니다.")
    );
  }

  aiIds.forEach((id) => {
    const ob = state.rules.obstacles[id];
    const item = el("div", "verify-item");
    item.appendChild(el("div", "vlabel", esc(ob.label)));
    const reason = state.reasons[id];
    item.appendChild(
      el("div", "vreason", esc(reason || ob.hint))
    );
    item.appendChild(buildChoices(id, false));
    wrap.appendChild(item);
  });

  // 사용자 직접 확인 항목 (heavy_door, no_signage)
  const uc = $("#userChecks");
  uc.innerHTML = "";
  USER_CHECK_OBSTACLES.forEach((id) => {
    const ob = state.rules.obstacles[id];
    const item = el("div", "verify-item usercheck");
    item.appendChild(el("div", "vlabel", esc(ob.label)));
    item.appendChild(el("div", "flagnote", esc(ob.userPrompt)));
    item.appendChild(buildChoices(id, true));
    uc.appendChild(item);
  });
}

function buildChoices(id, isUserCheck) {
  const row = el("div", "choices");
  const opts = isUserCheck
    ? [
        ["yes", "네, 그렇습니다"],
        ["no", "아니에요"],
        ["maybe", "모르겠어요"],
      ]
    : [
        ["yes", "맞아요"],
        ["no", "아니에요"],
        ["maybe", "모르겠어요"],
      ];
  opts.forEach(([val, label]) => {
    const b = el("button", "choice", esc(label));
    b.dataset.val = val;
    b.addEventListener("click", () => {
      state.items[id] = val;
      row.querySelectorAll(".choice").forEach((c) => {
        c.classList.remove("sel-yes", "sel-no", "sel-maybe");
      });
      b.classList.add("sel-" + val);
    });
    row.appendChild(b);
  });
  return row;
}

// ── 네비게이션 바인딩 ─────────────────────────────────────
function bindNav() {
  $("#verifyBackBtn").addEventListener("click", () => show("screen-upload"));
  $("#toCompareBtn").addEventListener("click", goToCompareOrNone);

  $("#noneBackBtn").addEventListener("click", () => show("screen-verify"));
  $("#noneRestartBtn").addEventListener("click", restart);

  $("#compareBackBtn").addEventListener("click", () => show("screen-verify"));
  $("#toLetterBtn").addEventListener("click", () => {
    renderLetterSetup();
    show("screen-letter");
  });

  $("#letterBackBtn").addEventListener("click", () => show("screen-compare"));
  $("#restartBtn").addEventListener("click", restart);

  $("#genLetterBtn").addEventListener("click", generateLetter);
  $("#regenBtn").addEventListener("click", generateLetter);
  $("#copyBtn").addEventListener("click", copyLetter);
}

function goToCompareOrNone() {
  state.confirmed = Object.keys(state.items).filter((id) => state.items[id] === "yes");
  if (state.confirmed.length === 0) {
    renderNone();
    show("screen-none");
  } else {
    renderCompare();
    show("screen-compare");
  }
}

// ── 문제 없음 분기 ────────────────────────────────────────
function renderNone() {
  const pos = $("#positiveList");
  pos.innerHTML = "";
  state.rules.positiveObservations.forEach((t) =>
    pos.appendChild(el("li", null, esc(t)))
  );
  const fc = $("#fieldCheckList");
  fc.innerHTML = "";
  state.rules.fieldCheckItems.forEach((t) => fc.appendChild(el("li", null, esc(t))));
}

// ── 3단계: 이용자별 비교 (시그니처) ───────────────────────
function renderCompare() {
  const head = $("#compareHead");
  head.innerHTML = "";
  USER_ORDER.forEach((uid) => {
    head.appendChild(el("div", "uhead", esc(state.rules.users[uid].short)));
  });

  const body = $("#compareBody");
  body.innerHTML = "";
  state.confirmed.forEach((oid) => {
    const block = el("div", "compare-block");
    block.appendChild(el("div", "obstacle-name", esc(state.rules.obstacles[oid].label)));
    const cols = el("div", "compare-cols");
    USER_ORDER.forEach((uid) => {
      const cell = state.rules.matrix[`${oid}_${uid}`];
      const col = el("div", "ccol");
      col.appendChild(el("div", "uname", esc(state.rules.users[uid].short)));
      if (cell && cell.applicable) {
        const tags = el("div", "cost-tags");
        cell.costs.forEach((ct) =>
          tags.appendChild(el("span", "cost-tag", esc(state.rules.costTypes[ct].label)))
        );
        col.appendChild(tags);
        col.appendChild(el("div", "cdisplay", esc(cell.display)));
      } else {
        col.classList.add("na");
        col.appendChild(el("div", "cdisplay", "해당 부담이 크지 않습니다."));
      }
      cols.appendChild(col);
    });
    block.appendChild(cols);
    body.appendChild(block);
  });

  renderImprovements();
}

// 개선안 선정: 확인된 장애물별 → 난이도 오름차순, 동률이면 실행 시점 빠른 순 → 1순위+대안
function selectImprovements(oid) {
  const list = (state.rules.improvements[oid] || []).slice();
  list.sort((a, b) => a.difficulty - b.difficulty || a.timing - b.timing);
  return list.slice(0, 2);
}

function renderImprovements() {
  const body = $("#improveBody");
  body.innerHTML = "";
  state.confirmed.forEach((oid) => {
    const picks = selectImprovements(oid);
    const box = el("div", "improve");
    box.appendChild(el("div", "obstacle-name", esc(state.rules.obstacles[oid].label)));
    picks.forEach((imp, i) => {
      const row = el("div", "improve-row" + (i > 0 ? " alt" : ""));
      row.appendChild(el("span", "rank", i === 0 ? "1순위" : "대안"));
      row.appendChild(el("div", "ititle", esc(imp.title)));
      row.appendChild(el("div", "idetail", esc(imp.detail)));
      box.appendChild(row);
    });
    body.appendChild(box);
  });
}

// ── 4단계: 요청문 ─────────────────────────────────────────
function renderLetterSetup() {
  // 수신자
  const sel = $("#receiverSelect");
  sel.innerHTML = "";
  Object.entries(state.rules.receivers).forEach(([id, r]) => {
    const opt = el("option", null, esc(r.label));
    opt.value = id;
    sel.appendChild(opt);
  });

  // 개선안 선택지: 확인된 장애물별 상위 개선안
  const choices = $("#improvementChoices");
  choices.innerHTML = "";
  let first = true;
  state.confirmed.forEach((oid) => {
    selectImprovements(oid).forEach((imp, i) => {
      const wrap = el("div", "radio-item" + (first ? " sel" : ""));
      const input = el("input");
      input.type = "radio";
      input.name = "improvement";
      input.value = `${oid}::${imp.id}`;
      input.checked = first;
      input.addEventListener("change", () => {
        choices.querySelectorAll(".radio-item").forEach((r) => r.classList.remove("sel"));
        wrap.classList.add("sel");
      });
      const label = el("div");
      label.appendChild(
        el(
          "div",
          "r-label",
          `${esc(state.rules.obstacles[oid].label)} · ${esc(imp.title)}${i === 0 ? " (1순위)" : ""}`
        )
      );
      label.appendChild(el("div", "r-sub", esc(imp.detail)));
      wrap.appendChild(input);
      wrap.appendChild(label);
      wrap.addEventListener("click", (e) => {
        if (e.target !== input) input.click();
      });
      choices.appendChild(wrap);
      first = false;
    });
  });

  $("#letterResult").classList.add("hidden");
  setupLocation();
}

// ── 위치 지정 (Kakao Maps) ────────────────────────────────
async function setupLocation() {
  const mapArea = $("#mapArea");
  const note = $("#addrFallbackNote");

  if (!state.mapEnabled || !state.kakaoKey) {
    // 지도 미설정 → 주소 직접 입력 경로
    mapArea.classList.add("hidden");
    note.classList.remove("hidden");
    note.textContent = "지도가 설정되지 않아, 주소를 직접 입력하는 방식으로 진행합니다.";
    return;
  }

  try {
    await loadKakao(state.kakaoKey);
    mapArea.classList.remove("hidden");
    note.classList.add("hidden");
    if (!state.mapReady) initMap();
  } catch {
    // 지도 SDK 로드 실패 → 폴백 (기획서 §12)
    mapArea.classList.add("hidden");
    note.classList.remove("hidden");
    note.textContent = "지도를 불러오지 못했습니다. 주소를 직접 입력해 주세요.";
  }
}

function loadKakao(key) {
  return new Promise((resolve, reject) => {
    if (window.kakao && window.kakao.maps && window.kakao.maps.services) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${key}&libraries=services&autoload=false`;
    s.onload = () => window.kakao.maps.load(resolve);
    s.onerror = reject;
    document.head.appendChild(s);
    setTimeout(() => reject(new Error("timeout")), 8000);
  });
}

function initMap() {
  const kakao = window.kakao;
  const center = new kakao.maps.LatLng(37.5665, 126.978); // 기본값: 서울시청
  state.map = new kakao.maps.Map($("#mapBox"), { center, level: 4 });
  state.marker = new kakao.maps.Marker({ position: center, map: null });
  state.geocoder = new kakao.maps.services.Geocoder();
  state.mapReady = true;

  // 지도 클릭 → 핀 이동 → 주소 변환
  kakao.maps.event.addListener(state.map, "click", (e) => setPin(e.latLng));

  // 현재 위치로
  $("#locateBtn").addEventListener("click", useCurrentLocation);

  // 초기 현재 위치 시도 (실패해도 무방)
  useCurrentLocation(true);
}

function setPin(latLng) {
  state.marker.setPosition(latLng);
  state.marker.setMap(state.map);
  state.map.panTo(latLng);
  state.geocoder.coord2Address(latLng.getLng(), latLng.getLat(), (res, status) => {
    if (status === window.kakao.maps.services.Status.OK && res[0]) {
      const road = res[0].road_address?.address_name;
      const jibun = res[0].address?.address_name;
      $("#addressInput").value = road || jibun || "";
    }
  });
}

function useCurrentLocation(silent) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const ll = new window.kakao.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
      state.map.setCenter(ll);
      setPin(ll);
    },
    () => {
      if (!silent) {
        const hint = document.querySelector(".map-hint");
        if (hint) hint.textContent = "현재 위치를 가져올 수 없습니다. 지도를 눌러 직접 지정해 주세요.";
      }
    },
    { enableHighAccuracy: true, timeout: 6000 }
  );
}

async function generateLetter() {
  const receiverId = $("#receiverSelect").value;
  const picked = document.querySelector('input[name="improvement"]:checked');
  if (!picked) return;
  const [obstacleId, impId] = picked.value.split("::");
  const improvement = (state.rules.improvements[obstacleId] || []).find((x) => x.id === impId);

  const location = {
    address: $("#addressInput").value.trim(),
    detail: $("#detailInput").value.trim(),
  };
  // 위치 미입력 시 경고 (요청문 생성은 계속 가능)
  $("#noLocationWarn").classList.toggle("hidden", Boolean(location.address || location.detail));

  // 이 장애물에 부담이 있는 이용자만
  const userIds = USER_ORDER.filter((uid) => {
    const cell = state.rules.matrix[`${obstacleId}_${uid}`];
    return cell && cell.applicable;
  });

  $("#letterResult").classList.remove("hidden");
  $("#letterText").value = "요청문 초안을 작성하는 중입니다…";
  $("#genLetterBtn").disabled = true;

  let result;
  try {
    result = await fetch("/api/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiverId, obstacleId, userIds, improvement, location }),
    }).then((r) => r.json());
  } catch {
    result = { ok: false, text: "요청문 생성에 실패했습니다. 잠시 후 다시 시도해 주세요." };
  }
  $("#genLetterBtn").disabled = false;
  $("#letterText").value = result.text || "";
  renderDeliveryGuide(receiverId);
}

function renderDeliveryGuide(receiverId) {
  const r = state.rules.receivers[receiverId];
  const box = $("#deliveryGuide");
  box.innerHTML = "";
  box.appendChild(el("h4", null, "전달·접수 경로"));

  const ul = el("ul");
  r.guidance.forEach((g) => ul.appendChild(el("li", null, esc(g))));
  box.appendChild(ul);

  if (r.links && r.links.length) {
    const linkP = el("div", null, "");
    linkP.style.marginTop = "8px";
    linkP.style.fontSize = "14px";
    r.links.forEach((lk, i) => {
      const a = el("a", null, esc(lk.label));
      a.href = lk.url;
      a.target = "_blank";
      a.rel = "noopener";
      linkP.appendChild(a);
      if (i < r.links.length - 1) linkP.appendChild(document.createTextNode(" · "));
    });
    box.appendChild(linkP);
  }

  if (r.note) {
    box.appendChild(el("div", "guide-warn", esc(r.note)));
  }
}

async function copyLetter() {
  const text = $("#letterText").value;
  try {
    await navigator.clipboard.writeText(text);
    const btn = $("#copyBtn");
    const orig = btn.textContent;
    btn.textContent = "복사됨";
    setTimeout(() => (btn.textContent = orig), 1500);
  } catch {
    $("#letterText").select();
    document.execCommand("copy");
  }
}

// ── 처음부터 ──────────────────────────────────────────────
function restart() {
  state.imageBase64 = null;
  state.mimeType = null;
  state.items = {};
  state.reasons = {};
  state.confirmed = [];
  $("#fileInput").value = "";
  $("#previewWrap").classList.add("hidden");
  $("#dropZone").classList.remove("hidden");
  $("#consentCheck").checked = false;
  $("#analyzeBtn").disabled = true;
  $("#addressInput").value = "";
  $("#detailInput").value = "";
  $("#noLocationWarn").classList.add("hidden");
  show("screen-upload");
}

init();
