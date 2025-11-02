/**
 * 메인 모듈
 * 모든 모듈을 통합하고 플러그인 초기화 및 이벤트 핸들링
 */

const path = require('path');
let DownloadManager, EnhancedSubscriptionManager, LibraryMaintenance, eagleApi, utils, uiController;
const subscriptionDb = require('../js/modules/subscription-db.js');
const settings = require('../js/modules/settings.js');
console.log("DB모듈 로드 성공");
console.log("Settings 모듈 로드 성공");

// Random User-Agent 리스트 및 선택 함수
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.96 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.5790.102 Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 필요한 모듈 동적 로딩
function loadModules() {
  try {
    // __dirname이 정의되지 않았을 수 있으므로 현재 스크립트 경로에서 상대 경로 계산
    const currentDir = document.currentScript ? 
      document.currentScript.src.substring(0, document.currentScript.src.lastIndexOf('/')) : 
      'js';
    
    console.log("현재 스크립트 경로:", currentDir);
    
    // 다운로더 모듈 로드
    DownloadManager = require('../js/modules/downloader.js');
    console.log("다운로더 모듈 로드 성공");
    
    // 구독 관리자 모듈 로드
    const subManager = require('../js/modules/subscription-manager.js');
    EnhancedSubscriptionManager = subManager.EnhancedSubscriptionManager;
    console.log("구독 관리자 모듈 로드 성공");
    
    // 라이브러리 유지 관리 모듈 로드
    LibraryMaintenance = require('../js/modules/library-maintenance.js');
    console.log("라이브러리 유지 관리 모듈 로드 성공");
    
    // Eagle API 모듈 로드
    eagleApi = require('../js/modules/eagle-api.js');
    console.log("Eagle API 모듈 로드 성공");
    
    // 유틸리티 모듈 로드
    utils = require('../js/modules/utils.js');
    console.log("유틸리티 모듈 로드 성공");
    
    // UI 컨트롤러 모듈 로드
    uiController = require('../js/modules/ui-controller.js');
    console.log("UI 컨트롤러 모듈 로드 성공");
    
    return true;
  } catch (error) {
    console.error("모듈 로딩 실패:", error);
    return false;
  }
}

