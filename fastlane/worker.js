/**
 * dclone-fast — 우버 디아블로 고속 감시 차선 (Cloudflare Worker)
 *
 * 역할: 2분마다 diablo2.io 트래커(d2emu 자동 감지 데이터가 반영됨)를 확인하고,
 *       진행도가 변하면 ① GitHub 워크플로를 원격 기동해 이메일 차선을 즉시 돌리고
 *       ② (선택) 디스코드 웹후크로 푸시 알림을 보낸다.
 *
 * 필요한 것:
 *  - KV 네임스페이스 바인딩: STATE  (wrangler.toml 참고)
 *  - 변수: GH_REPO, GH_WORKFLOW  (wrangler.toml [vars] 참고)
 *  - 시크릿: GH_TOKEN(필수, 워크플로 기동용) · DISCORD_WEBHOOK(선택)
 *
 * 워커 URL에 브라우저로 접속하면 현재 상태 JSON을 보여준다(동작 확인용).
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

function cfg(env) {
  return {
    region: env.REGION || "3",
    ladder: env.LADDER || "2",
    hc: env.HC || "2",
    ver: env.VER || "1",
    minStage: parseInt(env.ALERT_MIN_STAGE || "2", 10),
    resetFrom: parseInt(env.RESET_MIN_STAGE || "2", 10),
  };
}

function label(c) {
  return `${REGION_KR[c.region] || c.region} ${LADDER_KR[c.ladder] || c.ladder} ` +
         `${HC_KR[c.hc] || c.hc} ${VER_KR[c.ver] || c.ver}`;
}

function kstNow() {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date()) + " KST";
}

async function poll(env) {
  const c = cfg(env);
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
  };
}

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

async function check(env) {
  const c = cfg(env);
  let cur;
  try {
    cur = await poll(env);
  } catch (e) {
    console.log("조회 실패:", e.message); // 일시 오류는 다음 주기에 재시도
    return;
  }
  const raw = await env.STATE.get("last");
  const prev = raw ? JSON.parse(raw) : null;
  const p = cur.progress;
  const q = prev ? prev.progress : null;
  const [en, kr] = STAGES[p] || ["?", "?"];
  let msg = null;

  if (q === null) {
    if (p >= c.minStage) msg = `**[우버디아] 현재 ${p}/6** — ${cur.server}\n${en}\n(${kr})`;
  } else if (p > q) {
    if (p >= 6) {
      msg = `@everyone 🔥 **[우버디아] 소환!! 6/6** — ${cur.server}\n${en}\n(${kr})\n지금 게임 안에 있어야 합니다!`;
    } else if (p >= c.minStage) {
      msg = `**[우버디아] ${q}/6 → ${p}/6 상승** — ${cur.server}\n${en}\n(${kr})` +
            (p >= 5 ? "\n⚔ 지금 헬 게임을 만들어 대기하세요!" : "");
    }
  } else if (p < q && q >= c.resetFrom) {
    msg = `**[우버디아] 진행도 하락 ${q}/6 → ${p}/6** — ${cur.server}\n그 사이 소환→처치가 있었을 수 있습니다.`;
  }

  console.log("조회 완료:", p + "/6", "(이전:", (q === null ? "없음" : q + "/6") + ")");

  if (q !== p) {
    // 진행도 변동(또는 첫 실행) → 이메일 차선(GitHub Actions)을 즉시 기동
    await triggerGitHub(env, `${q === null ? "-" : q}/6 → ${p}/6`);
  }
  if (msg) {
    await notifyDiscord(env, msg + `\n${kstNow()} · https://diablo2.io/dclonetracker.php`);
    console.log("알림 발송:", q, "→", p);
  }
  if (!prev || q !== p) {
    await env.STATE.put("last", JSON.stringify({ progress: p, at: Date.now() }));
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env));
  },

  // 워커 주소로 접속하면 현재 상태를 바로 보여준다 (동작 확인/수동 조회용)
  // ?selftest=1 을 붙이면 GitHub 워크플로 기동 경로를 즉석 검증한다
  async fetch(request, env) {
    try {
      const u = new URL(request.url);
      if (u.searchParams.get("selftest") === "1") {
        const ok = await triggerGitHub(env, "selftest(수동 검증)");
        return new Response(
          JSON.stringify({ selftest: true, github_dispatch_ok: ok }, null, 2),
          { headers: { "content-type": "application/json; charset=utf-8" } }
        );
      }
      const cur = await poll(env);
      const raw = await env.STATE.get("last");
      const body = {
        ...cur,
        message_en: (STAGES[cur.progress] || ["?"])[0],
        message_kr: (STAGES[cur.progress] || ["", "?"])[1],
        saved_state: raw ? JSON.parse(raw) : null,
        note: "이 워커는 2분마다 자동 확인하며, 변동 시 디스코드로 알립니다.",
        credit: "Data courtesy of diablo2.io",
      };
      return new Response(JSON.stringify(body, null, 2), {
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
