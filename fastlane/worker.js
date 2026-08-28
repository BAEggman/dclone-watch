/**
 * dclone-fast — 우버 디아블로 고속 감시 차선 (Cloudflare Worker)
 *
 * 역할: 2분마다 우버디아 진행도를 확인하고, 변동 시
 *       ① GitHub 워크플로를 원격 기동해 이메일 차선을 즉시 돌리고
 *       ② 카카오톡으로 구독자 전원에게 푸시하고
 *       ③ (선택) 디스코드 웹후크로도 보낸다.
 *
 * v4.0 변경점:
 *  - 감시 대상 다중화: 래더 / 논래더를 동시에 본다 (TARGETS 변수)
 *  - 카카오톡 알림: 구독자별 '나에게 보내기'로 각자 카톡에 도착
 *    (카카오는 친구/단톡 발송에 비즈앱 검수를 요구하지만, '나에게 보내기'는
 *     검수도 건수 제한도 없다. 그래서 사람마다 토큰을 하나씩 두고 각자에게 쏜다.)
 *  - 길드원 셀프 등록: /kakao/join?c=<초대코드> 링크 클릭 한 번이면 구독 완료
 *
 * 데이터 소스 (이중화):
 *  1순위 d2emu.com — 게임 클라이언트 상주 자동 감지. 유저 제보가 없어도 잡힘.
 *  2순위 diablo2.io — 유저 제보 기반. d2emu 장애 시 폴백.
 *
 * 필요한 것:
 *  - KV 네임스페이스 바인딩: STATE
 *  - 변수: TARGETS, GH_REPO, GH_WORKFLOW, KAKAO_REST_KEY, KAKAO_REDIRECT_URI
 *  - 시크릿: GH_TOKEN(필수) · KAKAO_JOIN_CODE(카톡 쓸 때 필수)
 *            KAKAO_CLIENT_SECRET(카카오 앱에서 켠 경우만) · DISCORD_WEBHOOK(선택)
 */

const STAGES = {
  1: ["Terror gazes upon Sanctuary", "공포가 성역을 응시합니다"],
  2: ["Terror approaches Sanctuary", "공포가 성역으로 접근합니다"],
  3: ["Terror begins to form within Sanctuary", "공포가 성역 안에서 형체를 갖추기 시작합니다"],
  4: ["Terror spreads across Sanctuary", "공포가 성역 전역으로 퍼져나갑니다"],
  5: ["Terror is about to be unleashed upon Sanctuary", "공포가 곧 성역에 풀려납니다"],
  6: ["Diablo has invaded Sanctuary", "디아블로가 성역을 침공했습니다 — 소환!"],
};
const REGION_KR = { "1": "아메리카", "2": "유럽", "3": "아시아" };
const LADDER_KR = { "1": "래더", "2": "스탠다드" };
const HC_KR = { "1": "하드코어", "2": "소프트코어" };
const VER_KR = { "1": "LoD", "2": "RotW" };

const TRACKER_URL = "https://diablo2.io/dclonetracker.php";

// ─────────────────────────────────────────────────────────────
// 감시 대상 (다중)
// TARGETS="3:1:2:2,3:2:2:2"  → region:ladder:hc:ver 를 쉼표로 나열
// TARGETS가 없으면 예전 단일 변수(REGION/LADDER/HC/VER)를 그대로 쓴다.
// ─────────────────────────────────────────────────────────────
function targets(env) {
  const minStage = parseInt(env.ALERT_MIN_STAGE || "2", 10);
  const resetFrom = parseInt(env.RESET_MIN_STAGE || "2", 10);
  const raw = (env.TARGETS || "").trim() ||
    `${env.REGION || "3"}:${env.LADDER || "2"}:${env.HC || "2"}:${env.VER || "1"}`;
  const seen = new Set();
  const out = [];
  for (const piece of raw.split(",")) {
    const s = piece.trim();
    if (!s) continue;
    const [region = "3", ladder = "2", hc = "2", ver = "1"] = s.split(":").map((x) => x.trim());
    const c = { region, ladder, hc, ver, minStage, resetFrom };
    const k = d2emuKey(c);
    if (seen.has(k)) continue;   // 중복 대상 제거
    seen.add(k);
    out.push(c);
  }
  return out;
}

