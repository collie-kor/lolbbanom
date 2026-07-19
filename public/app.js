// 먼저봄 — 프론트엔드 로직
"use strict";

const AI_OBSTACLES = ["curb", "stairs_only", "blocked_path", "obstruction"];
const USER_CHECK_OBSTACLES = ["heavy_door", "no_signage"];
const USER_ORDER = ["wheelchair", "stroller", "crutches"];

const state = {
  rules: null,
  aiEnabled: false,
  imageBase64: null,
  mimeType: null,
  verifyMode: "ai", // 'ai' | 'manual'
  manualEntry: false, // 홈에서 '사진 없이 직접 점검'으로 진입했는지
  items: {}, // obstacleId -> 'yes' | 'no' | 'maybe' | undefined
  reasons: {}, // obstacleId -> AI 관찰 문장
  confirmed: [], // 확인된 규칙표 obstacleId 목록
  customs: [], // 커스텀 항목 [{ key, label, reason, source:'ai'|'user', status }]
  confirmedCustoms: [], // 확인된 커스텀 항목
  customSeq: 0, // 커스텀 key 생성용
  letter: null,
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
  } catch {
    state.aiEnabled = false;
  }
  bindUpload();
  bindNav();
  bindHome();
}

// ── 홈(랜딩) 진입 ─────────────────────────────────────────
function bindHome() {
  const goHome = (e) => {
    if (e) e.preventDefault();
    show("screen-home");
  };
  const goPhoto = () => {
    resetCheck();
    show("screen-upload");
  };

  $("#homeLink").addEventListener("click", goHome);
  ["#navStartBtn", "#startPhotoBtn", "#ctaStartBtn"].forEach((sel) =>
    $(sel).addEventListener("click", goPhoto)
  );
  $("#startManualBtn").addEventListener("click", startManual);

  // 네비 링크(서비스 소개·작동 방식·왜 다른가): 어느 화면에서든 홈으로 돌아가 해당 섹션으로 스크롤
  document.querySelectorAll(".topnav .navlink").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.getElementById(a.getAttribute("href").slice(1));
      show("screen-home");
      if (target) {
        requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
    });
  });
}

