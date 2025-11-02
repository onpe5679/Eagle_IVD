/**
 * UI 컨트롤러 모듈
 * 사용자 인터페이스 관련 함수들
 */

// 대량 처리 최적화를 위한 전역 변수들
let uiScrollTimeout = null;
let uiLogQueue = [];
let uiLogTimeout = null;

/**
 * 상태 메시지 업데이트 (대량 처리 최적화)
 * @param {string} message - 표시할 메시지
 * @param {boolean} append - 기존 메시지에 추가할지 여부
 */
function updateStatusUI(message, append = false) {
  console.log("Status update:", message);
  
  const statusArea = document.getElementById("statusArea");
  if (statusArea) {
    if (append) {
      statusArea.textContent += "\n" + message;
    } else {
      statusArea.textContent = message;
    }
    
    // 대량 처리 시 스크롤 최적화 (debounce)
    if (!uiScrollTimeout) {
      uiScrollTimeout = setTimeout(() => {
        statusArea.scrollTop = statusArea.scrollHeight;
        uiScrollTimeout = null;
      }, 100); // 100ms 간격으로 스크롤 업데이트
    }
  }
  
  // 대량 로그 시 성능 최적화
  uiLogQueue.push(message);
  
  if (!uiLogTimeout) {
    uiLogTimeout = setTimeout(() => {
      // 최대 50개까지만 유지 (성능 보호)
      const logsToProcess = uiLogQueue.splice(0, 50);
      logsToProcess.forEach(msg => appendLog(msg));
      uiLogTimeout = null;
      
      // 남은 로그가 있으면 계속 처리
      if (uiLogQueue.length > 0) {
        updateStatusUI('', false);
      }
    }, 50); // 50ms 배치 처리
  }
}

/**
 * 구독 목록 UI 업데이트
 * @param {Array<Object>} subscriptions - 구독 목록
 */
function updateSubscriptionListUI(subscriptions) {
  const subscriptionList = document.getElementById("subscriptionList");
  if (!subscriptionList) return;
  
  subscriptionList.innerHTML = "";

  if (subscriptions.length === 0) {
    subscriptionList.innerHTML = '<div class="p-3 text-gray-500 text-center">No subscriptions yet</div>';
    return;
  }

  subscriptions.forEach((subscription) => {
    const listItem = document.createElement("div");
    listItem.className = "subscription-item p-3 border-b";
    
    // DB에서 가져온 제목 사용 (user_title 우선, 없으면 youtube_title)
    const displayTitle = subscription.user_title || subscription.youtube_title || "Untitled Playlist";
    // 폴더 이름도 user_title 기준으로 설정 (없으면 youtube_title, 그것도 없으면 "Default")
    const folderDisplayName = subscription.user_title || subscription.youtube_title || "Default";
    // 마지막 확인 시간 포맷팅
    const lastCheckFormatted = subscription.last_checked
      ? new Date(subscription.last_checked).toLocaleString()
      : 'Never checked';
    // 채널 아이콘 결정 (url 기반으로 간단히) + ID 저장
    const playlistId = subscription.id; // DB의 id 값
    const playlistUrl = subscription.url;
    const isChannel = playlistUrl.includes('/channel/') || playlistUrl.includes('/c/') || playlistUrl.includes('/user/') || playlistUrl.includes('@');
    const iconType = isChannel ? 'user' : 'list';

    listItem.innerHTML = `
      <div class="flex items-center">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="${
            iconType === 'user'
              ? 'M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z'
              : 'M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z'
          }" clip-rule="evenodd" />
        </svg>
        <div class="font-semibold">${displayTitle}</div>
      </div>
      <div class="text-sm text-gray-500 mt-1">
        URL: ${subscription.url}
      </div>
      <div class="text-sm text-gray-500">
        Folder: ${folderDisplayName} | Format: ${subscription.format || 'best'} ${subscription.quality || ''}
      </div>
      <div class="text-sm text-gray-500">
        Videos: ${subscription.videos ?? 'N/A'} / ${subscription.videos_from_yt ?? 'N/A'}
      </div>
      <div class="text-sm text-gray-500">
        Last Check: ${lastCheckFormatted}
      </div>
      <button class="delete-sub bg-red-100 text-red-700 px-2 py-1 rounded mt-2 text-sm"
              data-id="${playlistId}"
              data-url="${playlistUrl}"
              data-title="${displayTitle}">Delete</button>
    `;
    subscriptionList.appendChild(listItem);
  });

  document.querySelectorAll('.delete-sub').forEach(btn => {
    btn.removeEventListener('click', handleDeleteSubscription); // 기존 리스너 제거
    btn.addEventListener('click', handleDeleteSubscription); // 새 리스너 추가
  });
}