function label(c) {
  return `${REGION_KR[c.region] || c.region} ${LADDER_KR[c.ladder] || c.ladder} ` +
         `${HC_KR[c.hc] || c.hc} ${VER_KR[c.ver] || c.ver}`;
}

// 카톡은 200자 제한이라 서버 이름을 짧게 줄여 쓴다
function shortLabel(c) {
  return `${REGION_KR[c.region] || c.region} ${LADDER_KR[c.ladder] || c.ladder}` +
         (c.hc === "1" ? " 하드" : "") + (c.ver === "2" ? " RotW" : "");
}

function kstNow() {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date()) + " KST";
}

const D2EMU_URL = "https://d2emu.com/dclone/dclone.json";

// d2emu JSON의 키 이름 조립: 예) 아시아·논래더·소프트코어·RotW → krNonLadderRotw
function d2emuKey(c) {
  const reg = { "1": "us", "2": "eu", "3": "kr" }[c.region] || "kr";
  const lad = c.ladder === "1" ? "Ladder" : "NonLadder";
  const hc = c.hc === "1" ? "Hardcore" : "";
  const ver = c.ver === "2" ? "Rotw" : "";
  return reg + lad + hc + ver;
}

// ─────────────────────────────────────────────────────────────
// 데이터 조회
// ─────────────────────────────────────────────────────────────