// '사진 없이 직접 점검' — 사진 단계를 건너뛰고 항목을 직접 선택
function startManual() {
  resetCheck();
  state.verifyMode = "manual";
  state.manualEntry = true;
  renderVerify();
  show("screen-verify");
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

  const isHome = id === "screen-home";
  $("#tool").classList.toggle("hidden", isHome);
  $("#stepsNav").classList.toggle("hidden", isHome);
  if (!isHome) updateSteps(SCREEN_STEP[id] || 1);

  window.scrollTo({ top: 0, behavior: isHome ? "auto" : "smooth" });
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

  // 사진 다시 첨부하기 → 파일 선택창을 다시 열어 새 사진으로 교체
  $("#reattachBtn").addEventListener("click", () => {
    fileInput.value = ""; // 같은 파일을 골라도 change 이벤트가 다시 발생하도록
    fileInput.click();
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
  state.customs = [];
  state.manualEntry = false;

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
  // AI가 4개 카테고리 밖에서 발견한 항목 → 커스텀(확인 필요)
  (result.extra || []).forEach((e) => {
    if (e && e.label) {
      state.customs.push({
        key: "c" + ++state.customSeq,
        label: e.label,
        reason: e.reason || "",
        source: "ai",
        status: undefined,
      });
    }
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

  // 수동 전환 안내는 '진짜 폴백'(키 없음·분석 실패)이나 '사진 없이 직접 점검'일 때만.
  // sceneRecognized === false(분석은 됐으나 장면 불명확)일 때는 topNote로 이미 안내하므로 중복 표시하지 않는다.
  if (state.verifyMode === "manual" && !topNote) {
    wrap.appendChild(
      el(
        "div",
        "notice",
        state.manualEntry
          ? "사진 없이 직접 점검하는 방식입니다. 해당하는 장애 요소를 선택해 주세요."
          : state.aiEnabled
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

  renderCustomList();
  bindCustomAdd();
}

// 커스텀 항목(AI 자유 발견 + 사용자 직접입력) 렌더
function renderCustomList() {
  const wrap = $("#customList");
  wrap.innerHTML = "";
  state.customs.forEach((c) => {
    const item = el("div", "verify-item custom");
    const head = el("div", "custom-head");
    const label = el("div", "vlabel", esc(c.label));
    head.appendChild(label);
    if (c.source === "ai") {
      head.appendChild(el("span", "custom-badge", "AI 발견"));
    } else {
      head.appendChild(el("span", "custom-badge user", "직접 입력"));
    }
    item.appendChild(head);
    if (c.reason) item.appendChild(el("div", "vreason", esc(c.reason)));

    if (c.source === "ai") {
      // AI가 찾은 항목 → 확인 필요 (맞아요/아니에요/모르겠어요)
      item.appendChild(buildCustomChoices(c));
    } else {
      // 사용자가 추가한 항목 → 이미 확정, 삭제만 가능
      const removeRow = el("div", "custom-actions");
      const rm = el("button", "btn btn-ghost btn-sm", "삭제");
      rm.addEventListener("click", () => {
        state.customs = state.customs.filter((x) => x.key !== c.key);
        renderCustomList();
      });
      removeRow.appendChild(rm);
      item.appendChild(removeRow);
    }
    wrap.appendChild(item);
  });
}

function buildCustomChoices(custom) {
  const row = el("div", "choices");
  [
    ["yes", "맞아요"],
    ["no", "아니에요"],
    ["maybe", "모르겠어요"],
  ].forEach(([val, label]) => {
    const b = el("button", "choice" + (custom.status === val ? " sel-" + val : ""), esc(label));
    b.addEventListener("click", () => {
      custom.status = val;
      row.querySelectorAll(".choice").forEach((c) => c.classList.remove("sel-yes", "sel-no", "sel-maybe"));
      b.classList.add("sel-" + val);
    });
    row.appendChild(b);
  });
  return row;
}

// '직접 추가' 버튼 바인딩 (renderVerify 시 1회만)
let customAddBound = false;
function bindCustomAdd() {
  if (customAddBound) return;
  customAddBound = true;
  const input = $("#customInput");
  const add = () => {
    const text = input.value.trim();
    if (!text) return;
    state.customs.push({
      key: "c" + ++state.customSeq,
      label: text.slice(0, 60),
      reason: "",
      source: "user",
      status: "yes",
    });
    input.value = "";
    renderCustomList();
  };
  $("#customAddBtn").addEventListener("click", add);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
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
  $("#verifyBackBtn").addEventListener("click", () =>
    show(state.manualEntry ? "screen-home" : "screen-upload")
  );
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
  state.confirmedCustoms = state.customs.filter((c) => c.status === "yes");
  if (state.confirmed.length === 0 && state.confirmedCustoms.length === 0) {
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
  // 규칙표 기반 비교는 확인된 규칙 장애물이 있을 때만 표시
  $("#ruleCompareSection").classList.toggle("hidden", state.confirmed.length === 0);

  // 커스텀(직접 확인·입력) 항목 섹션
  const customSec = $("#customCompareSection");
  const customBody = $("#customCompareBody");
  customBody.innerHTML = "";
  customSec.classList.toggle("hidden", state.confirmedCustoms.length === 0);
  state.confirmedCustoms.forEach((c) => {
    const block = el("div", "compare-block");
    const name = el("div", "obstacle-name");
    name.appendChild(document.createTextNode(c.label));
    name.appendChild(el("span", "custom-badge" + (c.source === "user" ? " user" : ""), c.source === "ai" ? "AI 발견" : "직접 입력"));
    block.appendChild(name);
    block.appendChild(el("div", "custom-compare-note", esc(c.reason || "요청문에 이 내용을 담아 개선을 요청할 수 있습니다.")));
    customBody.appendChild(block);
  });

  if (state.confirmed.length === 0) {
    renderImprovements();
    return;
  }

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

  // 개선안 선택지: 확인된 장애물별 상위 개선안 + 커스텀 항목
  const choices = $("#improvementChoices");
  choices.innerHTML = "";
  const state_first = { v: true };

  const addRadio = (value, labelText, subText, isCustom) => {
    const wrap = el("div", "radio-item" + (state_first.v ? " sel" : ""));
    const input = el("input");
    input.type = "radio";
    input.name = "improvement";
    input.value = value;
    input.checked = state_first.v;
    input.dataset.custom = isCustom ? "1" : "";
    input.addEventListener("change", () => {
      choices.querySelectorAll(".radio-item").forEach((r) => r.classList.remove("sel"));
      wrap.classList.add("sel");
      $("#customImproveWrap").classList.toggle("hidden", input.dataset.custom !== "1");
    });
    const label = el("div");
    label.appendChild(el("div", "r-label", labelText));
    if (subText) label.appendChild(el("div", "r-sub", subText));
    wrap.appendChild(input);
    wrap.appendChild(label);
    wrap.addEventListener("click", (e) => {
      if (e.target !== input) input.click();
    });
    choices.appendChild(wrap);
    state_first.v = false;
  };

  state.confirmed.forEach((oid) => {
    selectImprovements(oid).forEach((imp, i) => {
      addRadio(
        `${oid}::${imp.id}`,
        `${esc(state.rules.obstacles[oid].label)} · ${esc(imp.title)}${i === 0 ? " (1순위)" : ""}`,
        esc(imp.detail),
        false
      );
    });
  });

  // 커스텀(직접 확인·입력) 항목: 요청할 개선 내용을 직접 적어 요청
  state.confirmedCustoms.forEach((c) => {
    addRadio(
      `custom::${c.key}`,
      `${esc(c.label)} · 개선 요청`,
      esc(c.reason || "현장 확인과 개선을 요청합니다."),
      true
    );
  });

  // 첫 선택지가 커스텀인 경우(규칙 항목이 하나도 없을 때) 개선내용 입력칸 노출
  const firstChecked = choices.querySelector('input[name="improvement"]:checked');
  $("#customImproveWrap").classList.toggle("hidden", !(firstChecked && firstChecked.dataset.custom === "1"));
  $("#customImproveInput").value = "";

  $("#letterResult").classList.add("hidden");
}

async function generateLetter() {
  const receiverId = $("#receiverSelect").value;
  const picked = document.querySelector('input[name="improvement"]:checked');
  if (!picked) return;

  const location = {
    address: $("#addressInput").value.trim(),
    detail: $("#detailInput").value.trim(),
  };
  // 위치 미입력 시 경고 (요청문 생성은 계속 가능)
  $("#noLocationWarn").classList.toggle("hidden", Boolean(location.address || location.detail));

  // 규칙표 항목 / 커스텀 항목에 따라 요청 페이로드 구성
  let payload;
  if (picked.dataset.custom === "1") {
    const key = picked.value.slice("custom::".length);
    const c = state.customs.find((x) => x.key === key);
    const detailText = $("#customImproveInput").value.trim() || "해당 문제의 현장 확인과 개선을 요청드립니다.";
    payload = {
      receiverId,
      obstacleLabel: c ? c.label : "",
      obstacleReason: c ? c.reason : "",
      userIds: [],
      improvement: { title: "개선 요청", detail: detailText },
      location,
    };
  } else {
    const [obstacleId, impId] = picked.value.split("::");
    const improvement = (state.rules.improvements[obstacleId] || []).find((x) => x.id === impId);
    const userIds = USER_ORDER.filter((uid) => {
      const cell = state.rules.matrix[`${obstacleId}_${uid}`];
      return cell && cell.applicable;
    });
    payload = { receiverId, obstacleId, userIds, improvement, location };
  }

  $("#letterResult").classList.remove("hidden");
  $("#letterText").value = "요청문 초안을 작성하는 중입니다…";
  $("#genLetterBtn").disabled = true;

  let result;
  try {
    result = await fetch("/api/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

// ── 점검 상태 초기화 (새 점검 시작·처음부터 공용) ──────────
function resetCheck() {
  state.imageBase64 = null;
  state.mimeType = null;
  state.items = {};
  state.reasons = {};
  state.confirmed = [];
  state.customs = [];
  state.confirmedCustoms = [];
  state.verifyMode = "ai";
  state.manualEntry = false;
  $("#customInput") && ($("#customInput").value = "");
  $("#customImproveInput") && ($("#customImproveInput").value = "");
  $("#customImproveWrap") && $("#customImproveWrap").classList.add("hidden");
  $("#fileInput").value = "";
  $("#previewWrap").classList.add("hidden");
  $("#dropZone").classList.remove("hidden");
  $("#consentCheck").checked = false;
  $("#analyzeBtn").disabled = true;
  $("#addressInput").value = "";
  $("#detailInput").value = "";
  $("#letterResult").classList.add("hidden");
  $("#noLocationWarn").classList.add("hidden");
}

// ── 처음부터 ──────────────────────────────────────────────
function restart() {
  resetCheck();
  show("screen-upload");
}

init();