// 삭제 버튼 클릭 핸들러 (함수로 분리)
function handleDeleteSubscription(e) {
  const button = e.target;
  const playlistId = button.getAttribute('data-id');
  const playlistUrl = button.getAttribute('data-url');
  const playlistTitle = button.getAttribute('data-title');

  // playlistId를 숫자로 변환 시도
  const idNum = parseInt(playlistId, 10);

  if (window.removeSubscription && !isNaN(idNum) && playlistUrl) {
    // 확인 로직은 main.js의 removeSubscription 함수 내부로 이동했으므로 여기서는 바로 호출
    window.removeSubscription(idNum, playlistUrl, playlistTitle);
  } else {
    console.error("Could not remove subscription: Missing data", { playlistId, playlistUrl, playlistTitle });
    alert("Failed to get subscription details for removal.");
  }
}

/**
 * 진행 상황 표시 업데이트
 * @param {number} current - 현재 항목
 * @param {number} total - 전체 항목
 * @param {string} task - 현재 작업 설명
 */
function updateProgressUI(current, total, task) {
  const progressContainer = document.getElementById("downloadProgress");
  const currentTask = document.getElementById("currentTask");
  const progressBar = document.getElementById("progressBar");
  
  if (!progressContainer || !currentTask || !progressBar) return;
  
  // 진행 상황 컨테이너 표시
  progressContainer.classList.remove("hidden");
  
  // 작업 설명 업데이트
  currentTask.textContent = task;
  
  // 진행 막대 업데이트
  const progress = (current / total) * 100;
  progressBar.style.width = `${progress}%`;
}

/**
 * 다운로드 버튼 상태 관리
 * @param {HTMLElement} startBtn - 시작 버튼
 * @param {HTMLElement} cancelBtn - 취소 버튼
 * @param {boolean} isStarting - 시작 여부
 */
function handleDownloadButtonsState(startBtn, cancelBtn, isStarting) {
  if (!startBtn || !cancelBtn) return;
  
  startBtn.disabled = isStarting;
  startBtn.classList.toggle('opacity-50', isStarting);
  
  if (isStarting) {
    cancelBtn.classList.remove('hidden');
  } else {
    cancelBtn.classList.add('hidden');
  }
}

/**
 * YouTube 썸네일 및 제목 업데이트
 * @param {string} thumbnailUrl - 썸네일 URL
 * @param {string} title - 비디오 제목
 */
function updateYoutubePreviewUI(thumbnailUrl, title) {
  const youtubeThumb = document.getElementById("youtube-thumb");
  const youtubeTitle = document.getElementById("youtube-title");
  const youtubePreview = document.getElementById("youtube-preview");

  console.log("YouTube 미리보기 업데이트:", { thumbnailUrl, title });
  
  if (!youtubeThumb || !youtubeTitle || !youtubePreview) {
    console.error("YouTube 미리보기 요소를 찾을 수 없음");
    return;
  }

  if (thumbnailUrl && youtubeThumb) {
    youtubeThumb.src = thumbnailUrl;
    youtubeThumb.style.display = "block";
    console.log("썸네일 설정:", thumbnailUrl);
  }

  if (title && youtubeTitle) {
    youtubeTitle.textContent = title;
    console.log("제목 설정:", title);
  }
  
  // 플레이리스트인 경우 해당 미리보기도 업데이트
  const isPlaylist = title && title.includes("Playlist");
  const playlistPreview = document.getElementById("playlist-preview");
  
  if (isPlaylist && playlistPreview && thumbnailUrl) {
    const playlistThumb = document.getElementById("playlist-thumb");
    const playlistTitle = document.getElementById("playlist-title");
    
    if (playlistThumb) playlistThumb.src = thumbnailUrl;
    if (playlistTitle) playlistTitle.textContent = title;
    
    playlistPreview.style.display = "flex";
  }
}

/**
 * 명령어 미리보기 업데이트
 * @param {string} command - 표시할 명령어
 */
function updateCommandPreview(command) {
  console.log("Command preview:", command);
  
  const commandPreview = document.getElementById("commandPreview");
  const commandPreviewArea = document.getElementById("commandPreviewArea");
  
  if (commandPreview) {
    commandPreview.textContent = command;
  }
  
  if (commandPreviewArea) {
    commandPreviewArea.classList.remove("hidden");
  }
  
  // 로그에도 추가
  appendLog(`[CMD] ${command}`);
}

/**
 * 로그 메시지 추가
 * @param {string} message - 로그 메시지
 */
function appendLog(message) {
  const logsDiv = document.getElementById("logs");
  if (!logsDiv) return;
  
  const div = document.createElement("div");
  div.textContent = message;
  logsDiv.appendChild(div);
  logsDiv.scrollTop = logsDiv.scrollHeight;
}

/**
 * 탭 전환
 * @param {string} targetId - 대상 탭 ID
 */
function showTab(targetId) {
  const tabs = document.querySelectorAll('.tab-button');
  const tabContents = document.querySelectorAll('.tab-content');

  tabs.forEach(t => t.classList.remove('font-bold'));
  tabContents.forEach(tc => tc.classList.add('hidden'));

  const btn = Array.from(tabs).find(b => b.dataset.target === targetId);
  if (btn) btn.classList.add('font-bold');
  
  const content = document.getElementById(targetId);
  if (content) content.classList.remove('hidden');
}