// d2emu JSON은 대상마다 다시 받을 필요가 없으므로 한 번만 받아 재사용한다
async function fetchD2emu() {
  const resp = await fetch(D2EMU_URL, {
    headers: {
      "User-Agent": "dclone-watch (personal low-frequency monitor; github.com/BAEggman/dclone-watch)",
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`d2emu HTTP ${resp.status}`);
  return await resp.json();
}

// 1순위: d2emu — 게임 내 상주 클라이언트가 자동 감지 (제보 불필요)
function readD2emu(data, c) {
  const key = d2emuKey(c);
  const entry = data[key];
  if (!entry || typeof entry.status !== "number") throw new Error(`d2emu 응답에 ${key} 없음`);
  return {
    progress: entry.status + 1, // d2emu는 0부터 시작 (0 = 1/6 단계)
    reported_ts: entry.updated_at || null,
    last_walk_ts: entry.last_walked_utc || null,
    server: label(c),
    checked: new Date().toISOString(),
    source: "d2emu(자동감지)",
  };
}

async function pollD2emu(c) {
  return readD2emu(await fetchD2emu(), c);
}

// 2순위: diablo2.io — 유저 제보 기반
async function pollDiablo2io(c) {
  const url = `https://diablo2.io/dclone_api.php?region=${c.region}&ladder=${c.ladder}&hc=${c.hc}&ver=${c.ver}`;
  const resp = await fetch(url, {
    headers: {
      // 봇 차단 회피용 브라우저형 헤더 (개인용 저빈도 폴링)
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`diablo2.io HTTP ${resp.status}`);
  let data = await resp.json();
  if (!Array.isArray(data)) data = data.dclone || [];
  if (!data.length) throw new Error("응답에 해당 서버 데이터 없음");
  const row = data[0];
  return {
    progress: parseInt(row.progress, 10),
    reported_ts: row.timestamped ? parseInt(row.timestamped, 10) : null,
    server: label(c),
    checked: new Date().toISOString(),
    source: "diablo2.io(제보)",
  };
}

// d2emu 우선, 실패하면 diablo2.io 제보 데이터로 폴백
async function poll(c, d2emuData) {
  try {
    if (d2emuData) return readD2emu(d2emuData, c);
    return await pollD2emu(c);
  } catch (e) {
    console.log(`d2emu 실패(${d2emuKey(c)}) → diablo2.io 폴백:`, e.message);
    return await pollDiablo2io(c);
  }
}

// ─────────────────────────────────────────────────────────────
// 카카오톡 '나에게 보내기' — 구독자 전원에게 각자의 카톡으로
// ─────────────────────────────────────────────────────────────
const KAKAO_SUBS_KEY = "kakao:subs";
const KAUTH = "https://kauth.kakao.com";
const KAPI = "https://kapi.kakao.com";

async function loadSubs(env) {
  const raw = await env.STATE.get(KAKAO_SUBS_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

async function saveSubs(env, subs) {
  await env.STATE.put(KAKAO_SUBS_KEY, JSON.stringify(subs));
}

/**
 * 액세스 토큰 확보. 카카오 토큰 수명이 이 봇의 유일한 급소다:
 *   - 액세스 토큰 6시간
 *   - 리프레시 토큰 2개월, 그런데 '만료 1달 남은 시점부터'만 갱신 응답에 새 것이 딸려온다
 * 그러므로 응답에 refresh_token이 있으면 반드시 덮어써야 한다. 안 그러면
 * 잘 돌다가 정확히 두 달 뒤 조용히 죽는다.
 * @returns {boolean} sub 객체가 갱신되었으면 true (호출부가 KV에 저장해야 함)
 */
async function ensureAccessToken(env, sub) {
  if (sub.at && sub.atExp && sub.atExp > Date.now() + 60_000) return false;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.KAKAO_REST_KEY,
    refresh_token: sub.refresh,
  });
  if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);

  const r = await fetch(`${KAUTH}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));

  if (!r.ok || !j.access_token) {
    sub.fail = (sub.fail || 0) + 1;
    sub.lastError = `토큰 갱신 실패 HTTP ${r.status} ${j.error || ""}`.trim();
    throw new Error(sub.lastError);
  }

  sub.at = j.access_token;
  sub.atExp = Date.now() + ((j.expires_in || 21600) - 300) * 1000;
  if (j.refresh_token) sub.refresh = j.refresh_token;   // ★ 이 한 줄이 봇의 수명을 좌우한다
  sub.fail = 0;
  delete sub.lastError;
  return true;
}

async function sendMemo(env, sub, text, linkUrl) {
  const template = {
    object_type: "text",
    text: text.slice(0, 200),           // 카카오 텍스트 템플릿 상한 200자
    link: { web_url: linkUrl, mobile_web_url: linkUrl },
    button_title: "트래커 열기",
  };
  const r = await fetch(`${KAPI}/v2/api/talk/memo/default/send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sub.at}`,
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`발송 실패 HTTP ${r.status} ${t.slice(0, 120)}`);
  }
  return true;
}

async function notifyKakao(env, text, linkUrl = TRACKER_URL) {
  if (!env.KAKAO_REST_KEY) return { sent: 0, failed: 0, skipped: "KAKAO_REST_KEY 미설정" };
  const subs = await loadSubs(env);
  if (!subs.length) return { sent: 0, failed: 0, skipped: "구독자 없음" };

  let dirty = false, sent = 0, failed = 0;
  for (const sub of subs) {
    try {
      if (await ensureAccessToken(env, sub)) dirty = true;
      await sendMemo(env, sub, text, linkUrl);
      sent++;
    } catch (e) {
      failed++;
      dirty = true;
      sub.fail = (sub.fail || 0) + 1;
      sub.lastError = String(e.message || e);
      console.log(`카톡 발송 실패 [${sub.nick || sub.id}]:`, sub.lastError);
    }
  }
  if (dirty) await saveSubs(env, subs);   // 굴러간 리프레시 토큰을 반드시 남긴다
  return { sent, failed };
}

// ─────────────────────────────────────────────────────────────
// 디스코드 (선택) / GitHub 이메일 차선 기동
// ─────────────────────────────────────────────────────────────
async function notifyDiscord(env, text) {
  if (!env.DISCORD_WEBHOOK) return;
  await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text.slice(0, 1900) }),
  });
}

// 변동 감지 시 GitHub Actions 워크플로를 원격 기동 → 이메일 차선이 몇 분 내 발송
async function triggerGitHub(env, reason) {
  if (!env.GH_TOKEN || !env.GH_REPO) {
    console.log("GitHub 기동 생략: GH_TOKEN/GH_REPO 미설정");
    return false;
  }
  const wf = env.GH_WORKFLOW || "dclone-watch.yml";
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${wf}/dispatches`,
      {
        method: "POST",
        headers: {
          "authorization": `Bearer ${env.GH_TOKEN}`,
          "accept": "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "dclone-fast-worker",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      }
    );
    console.log("GitHub 워크플로 기동:", reason, "→ HTTP", resp.status);
    return resp.status === 204;
  } catch (e) {
    console.log("GitHub 기동 실패:", e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 감시 본체
// ─────────────────────────────────────────────────────────────

// 대상별 상태 키. 예전 단일 키("last")에 남아 있던 값은 한 번만 넘겨받는다.
function stateKey(c) { return `last:${d2emuKey(c)}`; }

async function readPrev(env, c, isLegacyTarget) {
  const raw = await env.STATE.get(stateKey(c));
  if (raw) { try { return JSON.parse(raw); } catch { return null; } }
  if (isLegacyTarget) {
    const old = await env.STATE.get("last");   // v3까지 쓰던 키에서 승계
    if (old) { try { return JSON.parse(old); } catch { return null; } }
  }
  return null;
}

/** 한 대상의 진행도 변화를 판정해 알림 문구를 만든다 (순수 함수 — 테스트 대상) */
function buildMessages(c, p, q) {
  const [en, kr] = STAGES[p] || ["?", "?"];
  const srv = label(c);
  const short = shortLabel(c);
  let long = null, kakao = null;

  if (q === null) {
    if (p >= c.minStage) {
      long = `**[우버디아] 현재 ${p}/6** — ${srv}\n${en}\n(${kr})`;
      kakao = `[우버디아] 현재 ${p}/6\n${short}\n${kr}`;
    }
  } else if (p > q) {
    if (p >= 6) {
      long = `@everyone 🔥 **[우버디아] 소환!! 6/6** — ${srv}\n${en}\n(${kr})\n지금 게임 안에 있어야 합니다!`;
      kakao = `🔥 우버디아 소환!! 6/6\n${short}\n지금 게임 안에 있어야 합니다!`;
    } else if (p >= c.minStage) {
      long = `**[우버디아] ${q}/6 → ${p}/6 상승** — ${srv}\n${en}\n(${kr})` +
             (p >= 5 ? "\n⚔ 지금 헬 게임을 만들어 대기하세요!" : "");
      kakao = `[우버디아] ${q}/6 → ${p}/6 상승\n${short}\n${kr}` +
              (p >= 5 ? "\n⚔ 지금 헬 게임 만들고 대기!" : "");
    }
  } else if (p < q && q >= c.resetFrom) {
    long = `**[우버디아] 진행도 하락 ${q}/6 → ${p}/6** — ${srv}\n그 사이 소환→처치가 있었을 수 있습니다.`;
    kakao = `[우버디아] 하락 ${q}/6 → ${p}/6\n${short}\n그 사이 소환→처치가 있었을 수 있습니다.`;
  }
  return { long, kakao };
}

async function check(env) {
  const list = targets(env);
  const legacyKey = d2emuKey({
    region: env.REGION || "3", ladder: env.LADDER || "2",
    hc: env.HC || "2", ver: env.VER || "1",
  });

  let d2emuData = null;
  try { d2emuData = await fetchD2emu(); }
  catch (e) { console.log("d2emu 일괄 조회 실패 → 대상별 폴백:", e.message); }

  let anyChanged = false;
  const changes = [];

  for (const c of list) {
    let cur;
    try {
      cur = await poll(c, d2emuData);
    } catch (e) {
      console.log(`조회 실패(${d2emuKey(c)}):`, e.message); // 일시 오류는 다음 주기에 재시도
      continue;
    }
    const prev = await readPrev(env, c, d2emuKey(c) === legacyKey);
    const p = cur.progress;
    const q = prev ? prev.progress : null;
    const { long, kakao } = buildMessages(c, p, q);

    console.log(`조회 완료[${cur.source || "?"}] ${d2emuKey(c)}:`, `${p}/6`,
                "(이전:", (q === null ? "없음" : q + "/6") + ")");

    if (q !== p) { anyChanged = true; changes.push(`${d2emuKey(c)} ${q === null ? "-" : q}/6 → ${p}/6`); }

    if (long) {
      const stamp = `\n${kstNow()} · ${TRACKER_URL}`;
      await notifyDiscord(env, long + stamp);
      const r = await notifyKakao(env, `${kakao}\n${kstNow()}`);
      console.log(`알림 발송 ${d2emuKey(c)}:`, q, "→", p,
                  `· 카톡 ${r.sent}명 성공/${r.failed}명 실패${r.skipped ? " (" + r.skipped + ")" : ""}`);
    }
    if (!prev || q !== p) {
      await env.STATE.put(stateKey(c), JSON.stringify({ progress: p, at: Date.now() }));
    }
  }

  // 어느 대상이든 변동이 있으면 이메일 차선을 한 번만 기동
  if (anyChanged) await triggerGitHub(env, changes.join(", "));
}

// ─────────────────────────────────────────────────────────────
// 카카오 구독 등록 (길드원 셀프 서비스)
//   /kakao/join?c=<초대코드>       → 카카오 동의 화면으로 보냄
//   /kakao/callback?code=...       → 토큰 교환 후 KV에 저장
//   /kakao/subs?c=<초대코드>       → 구독자 목록 (토큰은 노출하지 않음)
//   /kakao/test?c=<초대코드>       → 전원에게 테스트 발송
// ─────────────────────────────────────────────────────────────
function page(title, body) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title>` +
    `<div style="font:16px/1.7 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;` +
    `max-width:34rem;margin:12vh auto;padding:0 1.5rem;text-align:center">${body}</div>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function joinAllowed(env, u) {
  if (!env.KAKAO_JOIN_CODE) return false;
  return u.searchParams.get("c") === env.KAKAO_JOIN_CODE;
}

async function handleKakaoRoutes(env, u) {
  const path = u.pathname.replace(/\/+$/, "");

  if (path === "/kakao/join") {
    if (!joinAllowed(env, u)) return page("초대 코드 필요", "<h2>초대 코드가 필요합니다</h2><p>길드에서 받은 링크로 접속해 주세요.</p>");
    if (!env.KAKAO_REST_KEY || !env.KAKAO_REDIRECT_URI) {
      return page("설정 미완료", "<h2>설정이 아직입니다</h2><p>KAKAO_REST_KEY / KAKAO_REDIRECT_URI를 먼저 등록하세요.</p>");
    }
    const auth = new URL(`${KAUTH}/oauth/authorize`);
    auth.searchParams.set("client_id", env.KAKAO_REST_KEY);
    auth.searchParams.set("redirect_uri", env.KAKAO_REDIRECT_URI);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", "talk_message");
    auth.searchParams.set("state", env.KAKAO_JOIN_CODE);
    return Response.redirect(auth.toString(), 302);
  }

  if (path === "/kakao/callback") {
    const code = u.searchParams.get("code");
    if (!code) return page("등록 실패", "<h2>인가 코드가 없습니다</h2><p>링크를 다시 눌러 주세요.</p>");
    if (u.searchParams.get("state") !== env.KAKAO_JOIN_CODE) {
      return page("등록 실패", "<h2>요청이 확인되지 않았습니다</h2><p>길드 링크로 다시 시도해 주세요.</p>");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.KAKAO_REST_KEY,
      redirect_uri: env.KAKAO_REDIRECT_URI,
      code,
    });
    if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);

    const r = await fetch(`${KAUTH}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) {
      return page("등록 실패", `<h2>토큰을 받지 못했습니다</h2><p>${(j.error_description || j.error || r.status)}</p>`);
    }

    // 사용자 식별 (중복 등록 방지)
    let id = null, nick = null;
    try {
      const me = await fetch(`${KAPI}/v2/user/me`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${j.access_token}`,
          "content-type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body: new URLSearchParams({ property_keys: JSON.stringify(["properties.nickname"]) }),
      });
      const mj = await me.json().catch(() => ({}));
      id = mj.id != null ? String(mj.id) : null;
      nick = mj.properties?.nickname || null;
    } catch { /* 닉네임은 없어도 그만 */ }

    const subs = await loadSubs(env);
    const rec = {
      id: id || `anon-${Date.now()}`,
      nick: nick || "이름없음",
      refresh: j.refresh_token,
      at: j.access_token,
      atExp: Date.now() + ((j.expires_in || 21600) - 300) * 1000,
      joined: new Date().toISOString(),
      fail: 0,
    };
    const idx = subs.findIndex((s) => s.id === rec.id);
    if (idx >= 0) subs[idx] = { ...subs[idx], ...rec }; else subs.push(rec);
    await saveSubs(env, subs);

    try {
      await sendMemo(env, rec, `우버디아 알림 등록 완료 ✅\n${nick || ""}님, 이제 진행도가 오르면 여기로 알려드립니다.`, TRACKER_URL);
    } catch { /* 환영 메시지는 실패해도 등록은 유효 */ }

    return page("등록 완료", `<h2>등록 완료 ✅</h2><p>${nick ? nick + "님, " : ""}이제 우버디아 진행도가 오르면<br>카카오톡 '나와의 채팅'으로 알림이 갑니다.</p><p style="color:#888;font-size:14px">이 창은 닫으셔도 됩니다.</p>`);
  }

  if (path === "/kakao/subs") {
    if (!joinAllowed(env, u)) return new Response("forbidden", { status: 403 });
    const subs = await loadSubs(env);
    return new Response(JSON.stringify({
      count: subs.length,
      subs: subs.map((s) => ({ id: s.id, nick: s.nick, joined: s.joined, fail: s.fail || 0, lastError: s.lastError || null })),
    }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  if (path === "/kakao/test") {
    if (!joinAllowed(env, u)) return new Response("forbidden", { status: 403 });
    const r = await notifyKakao(env, `테스트 발송입니다.\n우버디아 알림이 정상 동작합니다.\n${kstNow()}`);
    return new Response(JSON.stringify(r, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  return null;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env));
  },

  // 워커 주소로 접속하면 현재 상태를 바로 보여준다 (동작 확인/수동 조회용)
  // ?selftest=1 → GitHub 워크플로 기동 경로 검증 · ?src=1 → 소스별 비교
  async fetch(request, env) {
    try {
      const u = new URL(request.url);

      if (u.pathname.startsWith("/kakao/")) {
        const res = await handleKakaoRoutes(env, u);
        if (res) return res;
      }

      const list = targets(env);

      if (u.searchParams.get("src") === "1") {
        // 두 소스를 각각 조회해 상태를 나란히 보여준다 (이중화 점검용)
        const out = {};
        for (const c of list) {
          const k = d2emuKey(c);
          out[k] = {};
          try { out[k].d2emu = await pollD2emu(c); } catch (e) { out[k].d2emu = { error: String(e) }; }
          try { out[k].diablo2io = await pollDiablo2io(c); } catch (e) { out[k].diablo2io = { error: String(e) }; }
        }
        return new Response(JSON.stringify(out, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      if (u.searchParams.get("selftest") === "1") {
        const ok = await triggerGitHub(env, "selftest(수동 검증)");
        return new Response(
          JSON.stringify({ selftest: true, github_dispatch_ok: ok }, null, 2),
          { headers: { "content-type": "application/json; charset=utf-8" } }
        );
      }

      let d2emuData = null;
      try { d2emuData = await fetchD2emu(); } catch { /* 폴백은 poll이 처리 */ }

      const watching = [];
      for (const c of list) {
        const k = d2emuKey(c);
        try {
          const cur = await poll(c, d2emuData);
          const raw = await env.STATE.get(stateKey(c));
          watching.push({
            key: k,
            ...cur,
            message_en: (STAGES[cur.progress] || ["?"])[0],
            message_kr: (STAGES[cur.progress] || ["", "?"])[1],
            saved_state: raw ? JSON.parse(raw) : null,
          });
        } catch (e) {
          watching.push({ key: k, server: label(c), error: String(e) });
        }
      }

      const subs = await loadSubs(env);
      return new Response(JSON.stringify({
        watching,
        kakao: { subscribers: subs.length, configured: !!env.KAKAO_REST_KEY },
        note: "2분마다 자동 확인(d2emu 자동감지 우선, diablo2.io 폴백). 변동 시 이메일 차선 기동 + 카톡 발송. ?src=1 로 소스별 비교.",
        credit: "Data courtesy of d2emu.com & diablo2.io",
      }, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  },
};
