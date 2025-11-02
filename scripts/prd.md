<context>
# Overview  
Eagle IVD는 YouTube 재생목록을 자동으로 다운로드하고, 라이브러리와 동기화하는 데스크탑 애플리케이션입니다.
Eagle 사용자들을 위한 플러그인 형태로 동작하며,
반복적이고 대량의 동영상 다운로드 및 관리 문제를 해결합니다. 주요 타겟은 미디어 수집, 백업, 자동화가 필요한 사용자입니다.

# Core Features  
- **YouTube 동영상 다운로드**: yt-dlp를 활용하여 재생목록 전체를 자동으로 다운로드
- **메타데이터 동기화**: 다운로드한 영상의 메타데이터를 Eagle 라이브러리와 연동
- **재생목록 구독 및 자동 다운로드**: 사용자가 원하는 재생목록을 구독하고, 새로운 영상이 추가되면 자동으로 다운로드
- **다운로드 속도 제어 및 설정 UI**: 사용자별 네트워크 환경에 맞는 속도 제어 및 설정 제공
- **NIC 선택 및 IP 우회**: 네트워크 인터페이스 카드(NIC) 선택 기능으로 IP 차단 우회 지원
- **멀티쓰레딩 다운로드**: 재생목록별로 병렬 다운로드를 지원하여 속도 최적화
- **중복 검사 및 통합**: 라이브러리 내 중복 파일 검사 및 통합 기능
- **Eagle 라이브러리 불일치 검사**: Eagle 라이브러리와 실제 파일 간 불일치 여부 검사 및 리포트


===최우선 구체적 기능추가 로드맵 ===
급하게 개선해야할 사항
현버전 1.5.0

다운로드시..

====
1.6.x
차단 우회 개선
(급함)NIC를 선택하면  영상확인 단계까진 작동도지만 실 다운로드 단계로 진입 안되는 치명적인 버그가 있음
ㄴ스레드별 yt dlp 랜덤 유저에이전트 적용, 별개의 NIC ip(source address) 적용 및 스레드 처리 기전 개선
ㄴㄴ해당 옵션에 대한 옵션 UI 에 추가 밎 반영
ㄴㄴ브라우저 쿠키 적용, 차단 우회용
ㄴㄴ스레드별 NIC 활용(현재는 전체 스레드가 같은 NIC에서 동작함)

1.7.x
속도 및 병렬화 개선(된거같음)
ㄴ초기 새영상 확인 기전 병렬화
ㄴ스레드 처리 기전 개선(현재 n개씩 병렬로 재생목록을 처리할때 재생목록이 많은 영상 수를 계산한 다음 적은 순 -> 많은 순으로 n개씩 다운로드 함. 하지만 이렇게 하면 영상 수가 많은 재생목록 수에 맞춰서 청크가 끝난다는 단점이 있음. 기존 영상수별 정렬 및 다운로드 기전을 아예 폐기하고, 스레드마다 재생목록을 할당시키고, 스레드가 담당하는 재생목록의 다운이 끝나면 바로 다음 재생목록을 다운할 수 있게, 이렇게 하면 3개의 쓰레드가 끊기지 않고 각자의 재생목록을 다른 NIC와 다른 에이전트로 계속 받을 수 있음)
1.8.x
ㄴ아니면 대신 ytdlp의 재생목록 다운 기능을 안쓰고 영상을 하나씩 다운해 DB, Eagle에 반영(대공사),필요할까?
ㄴ 이건 된거같은데 


# User Experience  
- **주요 사용자**: 미디어 수집가, 유튜브 아카이빙 유저, 자동화에 관심 있는 일반 사용자
- **주요 플로우**: 
  1. 앱 실행 → 재생목록 구독 추가 → 자동 다운로드 설정 → 다운로드/라이브러리 동기화 확인
  2. 설정 UI에서 속도, NIC, 중복 검사 등 세부 옵션 조정
- **UI/UX 고려사항**: 직관적인 구독/다운로드 관리, 진행상황 표시, 오류 및 중복 알림, 한글화 지원

