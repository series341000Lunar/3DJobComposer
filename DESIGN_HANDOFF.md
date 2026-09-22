# 3DJobComposer 설계 인계서

작성 기준일: 2026-09-22  
프로젝트 경로: `C:\_InternalProjects\3DJobComposer`  
현재 Composer 버전: `0.2.1`  
현재 manifest schema: `1.1`

이 문서는 다른 Codex 계정이나 개발 담당자가 기존 설계 계약을 훼손하지 않고 3DJobComposer를 유지·확장하기 위한 인계 문서다. 구현 세부사항보다 아래의 **변경 불가 원칙**을 먼저 이해해야 한다.

## 1. 제품 정의

3DJobComposer는 자연어 작업 요청과 사용자가 제공한 Reference를 표준 Job Package로 정리하는 Windows 로컬 도구다.

```text
Human Input
→ 3DJobComposer
→ Standardized Job Package
→ 3dAI / 실제 제작 작업자
→ 3D Production
```

Composer는 다음 작업을 대신하지 않는다.

- 3D 모델링
- 제품 또는 기술 조사
- Reference 자동 분석
- 제작 판단 및 검증
- Codex, 3dAI, Blender 등의 자동 실행
- ImageGen 실제 실행

Composer는 필수 관문이 아니라 반복 작업 표준화, Reference 관리, 조건 기록, 실행 결과 비교 및 재현성을 위한 **선택적 인터페이스**다. Composer를 거치지 않은 요청도 정상적인 3dAI 작업 방식이다.

## 2. 변경 불가 설계 계약

### 2.1 자연어 우선

Job Description 원문은 요약, 확장 또는 재해석하지 않는다. 다음 정도의 문장만으로도 유효한 Job이다.

```text
QNAP TS-1655를 만들어주세요.
필요하면 인터넷에서 3면도나 공식 자료를 찾아주세요.
```

정확한 치수, 좌표, 도면, 재질값, 구조 분석 결과를 사전 입력하도록 강제하지 않는다. 사용자가 알고 있거나 명시적으로 통제하려는 정보만 구조화한다.

### 2.2 구조화 입력은 선택 사항

Asset Category, Quality, Motion, Subject, Purpose, DCC, Unit, Work Scope, Deliverables는 제작 의도를 보조하는 필드다. 알 수 없는 값은 `Unspecified` 또는 빈 목록으로 표현할 수 있어야 한다.

Job 생성에 본질적으로 필요한 것은 다음뿐이다.

- 안전하게 변환 가능한 Job Name
- 비어 있지 않은 Job Description
- 절대경로 Job Root

### 2.3 새 Job과 기존 Job 저장의 분리

```text
NEW JOB
→ CREATE JOB
→ 동일 폴더가 있으면 덮어쓰기 금지

LOAD JOB
→ 명시적으로 로드된 Job에 한해 SAVE JOB
→ 같은 폴더의 manifest/TASK 갱신 허용
```

임의 경로 덮어쓰기를 허용하지 않는다. Load 성공 시 서버가 메모리 기반 편집 토큰을 발급하며, SAVE는 해당 토큰이 가리키는 Job에만 가능하다. 서버가 재시작되면 다시 Load해야 한다.

### 2.4 manifest가 Canonical Source

기존 Job UI 복원은 `manifest.json`을 기준으로 한다. `TASK.md`를 역분석해 manifest를 만들지 않는다. `TASK.md`는 사람이 읽는 파생 결과물이다.

### 2.5 원본 Reference 보존

- 신규 Reference는 바이트를 변경하지 않고 `references/`에 복사한다.
- resize, recompress, convert하지 않는다.
- UI에서 기존 Reference를 제거하면 manifest와 TASK에서는 제외한다.
- 기존 Reference 파일은 보수적으로 디스크에 남긴다.
- 누락된 파일은 Load 경고로 표시하며 가능한 나머지 데이터는 복원한다.

### 2.6 RUN_LOG 보존

새 Job은 빈 `RUN_LOG.md` 템플릿을 포함한다. 실제 실행 결과는 3dAI 또는 제작 작업자가 기록한다.

- Composer는 실행 결과를 임의로 채우지 않는다.
- 기존 `RUN_LOG.md`는 SAVE 시 수정, 삭제, 초기화하지 않는다.
- 구형 Job에 RUN_LOG가 없으면 Load 시 경고하고 최초 SAVE 시 빈 템플릿을 추가한다.

### 2.7 AI Reference Package는 계획 데이터