// 플러그인 생성 이벤트
eagle.onPluginCreate(async (plugin) => {
  console.log("onPluginCreate triggered");
  
  // 모듈 로딩
  if (!loadModules()) {
    console.error("필수 모듈을 로드하지 못했습니다. 플러그인을 초기화할 수 없습니다.");
    if (window.updateUI) {
      window.updateUI("오류: 필수 모듈을 로드하지 못했습니다.");
    }
    return;
  }

  // 0. 라이브러리 정보 확인 및 DB 초기화
  let libraryInfo;
  try {
    libraryInfo = await eagleApi.getLibraryInfo();
    if (!libraryInfo || !libraryInfo.path) {
      throw new Error('라이브러리 경로를 확인할 수 없습니다.');
    }
    await subscriptionDb.initDatabase(libraryInfo.path);
  } catch (error) {
    console.error('Failed to initialize database for current library:', error);
    uiController.showError(`데이터베이스를 초기화할 수 없습니다: ${error.message}`);
    return;
  }
  
  // 0.1. 데이터베이스 정리 (오래된 처리 락 해제)
  try {
    await subscriptionDb.cleanupStaleProcessingLocks(2); // 2시간 이상 오래된 락 해제
    console.log("[DB Cleanup] Stale processing locks cleaned up on startup");
  } catch (error) {
    console.error("[DB Cleanup] Failed to cleanup stale processing locks:", error);
  }

  // 다운로드 관리자 초기화
  const downloadManager = new DownloadManager(plugin.path);
  // 구독 관리자 초기화
  const subscriptionManager = new EnhancedSubscriptionManager(plugin.path);
  // 라이브러리 유지 관리 초기화
  const libraryMaintenance = new LibraryMaintenance(plugin.path);
  
  // 구독 관리자에 다운로드 관리자 설정
  subscriptionManager.setDownloadManager(downloadManager);

  try {
    await downloadManager.initialize();
    await subscriptionManager.initialize();
  } catch (error) {
    console.error("Failed to initialize managers:", error);
    uiController.showError(`Initialization failed: ${error.message}`);
    return;
  }

  // 라이브러리 변경 이벤트 핸들러 등록
  if (eagleApi.onLibraryChanged) {
    eagleApi.onLibraryChanged(async (libInfo) => {
      try {
        // libInfo가 undefined이거나 name이 없으면 강제로 라이브러리 정보 재조회
        if (!libInfo || !libInfo.name) {
          libInfo = await eagleApi.getLibraryInfo();
        }
        if (!libInfo || !libInfo.name) {
          uiController.showError('라이브러리 정보를 불러올 수 없습니다.');
          return;
        }
        await subscriptionDb.initDatabase(libInfo.path);
        await subscriptionManager.loadSubscriptions();
        // 구독목록 즉시 갱신
        if (window.loadSubscriptions) {
          await window.loadSubscriptions();
        }
        uiController.updateStatusUI(`라이브러리 변경됨: ${libInfo.name}`);
      } catch (e) {
        console.error('라이브러리 변경 처리 실패:', e);
        uiController.showError(`라이브러리 변경 처리 실패: ${e.message}`);
      }
    });
  }

  // 전역 UI 업데이트 함수
  window.updateUI = (message) => {
    // 직접 상태 영역 업데이트 (순환 호출 방지)
    const statusArea = document.getElementById("statusArea");
    if (statusArea) {
      statusArea.textContent = message;
    }
    uiController.appendLog(message);
  };

  // 전역 명령어 프리뷰 업데이트 함수
  window.updateCommandPreview = (command) => {
    // 직접 명령어 미리보기 영역 업데이트 (순환 호출 방지)
    const commandPreview = document.getElementById("commandPreview");
    const commandPreviewArea = document.getElementById("commandPreviewArea");
    
    if (commandPreview) {
      commandPreview.textContent = command;
    }
    
    if (commandPreviewArea) {
      commandPreviewArea.classList.remove("hidden");
    }
    
    // 로그에만 추가
    uiController.appendLog("[CMD] " + command);
  };
  
  // 단일 비디오 다운로드 함수 (새로운 큐 시스템 사용)
  window.handleDownload = async (
    url,
    format,
    quality,
    speedLimit,
    concurrency
  ) => {
    try {
      console.log("Handling download for single URL:", url);
      
      // UI 설정값 적용 (속도 제한, 동시 다운로드 수)
      downloadManager.applyUISettings();
      
      // Eagle 임포트를 위한 importer 설정
      if (subscriptionManager && subscriptionManager.importer && downloadManager.downloadQueue) {
        downloadManager.downloadQueue.setImporter(subscriptionManager.importer);
      }
      
      // 현재 설정값 읽기
      const sourceAddress = document.getElementById('sourceAddressSelect')?.value || '';
      const randomUa = document.getElementById('randomUaChk')?.checked || false;
      const cookieFile = document.getElementById('cookieFileInput')?.value || '';
      const rateLimit = parseInt(document.getElementById('rateLimit')?.value) || 0;
      
      // 속도 제한 적용 (UI 파라미터보다 UI 설정 우선)
      if (rateLimit > 0 && downloadManager.downloadQueue) {
        downloadManager.downloadQueue.setRateLimit(rateLimit);
      } else if (speedLimit && downloadManager.downloadQueue) {
        downloadManager.downloadQueue.setRateLimit(speedLimit);
      }
      
      const options = {
        folderName: 'Single Videos',
        sourceAddress: sourceAddress,
        userAgent: randomUa ? getRandomUserAgent() : '',
        cookieFile: cookieFile,
        maxConcurrent: concurrency || parseInt(document.getElementById('downloadBatchSize')?.value) || 3
      };

      // 새로운 큐 기반 다운로드 시작
      const result = await downloadManager.startVideoDownload(url, format, quality, options);
      console.log("Download complete!", result);
      uiController.updateStatusUI("Download complete!");

      // Eagle 임포트는 큐 시스템에서 자동으로 처리됨
    } catch (error) {
      console.error("Download failed:", error);
      uiController.showError(`Download failed: ${error.message}`);
    }
  };

  // 플레이리스트 다운로드 함수
  window.handleDownloadPlaylist = async (
    url,
    format,
    quality,
    speedLimit,
    concurrency
  ) => {
    try {
      console.log("Handling download for playlist URL:", url);

      // 메타데이터를 먼저 가져옵니다
      const playlistMetaArray = await downloadManager.getPlaylistMetadata(url);
      console.log(`Fetched metadata for ${playlistMetaArray.length} items in playlist.`);

      // 다운로드 시작
      await downloadManager.startDownload(
        url,
        format,
        quality,
        speedLimit,
        concurrency
      );
      console.log("Playlist download complete!");
      uiController.updateStatusUI("Playlist download complete!");

      // Eagle에 파일 추가
      await subscriptionManager.importAndRemoveDownloadedFiles(
        downloadManager.downloadFolder,
        url,
        playlistMetaArray[0] || {} // 첫 번째 항목 메타데이터 사용
      );
    } catch (error) {
      console.error("Playlist download failed:", error);
      uiController.showError(`Playlist download failed: ${error.message}`);
    }
  };

  // 다운로드 취소 함수
  window.cancelDownload = () => {
    downloadManager.cancel();
    subscriptionManager.cancelCheck();
    uiController.updateStatusUI("Operation cancelled");
  };

  // YouTube 미리보기 가져오기
  window.fetchYoutubePreview = async (url) => {
    try {
      const videoId = utils.getYoutubeVideoId(url);
      if (!videoId) {
        throw new Error("Invalid YouTube URL");
      }

      const thumbnailUrl = utils.getYoutubeThumbnailUrl(videoId);
      const title = await utils.getYoutubeVideoTitle(url, downloadManager.ytDlpPath);

      uiController.updateYoutubePreviewUI(thumbnailUrl, title);
    } catch (error) {
      console.error("Error fetching YouTube preview:", error);
      uiController.showError("Error fetching YouTube preview");
    }
  };

  // 구독 추가 함수
  window.addSubscription = async (subscriptionData) => {
    try {
      await subscriptionManager.addSubscription(subscriptionData);
      const subscriptions = await subscriptionManager.loadSubscriptions();
      uiController.updateSubscriptionListUI(subscriptions);
      uiController.updateStatusUI(`Subscription added for: ${subscriptionData.url}`);
    } catch (error) {
      console.error("Failed to add subscription:", error);
      uiController.showError(error.message);
    }
  };

  // 채널 구독 추가 함수
  window.addChannelSubscription = async (channelData) => {
    try {
      await subscriptionManager.addChannelSubscription(channelData);
      const subscriptions = await subscriptionManager.loadSubscriptions();
      uiController.updateSubscriptionListUI(subscriptions);
      uiController.updateStatusUI(`Channel subscription added for: ${channelData.url}`);
    } catch (error) {
      console.error("Failed to add channel subscription:", error);
      uiController.showError(error.message);
    }
  };

  // 구독 삭제 함수
  window.removeSubscription = async (playlistId, playlistUrl, playlistTitle) => {
    try {
      // 사용자 확인 (Electron dialog 사용)
      const result = await window.eagle.dialog.showMessageBox({
        type: 'question',
        buttons: ['플레이리스트만 삭제', '영상 기록도 함께 삭제', '취소'],
        defaultId: 0, // 기본값: 플레이리스트만 삭제
        title: '구독 삭제 확인',
        message: `'${playlistTitle || playlistUrl}' 구독을 삭제하시겠습니까?`,
        detail: '이 플레이리스트에 속한 영상 기록들을 DB에서 함께 삭제할지 선택해주세요.'
      });

      const response = result.response;

      if (response === 2) { // 취소
        uiController.updateStatusUI("구독 삭제 취소됨");
        return;
      }

      const deleteVideos = (response === 1); // '영상 기록도 함께 삭제' 선택 시 true

      await subscriptionManager.removeSubscription(playlistId, deleteVideos);
      const subscriptions = await subscriptionManager.loadSubscriptions();
      uiController.updateSubscriptionListUI(subscriptions);
      uiController.updateStatusUI(`구독 삭제 완료: ${playlistTitle || playlistUrl} (영상 함께 삭제: ${deleteVideos})`);
    } catch (error) {
      console.error("Failed to remove subscription:", error);
      uiController.showError(error.message);
    }
  };

  // 구독 목록 불러오기 함수
  window.loadSubscriptions = async () => {
    const subscriptions = await subscriptionManager.loadSubscriptions();
    uiController.updateSubscriptionListUI(subscriptions);
    return subscriptionManager.subscriptions;
  };

  // 구독 확인 기능
  window.checkAllSubscriptions = async () => {
    // NIC 선택 값 읽기
    const sourceAddress = document.getElementById('sourceAddressSelect').value || '';
    // 차단 우회 옵션 읽기
    const randomUa = document.getElementById('randomUaChk')?.checked || false;
    const cookieFile = document.getElementById('cookieFileInput')?.value || '';
    const multiNic = document.getElementById('multiNicChk')?.checked || false;
    // 스레드별 NIC & 쿠키 배열
    let threadNics = [], threadCookies = [];
    const concurrency = parseInt(document.getElementById('concurrentPlaylists').value) || 1;
    if (multiNic) {
      for (let i = 1; i <= concurrency; i++) {
        threadNics.push(document.getElementById(`threadNicSel${i}`)?.value || '');
        threadCookies.push(document.getElementById(`threadCookieInput${i}`)?.value || '');
      }
    } else {
      threadNics = Array(concurrency).fill(sourceAddress);
      threadCookies = Array(concurrency).fill(cookieFile);
    }
    console.log('Using sourceAddress:', sourceAddress);
    try {
      // 설정 값 읽기
      const metadataBatchSize = parseInt(document.getElementById('metadataBatchSize').value) || 30;
      const downloadBatchSize = parseInt(document.getElementById('downloadBatchSize').value) || 5;
      const concurrencyVal = concurrency;
      const rateLimit = parseInt(document.getElementById('rateLimit').value) || 0;
      
      // 설정 값 로그
      console.log("구독 확인 옵션:", {
        metadataBatchSize,
        downloadBatchSize,
        concurrency: concurrencyVal,
        rateLimit,
        randomUa,
        threadNics,
        threadCookies
      });
      
      // 진행 상황 표시 업데이트
      document.getElementById("downloadProgress").classList.remove("hidden");
      
      // 프로그레스 콜백 함수
      const wrappedCallback = (current, total, task) => {
        uiController.updateProgressUI(current, total, task);
      };
      
      // 구독 확인 실행
      await subscriptionManager.checkAllSubscriptions(wrappedCallback, {
        concurrency: concurrencyVal,
        metadataBatchSize,
        downloadBatchSize,
        rateLimit,
        randomUa,
        threadNics,
        threadCookies
      });
      
      // 진행 상황 표시 숨김
      document.getElementById("downloadProgress").classList.add("hidden");
    } catch (error) {
      console.error("Failed to check subscriptions:", error);
      uiController.showError(`Failed to check subscriptions: ${error.message}`);
      document.getElementById("downloadProgress").classList.add("hidden");
    }
  };

  // 자동 체크 시작
  window.startAutoCheck = async (intervalMinutes) => {
    try {
      // 현재 설정 값으로 자동 체크 시작
      const metadataBatchSize = parseInt(document.getElementById('metadataBatchSize').value) || 30;
      const downloadBatchSize = parseInt(document.getElementById('downloadBatchSize').value) || 5;
      const concurrency = parseInt(document.getElementById('concurrentPlaylists').value) || 3;
      const rateLimit = parseInt(document.getElementById('rateLimit').value) || 0;
      
      // 자동 체크 시작
    subscriptionManager.startAutoCheck(intervalMinutes);
      
      // 버튼 상태 업데이트
    uiController.updateAutoCheckButtonsState(true);
      uiController.updateStatusUI(`자동 확인 시작됨 (${intervalMinutes}분 간격)`);
    } catch (error) {
      console.error("Failed to start auto check:", error);
      uiController.showError(`Failed to start auto check: ${error.message}`);
    }
  };

  // 자동 체크 중지
  window.stopAutoCheck = () => {
    try {
    subscriptionManager.stopAutoCheck();
    uiController.updateAutoCheckButtonsState(false);
      uiController.updateStatusUI("자동 확인 중지됨");
    } catch (error) {
      console.error("Failed to stop auto check:", error);
      uiController.showError(`Failed to stop auto check: ${error.message}`);
    }
  };

  // 유지 관리 관련 함수 등록
  
  // 중복 검사 실행
  window.checkDuplicates = async () => {
    try {
      uiController.updateMaintenanceUI("중복 검사를 시작합니다...", 0, true);
      
      // 상태 업데이트 이벤트 리스너
      libraryMaintenance.on('statusUpdate', (message) => {
        uiController.updateMaintenanceUI(message, 50);
        uiController.appendLog(message);
      });
      
      // 작업 완료 이벤트 리스너
      libraryMaintenance.once('checkComplete', () => {
        uiController.updateMaintenanceUI("중복 검사가 완료되었습니다.", 100, false);
        libraryMaintenance.removeAllListeners('statusUpdate');
      });
      
      // 중복 검사 실행
      const report = await libraryMaintenance.checkDuplicates();
      console.log("중복 검사 완료:", report);
    } catch (error) {
      console.error("중복 검사 실패:", error);
      uiController.showError(`중복 검사 실패: ${error.message}`);
      uiController.updateMaintenanceUI("오류 발생", 0, false);
      libraryMaintenance.removeAllListeners();
    }
  };
  
  // 일치성 검사 실행
  window.checkConsistency = async () => {
    try {
      uiController.updateMaintenanceUI("일치성 검사를 시작합니다...", 0, true);
      
      // 상태 업데이트 이벤트 리스너
      libraryMaintenance.on('statusUpdate', (message) => {
        uiController.updateMaintenanceUI(message, 50);
        uiController.appendLog(message);
      });
      
      // 작업 완료 이벤트 리스너
      libraryMaintenance.once('checkComplete', () => {
        uiController.updateMaintenanceUI("일치성 검사가 완료되었습니다.", 100, false);
        libraryMaintenance.removeAllListeners('statusUpdate');
      });
      
      // 일치성 검사 실행
      const report = await libraryMaintenance.checkConsistency();
      console.log("일치성 검사 완료:", report);
    } catch (error) {
      console.error("일치성 검사 실패:", error);
      uiController.showError(`일치성 검사 실패: ${error.message}`);
      uiController.updateMaintenanceUI("오류 발생", 0, false);
      libraryMaintenance.removeAllListeners();
    }
  };
  
  // 불일치 항목 수정
  window.fixInconsistencies = async () => {
    try {
      uiController.updateMaintenanceUI("불일치 항목 수정을 시작합니다...", 0, true);
      
      // 상태 업데이트 이벤트 리스너
      libraryMaintenance.on('statusUpdate', (message) => {
        uiController.updateMaintenanceUI(message, 50);
        uiController.appendLog(message);
      });
      
      // 작업 완료 이벤트 리스너
      libraryMaintenance.once('fixComplete', () => {
        uiController.updateMaintenanceUI("불일치 항목 수정이 완료되었습니다.", 100, false);
        libraryMaintenance.removeAllListeners('statusUpdate');
      });
      
      // 불일치 항목 수정 실행
      const report = await libraryMaintenance.fixInconsistencies('db');
      console.log("불일치 항목 수정 완료:", report);
    } catch (error) {
      console.error("불일치 항목 수정 실패:", error);
      uiController.showError(`불일치 항목 수정 실패: ${error.message}`);
      uiController.updateMaintenanceUI("오류 발생", 0, false);
      libraryMaintenance.removeAllListeners();
    }
  };
  
  // 유지 관리 취소
  window.cancelMaintenance = () => {
    try {
      libraryMaintenance.isRunning = false;
      uiController.updateMaintenanceUI("작업이 취소되었습니다.", 0, false);
      libraryMaintenance.removeAllListeners();
      console.log("유지 관리 작업 취소됨");
    } catch (error) {
      console.error("작업 취소 실패:", error);
    }
  };
  
  // 중복 보고서 보기
  window.viewDuplicateReport = async () => {
    try {
      const fs = require('fs').promises;
      const reportPath = path.join(plugin.path, "duplicate-check-report.json");
      
      try {
        const content = await fs.readFile(reportPath, 'utf8');
        const report = JSON.parse(content);
        uiController.showReportDialog("중복 검사 보고서", report);
      } catch (error) {
        console.error("보고서 로드 실패:", error);
        uiController.showError("보고서가 아직 생성되지 않았습니다.");
      }
    } catch (error) {
      console.error("보고서 보기 실패:", error);
      uiController.showError(`보고서 보기 실패: ${error.message}`);
    }
  };
  
  // 일치성 보고서 보기
  window.viewConsistencyReport = async () => {
    try {
      const fs = require('fs').promises;
      const reportPath = path.join(plugin.path, "consistency-check-report.json");
      
      try {
        const content = await fs.readFile(reportPath, 'utf8');
        const report = JSON.parse(content);
        uiController.showReportDialog("일치성 검사 보고서", report);
      } catch (error) {
        console.error("보고서 로드 실패:", error);
        uiController.showError("보고서가 아직 생성되지 않았습니다.");
      }
    } catch (error) {
      console.error("보고서 보기 실패:", error);
      uiController.showError(`보고서 보기 실패: ${error.message}`);
    }
  };

  // UI 초기화 함수
  function initializeUI() {
    console.log("[EagleIVD] initializeUI called.");
    
    // 설정 로드는 컨트롤러 로드와 독립적으로 먼저 수행될 수 있음
    settings.loadSettings().then(async loadedSettings => {
        console.log("[EagleIVD] Settings loaded in initializeUI.");
        // 여기에 로드된 설정을 UI에 적용하는 로직 (예: document.getElementById(...).value = loadedSettings.xyz)
        // 예시: const prefixChk = document.getElementById('prefixUploadDateChk'); if (prefixChk) prefixChk.checked = loadedSettings.prefixUploadDate;
    }).catch(err => {
        console.error('[EagleIVD] Failed to load settings in initializeUI:', err);
        const statusArea = document.getElementById('statusArea');
        if (statusArea) statusArea.textContent = "설정 로드 실패: " + err.message;
    });

    // 컨트롤러 로드 (plugin.path 기준 절대 경로)
    const basePath = plugin.path;
    const ctrlDir = path.join(basePath, 'js', 'controllers');
    console.log('[EagleIVD] Loading controllers from:', ctrlDir);
    const settingsController = require(path.join(ctrlDir, 'settings-controller.js'));
    const tabController = require(path.join(ctrlDir, 'tab-controller.js'));
    const downloadController = require(path.join(ctrlDir, 'download-controller.js'));
    const subscriptionController = require(path.join(ctrlDir, 'subscription-controller.js'));
    const previewController = require(path.join(ctrlDir, 'preview-controller.js'));
    const maintenanceController = require(path.join(ctrlDir, 'maintenance-controller.js'));
     
    console.log("[EagleIVD] Controllers potentially loaded.");

    // 컨트롤러 초기화 및 이벤트 바인딩
    // subscriptionManager, uiController 등은 이 시점 이전에 초기화되어 있어야 함
    settingsController.initSettingsUI(subscriptionManager);
    settingsController.bindSaveSettings();
    settingsController.bindSettingsUI();
    tabController.bindTabs();
    downloadController.bindEvents(downloadManager, uiController);
    subscriptionController.bindSubscriptionUI(subscriptionManager, uiController);
    previewController.bindPreviewUI();
    maintenanceController.bindMaintenanceUI();
    
    // 초기 탭 설정
    uiController.showTab('singleTab');
    // 초기 구독 목록 자동 로드
    if (typeof window.loadSubscriptions === 'function') {
      window.loadSubscriptions().catch(e => console.error('Initial loadSubscriptions failed:', e));
    }
    console.log("[EagleIVD] initializeUI complete.");
  }

  // initializeUI 호출
  initializeUI();
});

// Eagle 플러그인 엔트리 포인트: plugin 객체를 통해 초기화
module.exports = (plugin) => {
  console.log('[EagleIVD] Plugin initialized. Path:', plugin.path);
  plugin.on('run', () => {
    console.log('[EagleIVD] onPluginRun: initializing UI and subscriptions');
    initializeUI();
    if (typeof window.loadSubscriptions === 'function') {
      window.loadSubscriptions().then(subs => console.log(`Loaded ${subs.length} subscriptions`)).catch(e => console.error('Failed to load subscriptions:', e));
    }
  });
};
