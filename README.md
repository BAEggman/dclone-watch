# 우버 디아블로 소환 알리미 (dclone-watch)

디아블로 2 레저렉티드의 **우버 디아블로(디아 클론)** 진행도를 매시간 자동으로 확인해서, 단계가 올라가면 **이메일로 알려주는** 시스템입니다. 현재 단계를 언제든 열어볼 수 있는 **상태 웹페이지(GitHub Pages)** 도 포함되어 있습니다. 서버나 항상 켜둔 PC 없이, GitHub Actions 무료 플랜만으로 24시간 돌아갑니다.

## 어떻게 알아내나요?

우버 디아는 조던 링(SoJ)이 상인에게 일정 개수 팔리면 소환됩니다. 정확한 개수는 블리자드가 공개하지 않고, 대신 게임이 **6단계 진행 메시지**를 띄웁니다 (`/uberdiablo` 명령으로 확인 가능). 전 세계 유저들이 이 메시지를 [diablo2.io 트래커](https://diablo2.io/dclonetracker.php)에 제보하고, 이 시스템은 그 공개 API를 매시간 조회합니다.

진행도는 **지역(아메리카/유럽/아시아) × 래더/스탠다드 × 소프트코어/하드코어 × LoD/RotW** 조합마다 따로 집계됩니다. 기본 설정은 **아시아 / 스탠다드(논래더) / 소프트코어 / LoD** 입니다.

| 단계 | 게임 내 메시지 |
|---|---|
| 1/6 | Terror gazes upon Sanctuary |
| 2/6 | Terror approaches Sanctuary |
| 3/6 | Terror begins to form within Sanctuary |
| 4/6 | Terror spreads across Sanctuary |
| 5/6 | Terror is about to be unleashed upon Sanctuary |
| 6/6 | **Diablo has invaded Sanctuary — 소환!** |

## 파일 구성

```
dclone_watch.py                     ← 확인 + 메일 발송 + 페이지 데이터 갱신 스크립트 (파이썬)
.github/workflows/dclone-watch.yml  ← 매시간 자동 실행 스케줄러 (GitHub Actions)
docs/index.html                     ← 상태 웹페이지 (GitHub Pages)
README.md                           ← 이 문서
state.json, docs/status.json, docs/history.json ← 실행하면 자동 생성·갱신됨 (직접 만들 필요 없음)
```

---

## 설치 (약 10~15분, GitHub 계정만 있으면 됨)

### 1단계. 이메일 발송용 비밀번호 준비

알림을 "보내는" 계정이 필요합니다. 본인 메일 계정을 쓰면 됩니다.

**Gmail을 쓰는 경우 (권장)**
1. Google 계정 → 보안 → **2단계 인증**을 켭니다 (앱 비밀번호의 필수 조건).
2. 보안 검색창에 **"앱 비밀번호"** 를 검색해 들어가서 새로 하나 만듭니다.
3. 생성된 **16자리 코드**를 복사해 둡니다. (일반 로그인 비밀번호가 아닙니다!)
4. 설정값: `SMTP_HOST`=`smtp.gmail.com`, `SMTP_PORT`=`465`

**네이버 메일을 쓰는 경우**
1. 네이버 메일 → 환경설정 → **POP3/IMAP 설정** → "사용함"으로 변경합니다.
2. 네이버는 2단계 인증 사용 시 [앱 비밀번호](https://help.naver.com)를 발급받아 쓰는 것이 안전합니다.
3. 설정값: `SMTP_HOST`=`smtp.naver.com`, `SMTP_PORT`=`465`, `SMTP_USER`=네이버 아이디 전체 주소

### 2단계. GitHub 저장소 만들기

1. [github.com](https://github.com) 가입/로그인 → 우상단 **+** → **New repository**
2. 이름은 아무거나 (예: `dclone-watch`) 정합니다. **상태 웹페이지(Pages)까지 쓰려면 Public을 선택**하세요 — 무료 플랜에서는 Public 저장소만 Pages를 쓸 수 있습니다. 공개돼도 노출되는 건 게임 진행도뿐이고, 이메일 주소와 비밀번호는 Secrets에 저장되어 코드에 보이지 않습니다. 이메일 알림만 쓸 거라면 Private도 됩니다. → **Create repository**

### 3단계. 파일 올리기

1. 저장소 화면에서 **Add file → Upload files** 로 `dclone_watch.py` 와 `README.md` 를 올리고 **Commit changes**.
2. 나머지 두 파일은 경로가 중요해서 **Add file → Create new file** 로 만듭니다. 파일 이름 칸에 경로를 그대로 입력하면 폴더가 자동으로 생깁니다:
   - `.github/workflows/dclone-watch.yml` → `dclone-watch.yml` 내용 붙여넣기 → Commit
   - `docs/index.html` → `index.html` 내용 붙여넣기 → Commit

**git이 익숙하다면** 압축을 푼 폴더에서 아래 명령으로 한 번에 커밋/푸시할 수 있습니다 (`<내아이디>`만 바꾸세요):

```bash
cd dclone-watch
git init
git add -A
git commit -m "우버디아 알리미 + 상태 페이지"
git branch -M main
git remote add origin https://github.com/<내아이디>/dclone-watch.git
git push -u origin main
```

### 4단계. Secrets 등록 (이메일 정보를 안전하게 저장)

저장소 **Settings → Secrets and variables → Actions → New repository secret** 에서 아래 5개를 하나씩 등록합니다. 코드나 파일에 비밀번호를 직접 적으면 안 되고, 반드시 여기(Secrets)에만 넣으세요.

| Name | Value 예시 |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | `myaccount@gmail.com` |
| `SMTP_PASS` | 1단계에서 만든 앱 비밀번호 16자리 |
| `MAIL_TO` | 알림 받을 주소 (보내는 주소와 같아도 됨, 쉼표로 여러 개 가능) |

### 5단계. 테스트

1. 저장소 상단 **Actions** 탭 → 처음이면 "I understand... enable them" 버튼으로 활성화.
2. 왼쪽에서 **dclone-watch** 선택 → 오른쪽 **Run workflow** 버튼 → `force_test` 칸에 **1** 입력 → 실행.
3. 1~2분 안에 "테스트 메일"이 도착하면 성공! 이후로는 매시간 자동으로 확인합니다.
4. 메일이 안 오면 실행 기록(노란/빨간 아이콘)을 눌러 로그를 확인하세요. 어떤 Secret이 비었는지, 로그인이 실패했는지 한국어로 알려줍니다.

> 참고: 예약 실행이 실패하면 GitHub가 자동으로 실패 알림 메일을 보내주므로, 시스템이 조용히 죽어있을 걱정은 덜 수 있습니다.

### 6단계. (선택) 상태 웹페이지 켜기 — GitHub Pages

핸드폰이나 PC에서 언제든 열어 현재 단계를 확인할 수 있는 페이지입니다.

1. 저장소 **Settings → Pages** 로 이동합니다.
2. "Build and deployment"에서 Source를 **Deploy from a branch**, Branch를 **main** + **/docs** 로 지정하고 **Save**.
3. 1~2분 뒤 `https://<내아이디>.github.io/<저장소이름>/` 주소로 접속됩니다. (같은 화면 상단에 주소가 표시됩니다. 즐겨찾기/홈 화면에 추가해 두세요.)
4. 첫 데이터는 워크플로가 한 번 돈 뒤에 표시됩니다 — 5단계의 테스트 실행으로도 채워집니다.

페이지에는 현재 단계(공포 게이지), 게임 내 메시지, 마지막 제보/확인 시각, 최근 변동 기록이 표시됩니다. 열어두면 표시는 60초마다 새로고침되지만, **원본 데이터는 워크플로 주기(기본 1시간)로 갱신**된다는 점을 기억하세요. 갱신 때마다 저장소에 작은 커밋이 자동으로 쌓이는 것은 정상 동작입니다.

---

## 언제 메일이 오나요?

- 진행도가 **3/6 이상으로 올라갈 때**마다 (기본값, 변경 가능)
- **6/6 소환** 시 — 🔥 제목으로 항상 발송
- 4/6 이상이었다가 갑자기 낮은 단계로 **리셋**됐을 때 — "확인 사이에 소환이 끝났을 수 있음" 안내

메일에는 현재 단계, 이전 단계, 마지막 제보 시각(한국시간), 6단계 전체 안내와 대기 팁이 들어 있습니다.

## 설정 바꾸기

`.github/workflows/dclone-watch.yml` 파일을 GitHub에서 직접 수정(연필 아이콘)하면 됩니다.

| 항목 | 위치 | 값 |
|---|---|---|
| 지역 | `REGION` | `1` 아메리카 · `2` 유럽 · `3` 아시아 |
| 래더 여부 | `LADDER` | `1` 래더 · `2` 스탠다드(논래더) |
| 코어 | `HC` | `1` 하드코어 · `2` 소프트코어 |
| 게임 버전 | `VER` | `1` LoD · `2` RotW(워록의 지배 확장팩) |
| 알림 시작 단계 | `ALERT_MIN_STAGE` | `1`~`6` (낮출수록 메일이 잦아짐) |
| 확인 주기 | 상단 `cron` | `"7 * * * *"` 매시간 → `"*/15 * * * *"` 15분마다 |

선택 Secrets: `DISCORD_WEBHOOK` (등록하면 디스코드 채널로도 동시 발송), `D2RW_TOKEN`·`D2RW_CONTACT` (아래 백업 소스 참고).

## 알아둘 한계 3가지 (중요)

1. **유저 제보 기반입니다.** 아시아 스탠다드처럼 인구가 적은 서버는 제보가 늦거나 없을 수 있습니다. 메일에 "마지막 제보 시각"을 함께 표기하고, 3일 이상 오래된 데이터면 경고를 붙입니다. 게임 안에서 `/uberdiablo` 로 직접 확인하는 게 가장 정확합니다.
2. **매시간 확인은 급행 소환을 놓칠 수 있습니다.** 누군가 조던을 한 번에 왕창 팔면 1→6이 몇십 분 만에 끝나기도 합니다. 확인 주기를 15분으로 줄이거나(위 표 참고), 소환 직전 상황(4~5/6)에서는 [diablo2.io 트래커 페이지](https://diablo2.io/dclonetracker.php)의 소리 알람이나 d2emu 디스코드 실시간 알림을 병행하는 걸 추천합니다.
3. **6/6 발동 순간 게임 안에 있어야 합니다.** 소환 시점에 접속해 있던 헬 난이도 게임의 슈퍼 유니크(엘드리치·쉔크·핀들 등)가 디아 클론으로 바뀝니다. 그래서 실전 요령은 "5/6 메일이 오면 미리 방을 파고 대기"입니다.

## 백업 데이터 소스 (선택)

기본 소스인 diablo2.io가 일시적으로 막히거나 응답이 없으면, [d2runewizard.com](https://d2runewizard.com/integration)으로 자동 폴백할 수 있습니다. 무료 토큰을 발급받아 Secrets에 `D2RW_TOKEN`(토큰)과 `D2RW_CONTACT`(본인 이메일)를 추가하면 활성화됩니다. 필수는 아니고, 안정성을 높이고 싶을 때만 하세요.

## GitHub Actions 없이 내 PC에서 돌리기 (대안)

PC를 항상 켜두는 분이라면 로컬로도 가능합니다. 파이썬 설치 후:

```bat
:: run_dclone.bat 로 저장 (본인 정보로 수정)
set SMTP_HOST=smtp.gmail.com
set SMTP_PORT=465
set SMTP_USER=myaccount@gmail.com
set SMTP_PASS=앱비밀번호16자리
set MAIL_TO=myaccount@gmail.com
python C:\dclone\dclone_watch.py
```

윈도우 **작업 스케줄러**에서 "매 1시간마다 이 배치 파일 실행"으로 등록하면 됩니다. 이 방식은 비밀번호가 내 PC 파일에 평문으로 남으니 파일 권한에 주의하세요.

## 기타

- GitHub는 저장소에 60일간 활동이 없으면 예약 실행을 자동으로 끕니다. 스크립트가 주기적으로 상태 파일을 갱신(커밋)해서 대부분 방지되지만, 두어 달에 한 번 Actions 탭이 살아있는지 확인해 주세요. 꺼져 있으면 버튼 한 번으로 다시 켤 수 있습니다.
- 확인 주기를 늘려도 데이터 제공처 예의상 **5분보다 짧게는 설정하지 마세요.**
- 진행도 데이터 출처: **Data courtesy of [diablo2.io](https://diablo2.io/dclonetracker.php)** · 백업: d2runewizard.com