AI Reference Package는 “추후 어떤 모델링 보조 이미지를 생성할 것인가”를 기록한다. Composer는 ImageGen을 호출하지 않는다. 특히 `Three-View + Isometric`은 새로운 디자인을 발명하는 기능이 아니라 Source Reference에서 확인 가능한 형상을 Front / Side / Rear / Isometric으로 정리하려는 요청이다.

## 3. 프로젝트 구조

```text
3DJobComposer/
├─ package.json
├─ README.md
├─ DESIGN_HANDOFF.md
├─ start-3DJobComposer.bat
├─ src/
│  ├─ server/
│  │  ├─ constants.js
│  │  ├─ job-schema.js
│  │  ├─ job-service.js
│  │  ├─ task-renderer.js
│  │  └─ server.js
│  └─ web/
│     ├─ index.html
│     ├─ app.js
│     └─ styles.css
├─ templates/
│  └─ RUN_LOG.template.md
└─ test/
   └─ job-service.test.js
```

Git baseline이 설정되어 있다. 작업 전 현재 branch, HEAD, git status를 확인할 것. `.tmp/`는 실행 로그용이며 인계 패키지에서 제외해도 된다.

## 4. 모듈 책임

### `constants.js`

Composer/schema 버전과 UI에서 사용하는 허용값 목록을 정의한다. UI 옵션을 HTML에 중복 하드코딩하지 않고 `/api/config`로 전달한다.

### `job-schema.js`

- 사용자 입력 검증 및 정규화
- Windows-safe Job Name 생성
- manifest 1.1 구성
- AI Reference Package Item 검증

### `job-service.js`

- 새 Job의 staged/atomic 생성
- 기존 Job 로드와 schema 1.0 호환 변환
- 로드된 Job 저장
- Reference 원본 복사 및 보존 정책
- RUN_LOG 템플릿 생성과 기존 로그 보존

### `task-renderer.js`

정규화된 Job 데이터를 사람이 읽는 `TASK.md`로 렌더링한다. Description과 Notes 의미를 추가하거나 다시 쓰지 않는다.

### `server.js`

- Node 내장 HTTP 서버
- 정적 UI 제공
- JSON API
- Load 편집 토큰과 Open Folder 토큰을 메모리에 보관
- `127.0.0.1`에만 기본 바인딩

### `web/app.js`

- New/Edit 모드 관리
- Reference preview, Role, Note 관리
- manifest 기반 UI 복원
- AI Reference Package authoring
- CREATE와 SAVE API 분리

## 5. 실행 환경

요구사항:

- Windows 10 이상
- Node.js 20 이상
- 외부 npm package 없음

권장 실행:

```text
start-3DJobComposer.bat 더블클릭
```

또는:

```powershell
node src/server/server.js
```

기본 URL:

```text
http://127.0.0.1:4173
```

중요: 배치파일은 `C:\Program Files\nodejs\node.exe`를 우선 사용한다. Codex 내부 Node runtime은 workspace 외부 Job Root에 쓸 때 `EPERM`이 발생할 수 있으므로 사용자 실행용으로 사용하지 않는다. `/api/config` 응답과 UI 우측 상단에서 실제 Node 실행 경로/PID를 확인할 수 있다.

## 6. 생성되는 Job Package

```text
<JobRoot>/
└─ <sanitized-job-name>/
   ├─ TASK.md
   ├─ manifest.json
   ├─ RUN_LOG.md
   ├─ references/
   ├─ work/
   └─ output/
```

역할:

- `TASK.md`: 사람이 읽기 좋은 작업지시서
- `manifest.json`: 구조화된 canonical 입력
- `RUN_LOG.md`: 실제 실행 이력
- `references/`: 사용자 제공 Reference와 작업 자료
- `work/`: 작업 중간 산출물
- `output/`: 최종 산출물

## 7. manifest 1.1 개요

```json
{
  "schema_version": "1.1",
  "composer_version": "0.2.1",
  "job": {
    "name": "example_job",
    "description": "사용자 원문"
  },
  "asset": {
    "category": "Unspecified",
    "quality": "Unspecified",
    "motion": [],
    "subject": []
  },
  "target": {
    "purpose": "Unspecified",
    "dcc": "Unspecified",
    "unit": "Unspecified"
  },
  "work_scope": ["Unspecified"],
  "deliverables": [],
  "references": [],
  "reference_package": {
    "enabled": false,
    "items": []
  }
}
```

Schema 1.0 호환 정책:

- `target.outputs`를 `deliverables`로 변환
- 누락된 `work_scope`는 `Unspecified`
- 누락된 `reference_package`는 disabled/empty
- 누락된 RUN_LOG는 Load 경고 후 최초 SAVE에서 템플릿 추가
- 지원하지 않는 미래 값은 경고하고 가능한 필드만 복원

## 8. AI Reference Package 데이터

