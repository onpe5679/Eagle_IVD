/**
 * 메인 모듈
 * 모든 모듈을 통합하고 플러그인 초기화 및 이벤트 핸들링
 */

// Eagle 플러그인 환경에서 사용 가능한 모듈 로딩 방식
let DownloadManager, EnhancedSubscriptionManager, LibraryMaintenance, eagleApi, utils, uiController;

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
  
  // 단일 비디오 다운로드 함수
  window.handleDownload = async (
    url,
    format,
    quality,
    speedLimit,
    concurrency
  ) => {
    try {
      console.log("Handling download for single URL:", url);
      const metadata = await downloadManager.getMetadata(url);
      console.log("Metadata fetched:", metadata);

      await downloadManager.startDownload(
        url,
        format,
        quality,
        speedLimit,
        concurrency
      );
      console.log("Download complete!");
      uiController.updateStatusUI("Download complete!");

      await subscriptionManager.importAndRemoveDownloadedFiles(
        downloadManager.downloadFolder,
        url,
        metadata
      );
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
    console.log('Using sourceAddress:', sourceAddress);
    try {
      // 설정 값 읽기
      const metadataBatchSize = parseInt(document.getElementById('metadataBatchSize').value) || 30;
      const downloadBatchSize = parseInt(document.getElementById('downloadBatchSize').value) || 5;
      const concurrency = parseInt(document.getElementById('concurrentPlaylists').value) || 3;
      const rateLimit = parseInt(document.getElementById('rateLimit').value) || 0;
      
      // 설정 값 로그
      console.log("구독 확인 옵션:", {
        metadataBatchSize,
        downloadBatchSize,
        concurrency,
        rateLimit
      });
      
      // 진행 상황 표시 업데이트
      document.getElementById("downloadProgress").classList.remove("hidden");
      
      // 프로그레스 콜백 함수
      const wrappedCallback = (current, total, task) => {
        uiController.updateProgressUI(current, total, task);
      };
      
      // 구독 확인 실행
      await subscriptionManager.checkAllSubscriptions(wrappedCallback, {
        concurrency,
        metadataBatchSize,
        downloadBatchSize,
        rateLimit,
        sourceAddress
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
      const path = require('path');
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
      const path = require('path');
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
    console.log("UI 초기화 시작");
    
    // 탭 관리
    const tabs = document.querySelectorAll('.tab-button');
    console.log("탭 요소 찾음:", tabs.length);
    
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        console.log("탭 클릭됨:", tab.dataset.target);
        uiController.showTab(tab.dataset.target);
      });
    });
    
    // 초기 탭 설정
    uiController.showTab('singleTab');
    console.log("초기 탭 설정됨");

    // 다운로드 버튼 이벤트 리스너
    const downloadBtn = document.getElementById('downloadBtn');
    if (downloadBtn) {
      console.log("다운로드 버튼 찾음");
      downloadBtn.addEventListener('click', () => {
        // 중복 요청 방지
        if (downloadBtn.disabled) {
          console.log("다운로드가 이미 진행 중입니다.");
          return;
        }
        
        // 버튼 비활성화
        downloadBtn.disabled = true;
        downloadBtn.classList.add('opacity-50');
        
        // 취소 버튼 표시
        const cancelBtn = document.getElementById('cancelBtn');
        if (cancelBtn) {
          cancelBtn.classList.remove('hidden');
        }

        const url = document.getElementById('singleUrl').value;
        const format = document.getElementById('formatSelect').value;
        const quality = document.getElementById('qualitySelect').value;
        const speedLimit = document.getElementById('speedLimitInput').value;
        const concurrency = document.getElementById('concurrencyInput').value;
        
        console.log("다운로드 버튼 클릭됨, URL:", url);
        window.handleDownload(url, format, quality, speedLimit, concurrency)
          .then(() => {
            console.log("다운로드 완료");
            // 버튼 상태 복원
            downloadBtn.disabled = false;
            downloadBtn.classList.remove('opacity-50');
            
            // 취소 버튼 숨김
            if (cancelBtn) {
              cancelBtn.classList.add('hidden');
            }
          })
          .catch(error => {
            console.error("다운로드 실패:", error);
            // 버튼 상태 복원
            downloadBtn.disabled = false;
            downloadBtn.classList.remove('opacity-50');
            
            // 취소 버튼 숨김
            if (cancelBtn) {
              cancelBtn.classList.add('hidden');
            }
          });
      });
    } else {
      console.error("다운로드 버튼을 찾을 수 없음");
    }

    // 플레이리스트 다운로드 버튼 이벤트 리스너
    const playlistBtn = document.getElementById('downloadPlaylistBtn');
    if (playlistBtn) {
      console.log("플레이리스트 버튼 찾음");
      playlistBtn.addEventListener('click', () => {
        const url = document.getElementById('playlistUrl').value;
        const format = document.getElementById('playlistFormat').value;
        const quality = document.getElementById('playlistQuality').value;
        const speedLimit = document.getElementById('playlistSpeedLimit').value;
        const concurrency = document.getElementById('playlistConcurrency').value;
        
        console.log("플레이리스트 버튼 클릭됨, URL:", url);
        window.handleDownloadPlaylist(url, format, quality, speedLimit, concurrency);
      });
    }

    // 구독 관련 버튼 이벤트 리스너
    const addSubscriptionBtn = document.getElementById('addSubscriptionBtn');
    if (addSubscriptionBtn) {
      console.log("구독 추가 버튼 찾음");
      addSubscriptionBtn.addEventListener('click', () => {
        console.log("구독 추가 버튼 클릭됨");
        
        const subType = document.querySelector('input[name="subType"]:checked').value;
        const url = document.getElementById('newSubUrl').value;
        const folder = document.getElementById('newSubFolder').value;
        const format = document.getElementById('newSubFormat').value;
        const quality = document.getElementById('newSubQuality').value;
        
        console.log(`구독 추가: ${subType}, URL: ${url}`);
        
        const subscriptionData = {
          url: url,
          folder: folder,
          format: format,
          quality: quality
        };
        
        if (subType === 'channel') {
          window.addChannelSubscription(subscriptionData);
        } else {
          window.addSubscription(subscriptionData);
        }
      });
    } else {
      console.error("구독 추가 버튼을 찾을 수 없음");
    }
    
    // 새 비디오 확인 버튼
    const checkNewBtn = document.getElementById('checkNewBtn');
    if (checkNewBtn) {
      console.log("새 비디오 확인 버튼 찾음");
      checkNewBtn.addEventListener('click', () => {
        console.log("새 비디오 확인 버튼 클릭됨");
        window.checkAllSubscriptions();
      });
    }
    
    // 자동 확인 시작 버튼
    const startAutoCheckBtn = document.getElementById('startAutoCheckBtn');
    if (startAutoCheckBtn) {
      console.log("자동 확인 시작 버튼 찾음");
      startAutoCheckBtn.addEventListener('click', () => {
        console.log("자동 확인 시작 버튼 클릭됨");
        window.startAutoCheck(30); // 30분 간격으로 설정
      });
    }
    
    // 자동 확인 중지 버튼
    const stopAutoCheckBtn = document.getElementById('stopAutoCheckBtn');
    if (stopAutoCheckBtn) {
      console.log("자동 확인 중지 버튼 찾음");
      stopAutoCheckBtn.addEventListener('click', () => {
        console.log("자동 확인 중지 버튼 클릭됨");
        window.stopAutoCheck();
      });
    }
    
    // 취소 버튼들
    const cancelButtons = [
      document.getElementById('cancelBtn'),
      document.getElementById('cancelPlaylistBtn'),
      document.getElementById('cancelSubscriptionBtn')
    ].filter(btn => btn !== null);
    
    console.log(`${cancelButtons.length}개의 취소 버튼 찾음`);
    
    cancelButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        console.log("취소 버튼 클릭됨");
        window.cancelDownload();
      });
    });

    // 클립보드 붙여넣기 기능
    document.querySelectorAll('.paste-button').forEach(button => {
      console.log("붙여넣기 버튼 찾음");
      button.addEventListener('click', async () => {
        try {
          console.log("붙여넣기 버튼 클릭됨");
          const text = await navigator.clipboard.readText();
          const input = button.parentElement.querySelector('input');
          input.value = text;
          input.dispatchEvent(new Event('input')); // 입력 이벤트 발생
          console.log("클립보드 텍스트 붙여넣기 성공:", text);
        } catch (err) {
          console.error('Failed to read clipboard:', err);
          uiController.showError('Failed to read clipboard');
        }
      });
    });

    // YouTube URL 입력 시 자동 미리보기
    const singleUrlInput = document.getElementById('singleUrl');
    if (singleUrlInput) {
      console.log("URL 입력 필드 찾음");
      singleUrlInput.addEventListener('input', () => {
        const url = singleUrlInput.value.trim();
        if (url && url.includes('youtu')) {
          console.log("YouTube URL 입력됨:", url);
          
          // 디바운스 처리 (입력이 잠시 멈췄을 때만 API 호출)
          if (window.previewTimer) clearTimeout(window.previewTimer);
          window.previewTimer = setTimeout(() => {
            console.log("미리보기 가져오기 시도:", url);
            window.fetchYoutubePreview(url);
          }, 500);
        }
      });
    }
    
    // 플레이리스트 URL 입력 필드도 동일하게 처리
    const playlistUrlInput = document.getElementById('playlistUrl');
    if (playlistUrlInput) {
      playlistUrlInput.addEventListener('input', () => {
        const url = playlistUrlInput.value.trim();
        if (url && url.includes('youtu') && url.includes('list=')) {
          if (window.playlistPreviewTimer) clearTimeout(window.playlistPreviewTimer);
          window.playlistPreviewTimer = setTimeout(() => {
            window.fetchYoutubePreview(url);
          }, 500);
        }
      });
    }

    // 초기 구독 목록 로드
    window.loadSubscriptions().then(subscriptions => {
      console.log(`Loaded ${subscriptions.length} subscriptions`);
    }).catch(error => {
      console.error("Failed to load subscriptions in initializeUI:", error);
      uiController.showError("Failed to load subscriptions");
    });
    
    // 유지 관리 탭 버튼 이벤트 리스너
    
    // 중복 검사 버튼
    const checkDuplicatesBtn = document.getElementById('checkDuplicatesBtn');
    if (checkDuplicatesBtn) {
      console.log("중복 검사 버튼 찾음");
      checkDuplicatesBtn.addEventListener('click', () => {
        console.log("중복 검사 버튼 클릭됨");
        window.checkDuplicates();
      });
    } else {
      console.error("중복 검사 버튼을 찾을 수 없음");
    }
    
    // 일치성 검사 버튼
    const checkConsistencyBtn = document.getElementById('checkConsistencyBtn');
    if (checkConsistencyBtn) {
      console.log("일치성 검사 버튼 찾음");
      checkConsistencyBtn.addEventListener('click', () => {
        console.log("일치성 검사 버튼 클릭됨");
        window.checkConsistency();
      });
    } else {
      console.error("일치성 검사 버튼을 찾을 수 없음");
    }
    
    // 불일치 항목 수정 버튼
    const fixInconsistenciesBtn = document.getElementById('fixInconsistenciesBtn');
    if (fixInconsistenciesBtn) {
      console.log("불일치 항목 수정 버튼 찾음");
      fixInconsistenciesBtn.addEventListener('click', () => {
        console.log("불일치 항목 수정 버튼 클릭됨");
        window.fixInconsistencies();
      });
    } else {
      console.error("불일치 항목 수정 버튼을 찾을 수 없음");
    }

    // DB에서 불일치 항목 삭제 버튼
    const removeInconsistenciesBtn = document.getElementById('removeInconsistenciesBtn');
    if (removeInconsistenciesBtn) {
      console.log("DB에서 불일치 항목 삭제 버튼 찾음");
      removeInconsistenciesBtn.addEventListener('click', async () => {
        if (!confirm('정말로 DB에서 불일치 항목을 삭제하시겠습니까?')) {
          return;
        }
        await libraryMaintenance.removeInconsistenciesFromDB();
      });
    } else {
      console.error("DB에서 불일치 항목 삭제 버튼을 찾을 수 없음");
    }
    
    // 유지 관리 취소 버튼
    const cancelMaintenanceBtn = document.getElementById('cancelMaintenanceBtn');
    if (cancelMaintenanceBtn) {
      console.log("유지 관리 취소 버튼 찾음");
      cancelMaintenanceBtn.addEventListener('click', () => {
        console.log("유지 관리 취소 버튼 클릭됨");
        window.cancelMaintenance();
      });
    } else {
      console.error("유지 관리 취소 버튼을 찾을 수 없음");
    }
    
    // 보고서 보기 버튼
    const viewDuplicateReportBtn = document.getElementById('viewDuplicateReportBtn');
    if (viewDuplicateReportBtn) {
      console.log("중복 보고서 보기 버튼 찾음");
      viewDuplicateReportBtn.addEventListener('click', () => {
        console.log("중복 보고서 보기 버튼 클릭됨");
        window.viewDuplicateReport();
      });
    } else {
      console.error("중복 보고서 보기 버튼을 찾을 수 없음");
    }
    
    const viewConsistencyReportBtn = document.getElementById('viewConsistencyReportBtn');
    if (viewConsistencyReportBtn) {
      console.log("일치성 보고서 보기 버튼 찾음");
      viewConsistencyReportBtn.addEventListener('click', () => {
        console.log("일치성 보고서 보기 버튼 클릭됨");
        window.viewConsistencyReport();
      });
    } else {
      console.error("일치성 보고서 보기 버튼을 찾을 수 없음");
    }
    
    // NIC 목록 생성 및 옵션 추가
    try {
      const os = require('os');
      const nicSelect = document.getElementById('sourceAddressSelect');
      if (nicSelect) {
        const nets = os.networkInterfaces();
        Object.keys(nets).forEach(name => {
          nets[name].forEach(net => {
            if (net.family === 'IPv4' && !net.internal) {
              const option = document.createElement('option');
              option.value = net.address;
              option.textContent = `${name} (${net.address})`;
              nicSelect.appendChild(option);
              console.log('Added NIC option:', name, net.address);
            }
          });
        });
      }
    } catch (err) {
      console.error('NIC 목록 생성 실패:', err);
    }

    // 설정 탭: '제목 앞에 업로드날짜 붙이기' 체크박스 바인딩
    const prefixChk = document.getElementById('prefixUploadDateChk');
    if (prefixChk && typeof subscriptionManager !== 'undefined') {
      subscriptionManager.prefixUploadDate = prefixChk.checked;
      prefixChk.addEventListener('change', () => {
        subscriptionManager.prefixUploadDate = prefixChk.checked;
        console.log('설정 - 제목 앞에 업로드날짜 붙이기:', prefixChk.checked);
      });
    }
    
    console.log("UI 초기화 완료");
  }

  // DOM이 준비되면 UI 초기화
  document.addEventListener('DOMContentLoaded', () => {
    console.log("DOMContentLoaded 이벤트 발생");
    initializeUI();
  });
  
  // 페이지가 이미 로드되었는지 확인하고 즉시 UI 초기화
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    console.log("문서가 이미 로드됨, 즉시 UI 초기화");
    setTimeout(initializeUI, 100); // 약간의 지연을 두고 초기화
  }
});

// 플러그인 실행 이벤트
eagle.onPluginRun(() => {
  console.log("eagle.onPluginRun triggered");
  
  // 플러그인 실행 시 UI 초기화 및 구독 목록 로드
  setTimeout(() => {
    console.log("onPluginRun: UI 초기화 시도");
    if (typeof initializeUI === 'function') {
      initializeUI();
    }
    
    if (window.loadSubscriptions) {
      window.loadSubscriptions().then(subscriptions => {
        console.log(`Loaded ${subscriptions.length} subscriptions`);
      }).catch(error => {
        console.error("Failed to load subscriptions onPluginRun:", error);
      });
    }
  }, 500); // 충분한 로딩 시간 후 초기화
});

/**
 * 구독 삭제
 * @param {number} id - 구독 ID
 * @param {boolean} deleteVideos - 관련 영상도 함께 삭제할지 여부
 */
async function removeSubscription(id, deleteVideos = false) {
  try {
    await subscriptionManager.removeSubscription(id, deleteVideos);
    await loadSubscriptions();
  } catch (error) {
    console.error('Error removing subscription:', error);
  }
} 