# Eagle IVD

Eagle IVD는 eagle 전용 YouTube 동영상 다운로드 및 관리 플러그인입니다.

## 프로젝트 구조

```
EagleIVD/
├── downloads/          # 다운로드된 파일 저장 디렉토리
├── js/                 # JavaScript 소스 코드
├── views/             # UI 뷰 파일들
├── node_modules/      # Node.js 의존성 패키지
├── manifest.json      # 애플리케이션 매니페스트
├── index.html         # 메인 HTML 파일
├── package.json       # 프로젝트 의존성 및 설정
└── subscriptions.db   # 구독 정보 데이터베이스
```

## 주요 기능

YouTube 동영상 다운로드
기본적인 yt-dlp 활용 영상 다운로드 및 메타데이터도 Eagle에 반영
코드 모듈화
재생목록 구독 및 자동 다운로드
구독리스트 조회용 자체 jsonDB 사용
다운로드 속도 제어 및 설정 UI
NIC 선택(만일을 대비한ip차단 우회)
재생목록별 멀티쓰레딩 다운으로 속도 최적화
별도 모듈 활용한 라이브러리 중복 검사 및 통합 기능
Eagle 라이브러리와 불일치 여부 검사 기능

## 기술 스택

- Electron
- Node.js
- SQLite (sqlite3)
- YouTube-dl

## 의존성 패키지

- axion: ^0.1.0
- axios: ^1.7.9
- better-sqlite3: ^11.9.1
- nedb-promises: ^6.2.3
- sqlite: ^5.1.1
- sqlite3: ^5.1.7
- youtube-dl-exec: ^3.0.12

## 개발 환경 설정

1. Node.js 설치
2. 프로젝트 클론
3. 의존성 설치:
   ```bash
   npm install
   ```
4. 개발 서버 실행:
   ```bash
   npm start
   ```

## 빌드

```bash
npm run build
```

## 라이선스

이 프로젝트는 MIT 라이선스 하에 배포됩니다. 