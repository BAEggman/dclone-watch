#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dclone_watch.py — 우버 디아블로(디아블로 클론) 진행도 감시 + 이메일 알림

동작 원리
  1) diablo2.io 공개 API에서 지정한 서버(지역/래더/코어/버전)의 진행도(1~6)를 가져온다.
     실패 시 d2runewizard API(토큰 필요, 선택)로 폴백한다.
  2) 직전 실행 때 저장한 state.json 과 비교해서
     - 진행도가 ALERT_MIN_STAGE 이상으로 "상승"하면  → 알림 메일
     - 6/6 (소환!)                                   → 알림 메일 (항상)
     - 4/6 이상이었다가 리셋되면                     → 리셋 감지 메일
  3) 변경된 상태를 state.json 에 저장한다. (GitHub Actions가 커밋)

설정은 전부 환경변수로 한다. (README.md 참고)
외부 라이브러리 없이 파이썬 표준 라이브러리만 사용한다.
"""

import json
import os
import smtplib
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

# ──────────────────────────────────────────────
# 설정 (환경변수, 미설정 시 기본값)
# ──────────────────────────────────────────────
REGION = os.environ.get("REGION", "3").strip() or "3"    # 1=아메리카 2=유럽 3=아시아
LADDER = os.environ.get("LADDER", "2").strip() or "2"    # 1=래더 2=스탠다드(논래더)
HC     = os.environ.get("HC", "2").strip() or "2"        # 1=하드코어 2=소프트코어
VER    = os.environ.get("VER", "1").strip() or "1"       # 1=LoD 2=RotW(워록의 지배)

ALERT_MIN_STAGE = int(os.environ.get("ALERT_MIN_STAGE", "3") or 3)  # 이 단계부터 메일
NOTIFY_RESET    = (os.environ.get("NOTIFY_RESET", "1") or "1") != "0"
RESET_FROM      = 4          # 이 단계 이상에서 떨어지면 "리셋 감지"로 간주
STALE_HOURS     = 72         # 마지막 제보가 이보다 오래되면 경고 문구 추가

STATE_FILE = os.environ.get("STATE_FILE", "state.json")
SITE_DIR   = os.environ.get("SITE_DIR", "docs")   # GitHub Pages 상태 페이지 데이터 폴더

SMTP_HOST = os.environ.get("SMTP_HOST", "").strip()
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465") or 465)
SMTP_USER = os.environ.get("SMTP_USER", "").strip()
SMTP_PASS = os.environ.get("SMTP_PASS", "").strip()
MAIL_TO   = os.environ.get("MAIL_TO", "").strip()        # 쉼표로 여러 명 가능
MAIL_FROM = os.environ.get("MAIL_FROM", "").strip() or SMTP_USER

# 선택 사항
D2RW_TOKEN      = os.environ.get("D2RW_TOKEN", "").strip()    # d2runewizard 백업 소스
D2RW_CONTACT    = os.environ.get("D2RW_CONTACT", "").strip()  # d2rw 요구 헤더용 이메일
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK", "").strip()

DRY_RUN    = (os.environ.get("DRY_RUN", "") or "") == "1"       # 메일 대신 화면 출력
FORCE_TEST = (os.environ.get("FORCE_TEST", "") or "") == "1"    # 테스트 메일 발송 후 종료
MOCK       = os.environ.get("MOCK_PROGRESS", "").strip()        # 테스트용 가짜 진행도

KST = timezone(timedelta(hours=9))

REGION_KR = {"1": "아메리카", "2": "유럽", "3": "아시아"}
LADDER_KR = {"1": "래더", "2": "스탠다드(논래더)"}
HC_KR     = {"1": "하드코어", "2": "소프트코어"}
VER_KR    = {"1": "LoD", "2": "RotW"}

STAGES = {
    1: ("Terror gazes upon Sanctuary",              "공포가 성역을 응시합니다"),
    2: ("Terror approaches Sanctuary",              "공포가 성역으로 접근합니다"),
    3: ("Terror begins to form within Sanctuary",   "공포가 성역 안에서 형체를 갖추기 시작합니다"),
    4: ("Terror spreads across Sanctuary",          "공포가 성역 전역으로 퍼져나갑니다"),
    5: ("Terror is about to be unleashed upon Sanctuary", "공포가 곧 성역에 풀려납니다"),
    6: ("Diablo has invaded Sanctuary",             "디아블로가 성역을 침공했습니다 — 소환!"),
}

TRACKER_URL = "https://diablo2.io/dclonetracker.php"


def server_label() -> str:
    return "{} / {} / {} / {}".format(
        REGION_KR.get(REGION, REGION), LADDER_KR.get(LADDER, LADDER),
        HC_KR.get(HC, HC), VER_KR.get(VER, VER))


def state_key() -> str:
    return f"{REGION}_{LADDER}_{HC}_{VER}"


# ──────────────────────────────────────────────
# 데이터 소스
# ──────────────────────────────────────────────
def _http_get(url: str, headers: dict, timeout: int = 25) -> bytes:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_diablo2io():
    """1차 소스. 토큰 불필요. 반환: (progress:int, reported_ts:int|None, source:str)"""
    url = (f"https://diablo2.io/dclone_api.php"
           f"?region={REGION}&ladder={LADDER}&hc={HC}&ver={VER}")
    raw = _http_get(url, {
        "User-Agent": "Mozilla/5.0 (compatible; dclone-watch/1.0; personal email notifier)",
        "Accept": "application/json",
    })
    data = json.loads(raw.decode("utf-8"))
    if isinstance(data, dict):          # 혹시 {"dclone":[...]} 형태로 감싸져 오는 경우 대비
        data = data.get("dclone", [])
    if not data:
        raise RuntimeError("diablo2.io 응답에 해당 서버 데이터가 없습니다")
    row = data[0]
    return int(row["progress"]), int(row.get("timestamped") or 0) or None, "diablo2.io"


def fetch_d2runewizard():
    """백업 소스. 무료 토큰 필요 (README 참고)."""
    if not D2RW_TOKEN:
        raise RuntimeError("D2RW_TOKEN 미설정 (백업 소스 사용 안 함)")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    headers = {
        "User-Agent": "dclone-watch/1.0",
        "Accept": "application/json",
        "D2R-Contact": D2RW_CONTACT or (MAIL_TO.split(",")[0].strip() if MAIL_TO else "unknown@example.com"),
        "D2R-Platform": "GitHub Actions personal email notifier",
        "D2R-Repo": f"https://github.com/{repo}" if repo else "private personal script",
    }
    url = f"https://d2runewizard.com/api/trackers/diablo-clone?token={D2RW_TOKEN}"
    data = json.loads(_http_get(url, headers).decode("utf-8"))

    want_ladder = (LADDER == "1")
    want_hc     = (HC == "1")
    want_region = {"1": "Americas", "2": "Europe", "3": "Asia"}[REGION]
    want_rotw   = (VER == "2")

    candidates = []
    for s in data.get("servers", []):
        if bool(s.get("ladder")) != want_ladder:
            continue
        if bool(s.get("hardcore")) != want_hc:
            continue
        if s.get("region") != want_region:
            continue
        candidates.append(s)
    if not candidates:
        raise RuntimeError("d2runewizard 응답에서 해당 서버를 찾지 못했습니다")

    def is_rotw(s):
        blob = (str(s.get("server", "")) + " " + str(s.get("expansion", "")) +
                " " + str(s.get("version", ""))).lower()
        return "rotw" in blob or "warlock" in blob

    # LoD/RotW 분리 서버가 함께 오면 원하는 쪽을 고른다
    picked = [s for s in candidates if is_rotw(s) == want_rotw] or candidates
    s = picked[0]
    ts = None
    lu = s.get("lastUpdate") or {}
    if isinstance(lu, dict) and lu.get("seconds"):
        ts = int(lu["seconds"])
    return int(s["progress"]), ts, "d2runewizard.com"


def get_progress():
    if MOCK:  # 테스트 모드
        return int(MOCK), int(datetime.now(tz=KST).timestamp()), "mock(테스트)"
    errors = []
    for fn in (fetch_diablo2io, fetch_d2runewizard):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 - 소스별 실패는 폴백으로 처리
            errors.append(f"{fn.__name__}: {e}")
    raise RuntimeError("모든 데이터 소스 실패:\n  " + "\n  ".join(errors))


# ──────────────────────────────────────────────
# 상태 저장/로드
# ──────────────────────────────────────────────
def load_state() -> dict:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(st: dict) -> None:
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
        f.write("\n")


# ──────────────────────────────────────────────
# 알림 (이메일 / 디스코드)
# ──────────────────────────────────────────────
def fmt_reported(ts) -> str:
    if not ts:
        return "정보 없음"
    dt = datetime.fromtimestamp(int(ts), tz=KST)
    mins = max(0, int((datetime.now(tz=KST) - dt).total_seconds() // 60))
    if mins < 60:
        ago = f"{mins}분 전"
    elif mins < 60 * 48:
        ago = f"{mins // 60}시간 전"
    else:
        ago = f"{mins // 1440}일 전"
    return dt.strftime("%Y-%m-%d %H:%M KST") + f" ({ago})"


def build_body(kind: str, cur: int, prev, ts, source: str) -> str:
    en, kr = STAGES.get(cur, ("?", "?"))
    lines = []
    lines.append("우버 디아블로(디아블로 클론) 진행도 알림")
    lines.append("")
    lines.append(f"서버    : {server_label()}")
    if prev is not None and kind in ("rise", "reset"):
        lines.append(f"진행도  : {cur}/6   (이전 {prev}/6)")
    else:
        lines.append(f"진행도  : {cur}/6")
    lines.append(f"단계    : {en}")
    lines.append(f"          ({kr})")
    lines.append(f"제보    : {fmt_reported(ts)}   [출처: {source}]")

    if ts:
        age_h = (datetime.now(tz=KST) - datetime.fromtimestamp(int(ts), tz=KST)).total_seconds() / 3600
        if age_h > STALE_HOURS:
            lines.append("")
            lines.append(f"⚠ 마지막 제보가 {int(age_h // 24)}일 전입니다. 제보가 뜸한 서버라")
            lines.append("  실제 진행도와 다를 수 있으니 게임 내 /uberdiablo 명령으로 확인하세요.")

    extra = []
    if kind == "spawn":
        extra = ["🔥 소환되었습니다! 지금 접속해 있던 헬 난이도 게임에서",
                 "   슈퍼 유니크 몬스터(엘드리치, 쉔크, 핀들 등)가 디아 클론으로 대체됩니다."]
    elif kind == "reset":
        extra = ["진행도가 리셋되었습니다. 지난 확인 이후(최대 1시간 사이)에",
                 "소환→처치가 이미 끝났을 가능성이 큽니다."]
    elif kind == "test":
        extra = ["✅ 테스트 메일입니다. 설정이 정상적으로 완료되었습니다!"]
    if extra:
        lines.append("")
        lines.extend(extra)

    lines.append("")
    lines.append("단계 안내")
    for i in range(1, 7):
        mark = "→" if i == cur else " "
        lines.append(f" {mark} {i}/6  {STAGES[i][0]}")
    lines.append("")
    lines.append("팁: 5/6이 되면 미리 헬 난이도 게임을 만들어 안에서 대기하세요.")
    lines.append("    6/6 발동 순간 '게임 안에 있어야' 소환 대상이 됩니다.")
    lines.append("")
    lines.append(f"실시간 트래커: {TRACKER_URL}")
    lines.append("Data courtesy of diablo2.io")
    return "\n".join(lines)


def send_email(subject: str, body: str) -> None:
    if DRY_RUN:
        print("=" * 60)
        print("[DRY_RUN] 발송될 메일 미리보기")
        print("제목:", subject)
        print("-" * 60)
        print(body)
        print("=" * 60)
        return
    missing = [n for n, v in [("SMTP_HOST", SMTP_HOST), ("SMTP_USER", SMTP_USER),
                              ("SMTP_PASS", SMTP_PASS), ("MAIL_TO", MAIL_TO)] if not v]
    if missing:
        print("[오류] 이메일 설정(Secrets)이 비어 있습니다:", ", ".join(missing))
        print("       README.md 의 'GitHub Secrets 등록' 단계를 확인하세요.")
        sys.exit(1)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = MAIL_FROM
    msg["To"] = MAIL_TO
    msg.set_content(body)

    recipients = [a.strip() for a in MAIL_TO.split(",") if a.strip()]
    ctx = ssl.create_default_context()
    if SMTP_PORT == 465:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx, timeout=30) as s:
            s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg, to_addrs=recipients)
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as s:
            s.starttls(context=ctx)
            s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg, to_addrs=recipients)
    print(f"[메일 발송 완료] {subject}  → {MAIL_TO}")


def send_discord(text: str) -> None:
    if not DISCORD_WEBHOOK or DRY_RUN:
        return
    try:
        payload = json.dumps({"content": text[:1900]}).encode("utf-8")
        req = urllib.request.Request(
            DISCORD_WEBHOOK, data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "dclone-watch/1.0"})
        urllib.request.urlopen(req, timeout=15).read()
        print("[디스코드 발송 완료]")
    except Exception as e:  # noqa: BLE001 - 부가 채널 실패는 치명적이지 않음
        print("[디스코드 발송 실패 - 무시]", e)


# ──────────────────────────────────────────────
# 상태 웹페이지(GitHub Pages) 데이터 갱신
# ──────────────────────────────────────────────
def update_site(cur: int, prev, ts, source: str, changed: bool) -> None:
    """docs/status.json(현재 상태)과 docs/history.json(변동 기록)을 갱신한다.
    docs/index.html 이 이 두 파일을 읽어 화면에 표시한다."""
    try:
        os.makedirs(SITE_DIR, exist_ok=True)
        now_iso = datetime.now(tz=KST).isoformat(timespec="seconds")
        en, kr = STAGES.get(cur, ("?", "?"))
        status = {
            "server": server_label(),
            "region": REGION_KR.get(REGION, REGION),
            "ladder": LADDER_KR.get(LADDER, LADDER),
            "core": HC_KR.get(HC, HC),
            "ver": VER_KR.get(VER, VER),
            "progress": cur,
            "message_en": en,
            "message_kr": kr,
            "reported_ts": ts,
            "checked": now_iso,
            "source": source,
            "alert_min_stage": ALERT_MIN_STAGE,
        }
        with open(os.path.join(SITE_DIR, "status.json"), "w", encoding="utf-8") as f:
            json.dump(status, f, ensure_ascii=False, indent=2)
            f.write("\n")

        hist_path = os.path.join(SITE_DIR, "history.json")
        try:
            with open(hist_path, "r", encoding="utf-8") as f:
                hist = json.load(f)
            if not isinstance(hist, list):
                hist = []
        except (FileNotFoundError, json.JSONDecodeError):
            hist = []
        if changed:
            hist.insert(0, {"at": now_iso, "from": prev, "to": cur,
                            "reported_ts": ts, "source": source})
            hist = hist[:60]
        with open(hist_path, "w", encoding="utf-8") as f:
            json.dump(hist, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"[페이지 데이터 갱신] {SITE_DIR}/status.json (진행도 {cur}/6)")
    except Exception as e:  # noqa: BLE001 - 페이지 갱신 실패가 알림을 막으면 안 됨
        print("[페이지 데이터 갱신 실패 - 무시]", e)


# ──────────────────────────────────────────────
# 메인 로직
# ──────────────────────────────────────────────
def main() -> None:
    tag = f"[우버디아] {REGION_KR.get(REGION, REGION)} {LADDER_KR.get(LADDER, LADDER)}"

    if FORCE_TEST:
        cur, ts, src = 3, int(datetime.now(tz=KST).timestamp()), "테스트"
        fetched = False
        try:
            cur, ts, src = get_progress()
            fetched = True
        except Exception as e:  # noqa: BLE001 - 테스트 메일은 조회 실패해도 발송
            print("[안내] 현재 진행도 조회 실패, 예시 값으로 테스트 메일을 보냅니다:", e)
        send_email(f"{tag} 테스트 메일 ({cur}/6)", build_body("test", cur, None, ts, src))
        if fetched:  # 실제 데이터를 가져왔다면 상태 페이지도 바로 채워준다
            update_site(cur, None, ts, src, changed=False)
        return

    cur, ts, source = get_progress()
    print(f"[조회] {server_label()} → {cur}/6  (출처 {source}, 제보 {fmt_reported(ts)})")

    st = load_state()
    same_server = st.get("key") == state_key()
    prev = st.get("progress") if same_server else None

    kind = None
    if prev is None:
        if cur >= ALERT_MIN_STAGE:
            kind = "spawn" if cur >= 6 else "rise"
    elif cur > prev:
        if cur >= 6:
            kind = "spawn"
        elif cur >= ALERT_MIN_STAGE:
            kind = "rise"
    elif cur < prev and prev >= RESET_FROM and NOTIFY_RESET:
        kind = "reset"

    if kind == "spawn":
        subject = f"🔥 {tag} 소환!! 6/6 — 디아블로가 성역을 침공했습니다"
    elif kind == "rise":
        subject = f"{tag} 진행도 {cur}/6 {'(' + str(prev) + '/6 → 상승)' if prev is not None else ''}".strip()
    elif kind == "reset":
        subject = f"{tag} 리셋 감지 ({prev}/6 → {cur}/6) — 그 사이 소환됐을 수 있음"
    else:
        subject = None

    if subject:
        body = build_body(kind, cur, prev, ts, source)
        send_email(subject, body)
        send_discord(f"**{subject}**\n{server_label()} — {STAGES[cur][0]}\n{TRACKER_URL}")
    else:
        print(f"[변화 없음/기준 미달] 이전 {prev}/6 → 현재 {cur}/6 (알림 기준 {ALERT_MIN_STAGE}/6)")

    # 하트비트: 20일 이상 상태 변화가 없으면 파일을 갱신해 커밋을 유발
    # (GitHub은 60일간 저장소 활동이 없으면 예약 실행을 꺼버리기 때문)
    now_iso = datetime.now(tz=KST).isoformat(timespec="seconds")
    hb = st.get("heartbeat", "")
    try:
        hb_old = (datetime.now(tz=KST) - datetime.fromisoformat(hb)).days >= 20
    except ValueError:
        hb_old = True
    save_state({
        "key": state_key(),
        "server": server_label(),
        "progress": cur,
        "timestamped": ts,
        "checked": now_iso,
        "heartbeat": now_iso if hb_old else hb,
        "source": source,
    })
    update_site(cur, prev, ts, source, changed=(prev is None or cur != prev))


if __name__ == "__main__":
    main()