/**
 * 오류 메시지 표시
 * @param {string} message - 오류 메시지
 */
function showError(message) {
  updateStatusUI(`Error: ${message}`);
  appendLog(`Error: ${message}`);
}

/**
 * 자동 체크 버튼 상태 업데이트
 * @param {boolean} isRunning - 자동 체크 실행 중 여부
 */
function updateAutoCheckButtonsState(isRunning) {
  const startAutoCheckBtn = document.getElementById("startAutoCheckBtn");
  const stopAutoCheckBtn = document.getElementById("stopAutoCheckBtn");
  
  if (!startAutoCheckBtn || !stopAutoCheckBtn) return;
  
  if (isRunning) {
    startAutoCheckBtn.classList.add('hidden');
    stopAutoCheckBtn.classList.remove('hidden');
  } else {
    startAutoCheckBtn.classList.remove('hidden');
    stopAutoCheckBtn.classList.add('hidden');
  }
}

/**
 * 유지 관리 진행 상태 업데이트
 * @param {string} status - 상태 메시지
 * @param {number} progress - 진행률 (0-100)
 * @param {boolean} isRunning - 실행 중 여부
 */
function updateMaintenanceUI(status, progress = 0, isRunning = true) {
  const maintenanceProgress = document.getElementById("maintenanceProgress");
  const maintenanceStatus = document.getElementById("maintenanceStatus");
  const maintenanceProgressBar = document.getElementById("maintenanceProgressBar");
  const cancelMaintenanceBtn = document.getElementById("cancelMaintenanceBtn");
  
  if (!maintenanceProgress || !maintenanceStatus || !maintenanceProgressBar) return;
  
  if (isRunning) {
    maintenanceProgress.classList.remove("hidden");
    maintenanceStatus.textContent = status;
    maintenanceProgressBar.style.width = `${progress}%`;
    
    // 버튼 비활성화
    document.getElementById("checkDuplicatesBtn")?.setAttribute("disabled", "disabled");
    document.getElementById("checkConsistencyBtn")?.setAttribute("disabled", "disabled");
    document.getElementById("fixInconsistenciesBtn")?.setAttribute("disabled", "disabled");
    
    // 취소 버튼 활성화
    if (cancelMaintenanceBtn) {
      cancelMaintenanceBtn.classList.remove("hidden");
    }
  } else {
    maintenanceProgress.classList.add("hidden");
    
    // 버튼 활성화
    document.getElementById("checkDuplicatesBtn")?.removeAttribute("disabled");
    document.getElementById("checkConsistencyBtn")?.removeAttribute("disabled");
    document.getElementById("fixInconsistenciesBtn")?.removeAttribute("disabled");
    
    // 취소 버튼 비활성화
    if (cancelMaintenanceBtn) {
      cancelMaintenanceBtn.classList.add("hidden");
    }
  }
}

/**
 * 보고서 보기 대화상자 표시
 * @param {string} title - 대화상자 제목
 * @param {object} report - 보고서 객체
 */
function showReportDialog(title, report) {
  // 기존 대화상자 제거
  const existingDialog = document.getElementById("reportDialog");
  if (existingDialog) {
    existingDialog.remove();
  }
  
  // 새 대화상자 생성
  const dialog = document.createElement("div");
  dialog.id = "reportDialog";
  dialog.className = "fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50";
  
  const content = document.createElement("div");
  content.className = "bg-white rounded-lg shadow-xl p-6 max-w-2xl w-full max-h-[80vh] overflow-auto";
  
  content.innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <h3 class="text-xl font-bold">${title}</h3>
      <button id="closeReportBtn" class="text-gray-500 hover:text-gray-700">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
    <div class="border rounded p-4 bg-gray-50 mb-4">
      <pre class="text-sm whitespace-pre-wrap">${JSON.stringify(report, null, 2)}</pre>
    </div>
    <div class="text-right">
      <button id="closeReportBtn2" class="bg-blue-500 text-white px-4 py-2 rounded">닫기</button>
    </div>
  `;
  
  dialog.appendChild(content);
  document.body.appendChild(dialog);
  
  // 닫기 버튼 이벤트 리스너
  document.getElementById("closeReportBtn").addEventListener("click", () => {
    dialog.remove();
  });
  
  document.getElementById("closeReportBtn2").addEventListener("click", () => {
    dialog.remove();
  });
}

// 모듈 내보내기
module.exports = {
  updateStatusUI,
  updateCommandPreview,
  updateSubscriptionListUI,
  updateProgressUI,
  handleDownloadButtonsState,
  updateYoutubePreviewUI,
  appendLog,
  showTab,
  showError,
  updateAutoCheckButtonsState,
  updateMaintenanceUI,
  showReportDialog
};