# 구현 현황
- **다운로드/구독/동기화**: 90% (실제 동작, UI 연동, DB 반영)
- **속도제어/멀티쓰레딩**: 70% (명령어 옵션, UI 연동)
- **중복/불일치 검사**: 80% (리포트, 자동 처리, UI 연동)
- **자동 다운로드/주기적 체크**: 100% (EnhancedSubscriptionManager)
- **설정 UI/상태 표시**: 60% (UI 컨트롤러, 상태/명령어 프리뷰, 일부 고급 옵션 미구현)
- **다운받는 영상 고급 필터/검색, 자동 업데이트, 플랫폼 확장**: 0~20% (향후 개발 필요)

# 모듈 구조 및 구동 단계
- **main.js**: 전체 앱 진입점, 플러그인 초기화, 각 모듈 로딩 및 인스턴스 생성, 이벤트 핸들링, UI 전역 함수 등록
- **modules/**
  - **downloader.js**: yt-dlp 기반 다운로드 관리, 명령어 조립, 진행률/상태 UI 연동
  - **subscription-manager.js**: 구독 목록 관리, 자동 다운로드, DB 연동, 이벤트 처리
  - **library-maintenance.js**: 중복/불일치 검사, Eagle 라이브러리와 DB 동기화
  - **subscription-db.js**: SQLite 기반 DB 관리, playlist/video/library 테이블, CRUD 함수
  - **eagle-api.js**: Eagle 라이브러리 정보 조회, 연동 API
  - **ui-controller.js**: UI 상태/로그/오류 표시, 명령어 프리뷰 등
  - **utils.js**: FFmpeg 경로 탐색 등 유틸 함수
  - **subscription-checker.js, subscription-importer.js**: 구독 체크, 파일 임포트 등 보조 기능

- **구동 단계**
  1. 앱/플러그인 실행 → main.js에서 각 모듈 로딩, DB 초기화, 라이브러리 정보 등록
  2. 다운로드/구독 관리자/라이브러리 유지관리 인스턴스 생성
  3. 구독 목록/다운로드/동기화 초기화 (DB에서 정보 로드, UI 상태 초기화)
  4. 사용자 액션(구독 추가/삭제, 다운로드, 검사 등) → 각 모듈 메서드 호출 → DB/파일/라이브러리 반영
  5. 상태/진행률/오류 UI 실시간 표시 (ui-controller.js)

# 객체 및 데이터 흐름
- **SubscriptionManager/EnhancedSubscriptionManager**: 구독 목록, 자동 다운로드, 다운로드 관리자 연동, 이벤트 발생
- **DownloadManager**: 실제 다운로드 실행, 진행률/상태 UI 연동, 명령어 조립
- **LibraryMaintenance**: 중복/불일치 검사, Eagle 라이브러리와 DB 동기화
- **subscriptionDb**: SQLite DB 연결, playlist/video/library 테이블 관리, CRUD
- **UIController**: 상태/오류/명령어 프리뷰 등 UI 표시

# 전체 구동 플로우 예시
1. 앱 실행 → DB 및 라이브러리 초기화
2. 구독/다운로드/라이브러리 유지관리 인스턴스 생성
3. 구독 추가 → yt-dlp로 메타데이터 조회 → DB/라이브러리 등록
4. 자동/수동 다운로드 → 진행률 UI 표시 → 완료 후 파일/메타데이터 동기화
5. 중복/불일치 검사 → 리포트/자동 처리 → UI 알림

# Technical Architecture  
- **System components**: Electron 기반 데스크탑 앱, Node.js 백엔드, SQLite DB, yt-dlp 연동, 자체 jsonDB
- **Data models**: 재생목록(playlist), 비디오(video), 라이브러리(library) 테이블 구조 등 담긴 SQLite
- **APIs and integrations**: yt-dlp CLI, Eagle 라이브러리 연동, 네트워크 인터페이스 제어
- **Infrastructure requirements**: eagle애플리케이션, Windows 10 이상, Node.js, Electron, yt-dlp 실행파일 필요

# Development Roadmap  
- **MVP requirements**: 
  - YouTube 재생목록 구독/다운로드/동기화
  - 다운로드 속도 제어 및 설정 UI
  - 중복 검사 및 라이브러리 통합
  - 기본적인 오류 처리 및 리포트
- **Future enhancements**:
  - 다양한 플랫폼 지원(Mac/Linux)
  - 고급 필터링/검색 기능
  - 자동 업데이트 및 백그라운드 동작
  - 사용자별 맞춤화 옵션

# Logical Dependency Chain
- 1단계: yt-dlp 연동 및 기본 다운로드 기능 구현 OK
- 2단계: 재생목록 구독/자동 다운로드 로직
- 3단계: 라이브러리 동기화 및 중복 검사
- 4단계: 설정 UI, 속도 제어, NIC 선택 등 부가 기능
- 5단계: 오류 처리, 리포트, 한글화 등 사용자 경험 개선

# Risks and Mitigations  
- **유튜브에 의한 yt-dlp API 차단 대비**: yt-dlp 업데이트 모니터링 및 NIC 멀티쓰레딩 강화
- **대용량 다운로드 시 성능 저하**: 멀티쓰레딩, DB 최적화, 캐싱 적용
- **Eagle 라이브러리 구조 변경**: 구조 변경 시 호환성 레이어 추가
- **Resource constraints**: 오픈소스 활용, 커뮤니티 피드백 적극 반영

# Appendix  
- yt-dlp 공식 문서, Electron/Node.js/SQLite 레퍼런스
- Eagle api 공식 문서 : EagleIVD\gitbook_20250113_233320압축.md 
- 실제 사용 예시 및 테스트 케이스
</context>
<PRD>
# Technical Architecture  
- **System components**: Electron 기반 데스크탑 앱, Node.js 백엔드, SQLite DB, yt-dlp 연동, 자체 jsonDB
- **Data models**: 재생목록(playlist), 비디오(video), 라이브러리(library) 테이블 구조, 구독 정보 json
- **APIs and integrations**: yt-dlp CLI, Eagle 라이브러리 연동, 네트워크 인터페이스 제어
- **Infrastructure requirements**: eagle애플리케이션 Windows 10 이상, Node.js, Electron, yt-dlp 실행파일 필요

# Development Roadmap  
- **MVP requirements**: 
  - YouTube 재생목록 구독/다운로드/동기화
  - 다운로드 속도 제어 및 설정 UI
  - 중복 검사 및 라이브러리 통합
  - 기본적인 오류 처리 및 리포트
- **Future enhancements**:
  - 다양한 플랫폼 지원(Mac/Linux) - 무시
  - 고급 필터링/검색 기능 - 무시시
  - 자동 업데이트 및 백그라운드 동작 - 무시
  - 사용자별 맞춤화 옵션

# Logical Dependency Chain
- 1단계: yt-dlp 연동 및 기본 다운로드 기능 구현
- 2단계: 재생목록 구독/자동 다운로드 로직
- 3단계: 라이브러리 동기화 및 중복 검사
- 4단계: 설정 UI, 속도 제어, NIC 선택 등 부가 기능
- 5단계: 오류 처리, 리포트, 한글화 등 사용자 경험 개선

# Risks and Mitigations  
- **yt-dlp API 변경/차단**: yt-dlp 업데이트 모니터링 및 대체 수단 마련
- **대용량 다운로드 시 성능 저하**: 멀티쓰레딩, DB 최적화, 캐싱 적용
- **Eagle 라이브러리 구조 변경**: 구조 변경 시 호환성 레이어 추가
- **Resource constraints**: 오픈소스 활용, 커뮤니티 피드백 적극 반영

# Appendix  
- yt-dlp 공식 문서, Electron/Node.js/SQLite 레퍼런스
- 실제 사용 예시 및 테스트 케이스
</PRD>