각 Item은 다음 필드를 가진다.

- `id`: `RP-001` 형식
- `enabled`
- `mode`
- `scope`: `Whole Asset` 또는 `Specific Part`
- `source_references`: `REF-001` 형식 배열
- `target_part`: Specific Part일 때 사용
- `note`: 사용자 원문

현재 Mode:

- Part ID
- Silhouette
- Contour + Panel Lines
- Neutral Clay
- Neutral Clay + Weak AO
- Directional Light — Left / Right / Top
- Isolated Part — Orthographic / Isometric
- Three-View + Isometric

## 9. HTTP API 계약

- `GET /api/config`: 버전, runtime, UI 옵션
- `POST /api/jobs`: 새 Job 생성; 기존 폴더 충돌 시 `409`
- `POST /api/jobs/load`: manifest 기준 기존 Job 로드, 편집 토큰 발급
- `POST /api/jobs/save`: 유효한 편집 토큰의 Job만 저장
- `POST /api/open-folder`: 서버가 발급한 토큰의 폴더만 Explorer로 열기

Request 본문은 최대 150 MB다. Reference는 현재 Base64 JSON으로 전송하므로 매우 큰 이미지가 많으면 메모리 사용량이 증가한다.

## 10. 검증 기준

실행:

```powershell
node --test
```

현재 자동 테스트는 다음을 확인한다.

1. Schema 1.1 새 Job 구조 및 RUN_LOG 생성
2. Reference 원본 바이트, 순서, Role, Note 보존
3. 기존 Job Load와 Reference 복원
4. Load 후 SAVE와 기존 RUN_LOG byte-for-byte 보존
5. 새 Job overwrite 금지
6. Three-View + Isometric manifest/TASK 기록
7. Schema 1.0 호환 Load 및 누락 RUN_LOG 추가
8. 이름/경로 sanitize
9. 자연어만 있고 구조화 조건이 비어 있는 Job 생성

변경 후에는 최소한 다음을 수행한다.

```powershell
node --check src\server\server.js
node --check src\web\app.js
node --test
```

UI 변경 시 실제 브라우저에서 New Job 기본값, 기존 Job Load, SAVE 성공, Reference preview, AI Package 복원 및 브라우저 console error 부재를 확인한다.

## 11. 안전 규칙

- 사용자 Job, Reference, RUN_LOG, work, output을 테스트 데이터로 수정하지 않는다.
- 실제 Job을 검증할 때 Load는 가능하지만 SAVE는 사용자 요청 없이 하지 않는다.
- 새 Job 생성은 임시 sibling 폴더에서 완성한 뒤 최종 폴더로 rename한다.
- 기존 Job Save는 `manifest.json`과 `TASK.md`만 갱신하고 RUN_LOG를 보존한다.
- 제거된 Reference 파일의 자동 삭제 기능을 추가하지 않는다. 필요하면 별도 opt-in 기능으로 설계한다.
- manifest 경로는 상대경로만 사용하고 Reference path traversal을 허용하지 않는다.
- 외부 계정, Cloud, Codex CLI, DCC 실행을 이 계층에 임의로 결합하지 않는다.

## 12. 알려진 제한 사항

- 네이티브 Folder Picker 없음; 경로 직접 입력
- Reference drag-to-reorder 없음
- Base64 업로드로 인한 대용량 이미지 메모리 비용
- 편집 토큰은 서버 메모리에만 존재
- 제거된 Reference의 고아 파일 자동 정리 없음
- 실제 ImageGen/3dAI/Codex 실행 없음
- 정식 JSON Schema 파일과 schema migration CLI 없음
- Git baseline 이후 변경 상태는 git status와 HEAD로 확인

## 13. 권장 다음 단계

우선순위 제안:

1. Native Folder Picker
2. Reference 순서 변경 UI
3. `manifest.schema.json`과 명시적 migration 테스트
4. 대용량 Reference를 위한 multipart/streaming 업로드
5. 사용자가 명시적으로 선택하는 고아 Reference 정리
6. Composer와 분리된 AI Reference Package 실행 계층
7. Composer와 분리된 3dAI/Codex handoff 계층

실행 연동을 추가할 때도 Composer의 역할은 authoring/packaging으로 유지하고, 조사·판단·제작 책임을 실행 계층으로 분리한다.

## 14. 다른 계정으로 인계할 때 복사할 항목

필수:

- 이 프로젝트 폴더 전체 (`.tmp/` 제외 가능)
- 실제 Job Root 위치 정보, 예: `C:\_InternalProjects\3DJobs`
- Node.js 설치 요구사항
- 본 `DESIGN_HANDOFF.md`

불필요:

- Codex 내부 Node cache 경로
- `.tmp/system-server.*.log`
- 기존 서버 PID
- 계정 토큰 또는 비밀정보

새 계정은 작업 시작 전에 다음을 확인한다.

1. `package.json`과 `constants.js` 버전 일치
2. `node --test` 통과
3. `start-3DJobComposer.bat`이 시스템 Node를 사용
4. `/api/config`이 예상 Composer/schema/runtime을 반환
5. 실제 Job에는 읽기 전용 Load 검증만 수행하고 임의 SAVE하지 않음

## 15. 새 Codex 계정용 시작 프롬프트

아래 내용을 새 계정에 그대로 전달할 수 있다.

```text
프로젝트: C:\_InternalProjects\3DJobComposer

먼저 DESIGN_HANDOFF.md와 README.md를 전부 읽고 현재 파일 및 테스트 상태를 확인하십시오.

3DJobComposer는 자연어 작업 요청과 Reference를 표준 Job Package로 정리하는 선택적 로컬 인터페이스입니다. Composer는 모델링, 기술조사, Reference 분석, 제작 판단 또는 ImageGen 실행을 담당하지 않습니다. 자연어 원문을 보존하고 구조화 필드를 강제하지 마십시오.

새 Job은 기존 폴더를 덮어쓰면 안 됩니다. 기존 Job은 Composer에서 명시적으로 Load하여 발급받은 편집 토큰이 있을 때만 같은 폴더에 SAVE할 수 있습니다. manifest.json이 UI 복원의 canonical source이며 TASK.md는 파생 문서입니다.

RUN_LOG.md는 실제 제작 작업자의 실행 기록입니다. 새 Job에는 빈 템플릿만 생성하고, 기존 RUN_LOG는 어떤 SAVE에서도 수정·삭제·초기화하지 마십시오. Reference 원본도 변환하거나 자동 삭제하지 마십시오.

작업 전 node --test를 실행하고, 변경 후 전체 테스트와 실제 브라우저 UI를 검증하십시오. 실제 C:\_InternalProjects\3DJobs 아래 사용자 Job은 명시적 요청 없이 SAVE하거나 변경하지 마십시오.
```

## 16. Phase 1 저장 안정화 (2026-09-22)

- NEW의 CREATE는 기존 폴더를 거부한다. 명시적으로 LOAD한 Job은 서버 편집 토큰이 지정한 동일 폴더에 SAVE CHANGES할 수 있다.
- SAVE는 새 내용을 staging/검증하고 이전 바이트와 checksum을 recovery journal에 보관한 뒤 반영한다. 실패하면 문서와 새 Reference를 원상 복구하고 검증한다. 복구 실패·중단은 경로와 상태를 명시하며 후속 SAVE를 차단한다.
- 기존 RUN_LOG는 바이트 단위로 보존한다. 누락된 RUN_LOG 최초 생성도 같은 복구 대상에 포함한다. 기존 Reference 제거 시 디스크 파일을 삭제하지 않는다.
- 성공 응답의 Reference 경로를 UI에 반영하여 변경 없는 반복 SAVE가 파일을 복제하지 않는다.
- No-op Load→Save는 original_name, 명시적 빈 배열, 변경하지 않은 absent/null 상태와 추가 metadata를 보존한다.
- 미지원/future schema는 경고와 읽기 전용으로 취급하며 편집 토큰을 발급하지 않는다. SAVE 직전 디스크 schema도 재검사한다. 알려진 1.0→1.1 호환은 유지한다.
- 서버는 127.0.0.1에 바인딩한다. 실제 포트의 local Host, 허용 local Origin, application/json을 검사한 뒤 모든 POST를 처리한다. 스크립트 호출에도 Origin 헤더가 필요하다.
- 복구 시 Composer 및 다른 작성자를 중지한 뒤 `node src/server/recover-save.js "<Job 절대경로>"`를 실행한다. backup이 들어 있는 `.composer-save-recovery`를 임의로 삭제하지 않는다. 상세 상태·절차는 README의 Phase 1 계약을 따른다.
- 기존 9개 + 추가 21개 회귀 테스트. 추가 장애 주입은 `.tmp/phase1-*` 합성 fixture에만 수행한다. 선택적 실제 Edge 검증은 `tools/browser-phase1.mjs`를 사용한다.
- F05 비활성 초안 정책과 F07 stale 편집 충돌 정책은 변경하지 않았다. 전원 장애/NAS 장치 내구성, 외부 작성자와의 동시 I/O는 보장하지 않는다.
- Composer 0.2.1 / schema 1.1을 유지한다. 새 사용자 기능 또는 manifest 필드 추가는 없다.
