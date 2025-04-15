/**
 * UI 컨트롤러 모듈
 * 사용자 인터페이스 관련 함수들
 */

/**
 * UI 상태 업데이트
 * @param {string} message - 상태 메시지
 */
function updateStatusUI(message) {
  console.log("Status update:", message);
  // 상태 업데이트를 직접 처리합니다 (순환 호출 방지)
  const statusArea = document.getElementById("statusArea");
  if (statusArea) {
    statusArea.textContent = message;
  }
}

/**
 * 명령어 미리보기 업데이트
 * @param {string} command - 명령어 문자열
 */
function updateCommandPreview(command) {
  console.log("Command preview:", command);
  // 직접 DOM 요소 업데이트 (순환 호출 방지)
  const commandPreview = document.getElementById("commandPreview");
  const commandPreviewArea = document.getElementById("commandPreviewArea");
  
  if (commandPreview) {
    commandPreview.textContent = command;
  }
  
  if (commandPreviewArea) {
    commandPreviewArea.classList.remove("hidden");
  }
}

/**
 * 구독 목록 UI 업데이트
 * @param {Array<Object>} subscriptions - 구독 목록
 */
function updateSubscriptionListUI(subscriptions) {
  const subscriptionList = document.getElementById("subscriptionList");
  if (!subscriptionList) return;
  
  // 기존 목록 비우기
  subscriptionList.innerHTML = "";

  // 구독이 없는 경우 메시지 표시
  if (subscriptions.length === 0) {
    subscriptionList.innerHTML = '<div class="p-3 text-gray-500 text-center">No subscriptions yet</div>';
    return;
  }

  // 각 구독 항목 추가
  subscriptions.forEach((subscription) => {
    const listItem = document.createElement("div");
    listItem.className = "subscription-item p-3 border-b";
    
    // 채널 또는 플레이리스트 아이콘
    const iconType = subscription.isChannel ? 'user' : 'list';
    
    listItem.innerHTML = `
      <div class="flex items-center">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="${iconType === 'user' 
            ? 'M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z'
            : 'M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z'}" 
            clip-rule="evenodd" />
        </svg>
        <div class="font-semibold">${
          subscription.title || "Untitled Playlist"
        }</div>
      </div>
      <div class="text-sm text-gray-500 mt-1">
        URL: ${subscription.url}
      </div>
      <div class="text-sm text-gray-500">
        Folder: ${
          subscription.folderName || "Default"
        } | Format: ${subscription.format} ${
          subscription.quality || ""
        }
      </div>
      <div class="text-sm text-gray-500">
        Last Check: ${subscription.lastCheck ? 
          new Date(subscription.lastCheck).toLocaleString() : 
          'Never checked'}
      </div>
      <button class="delete-sub bg-red-100 text-red-700 px-2 py-1 rounded mt-2" 
        data-url="${subscription.url}">Delete</button>
    `;
    subscriptionList.appendChild(listItem);
  });
  
  // 삭제 버튼에 이벤트 리스너 추가
  document.querySelectorAll('.delete-sub').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = e.target.getAttribute('data-url');
      if (window.removeSubscription && url) {
        window.removeSubscription(url);
      }
    });
  });
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
  updateAutoCheckButtonsState
}; 