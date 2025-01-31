// js/ui.js
import Downloader from './downloader.js'; // downloader.js 에서 Downloader 클래스 import

let downloader; // Downloader 인스턴스를 저장할 변수 (plugin.js 에서 초기화)

// UI 업데이트 함수 (plugin.js 에서 ui.js 로 옮겨옴)
window.updateUI = (message) => { // window.updateUI 로 export 하지 않고, ui.js 내부에서만 사용
    const statusArea = document.getElementById('statusArea');
    if (statusArea) {
        statusArea.textContent = message;
    }
};

// 명령어 프리뷰 업데이트 함수 (plugin.js 에서 ui.js 로 옮겨옴)
window.updateCommandPreview = (cmd) => { // window.updateCommandPreview 로 export 하지 않고, ui.js 내부에서만 사용
    const commandPreviewArea = document.getElementById('commandPreviewArea');
    const commandPreview = document.getElementById('commandPreview');
    if (commandPreviewArea && commandPreview) {
        commandPreviewArea.classList.remove('hidden');
        commandPreview.textContent = cmd;
    }
};

// 진행률 업데이트 함수 (downloader.js 에서 호출)
function updateProgress(output) {
    const match = output.match(
        /\[download\]\s+(\d+\.?\d*)%\s+of\s+([\d.]+[KMGT]?iB)\s+at\s+([\d.]+[KMGT]?iB\/s)\s+ETA\s+([\d:]+)/
    );
    if (match) {
        const progress = match[1];
        const fileSize = match[2];
        const speed = match[3];
        const eta = match[4];
        updateUI(`Progress: ${progress}%, Size: ${fileSize}, Speed: ${speed}, ETA: ${eta}`);
    } else {
        updateUI(output);
    }
}


document.addEventListener('DOMContentLoaded', () => {
    // UI 요소
    const statusArea = document.getElementById('statusArea');
    const logsDiv = document.getElementById('logs');
    const commandPreviewArea = document.getElementById('commandPreviewArea');
    const commandPreview = document.getElementById('commandPreview');

    // Downloader 인스턴스 생성 (plugin.js 에서 전달받은 updateUI 함수 사용)
    downloader = new Downloader(
        eagle.plugin.path, // eagle 전역 객체 사용 가능
        updateUI,
        window.updateCommandPreview, // window.updateCommandPreview 를 ui.js 내부에서 정의했으므로 직접 전달
        updateProgress // updateProgress 함수 전달
    );

    downloader.initialize().catch(error => { // Downloader 초기화
        console.error("Downloader initialization failed:", error);
    });


    // 로그 출력 함수 (plugin.js 에서 ui.js 로 옮겨옴)
    function appendLog(msg) {
        const div = document.createElement('div');
        div.textContent = msg;
        logsDiv.appendChild(div);
        logsDiv.scrollTop = logsDiv.scrollHeight;
    }

    // UI 업데이트 로깅 래핑 함수 (기존 updateUI 함수를 래핑)
    const _updateUI = window.updateUI; // 기존 updateUI 함수 백업
    window.updateUI = (message) => { // 래핑된 updateUI 함수로 교체 (window.updateUI 를 덮어씀)
        _updateUI(message); // 기존 updateUI 함수 호출 (실제 UI 업데이트)
        appendLog(message); // 로그 출력
    };


    // 탭 관리 (index.html 에서 script 블록에서 옮겨옴)
    const tabs = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    function showTab(targetId) {
        tabs.forEach(t => t.classList.remove('font-bold'));
        tabContents.forEach(tc => tc.classList.add('hidden'));

        const btn = Array.from(tabs).find(b => b.dataset.target === targetId);
        if (btn) btn.classList.add('font-bold');
        const content = document.getElementById(targetId);
        if (content) content.classList.remove('hidden');
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => showTab(tab.dataset.target));
    });
    showTab('singleTab');


    // 클립보드 붙여넣기 기능 (index.html 에서 script 블록에서 옮겨옴)
    document.querySelectorAll('.paste-button').forEach(button => {
        button.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                const input = button.parentElement.querySelector('input');
                input.value = text;
                input.dispatchEvent(new Event('input')); // 입력 이벤트 발생
            } catch (err) {
                console.error('Failed to read clipboard:', err);
            }
        });
    });


    // 다운로드 상태 관리 헬퍼 (index.html 에서 script 블록에서 옮겨옴)
    function handleDownloadState(startBtn, cancelBtn, isStarting) {
        startBtn.disabled = isStarting;
        if (isStarting) {
            cancelBtn.classList.remove('hidden');
        } else {
            cancelBtn.classList.add('hidden');
        }
    }


    // Single Video 다운로드 (index.html 에서 script 블록에서 옮겨옴)
    const singleElements = {
        url: document.getElementById('singleUrl'),
        format: document.getElementById('formatSelect'),
        quality: document.getElementById('qualitySelect'),
        speedLimit: document.getElementById('speedLimitInput'),
        concurrency: document.getElementById('concurrencyInput'),
        downloadBtn: document.getElementById('downloadBtn'),
        cancelBtn: document.getElementById('cancelBtn')
    };

    singleElements.downloadBtn.addEventListener('click', async () => {
        const url = singleElements.url.value.trim();
        if (!url) {
            updateUI("Please enter a video URL.");
            return;
        }

        handleDownloadState(singleElements.downloadBtn, singleElements.cancelBtn, true);
        try {
            await downloader.startDownload( // downloader 모듈의 startDownload 함수 호출
                url,
                singleElements.format.value,
                singleElements.quality.value,
                singleElements.speedLimit.value,
                parseInt(singleElements.concurrency.value || '1', 10)
            );
            updateUI("Download complete!"); // 다운로드 완료 UI 업데이트
        } catch (e) {
            console.error("Single download error:", e);
            updateUI("Single download failed: " + e.message);
        } finally {
            handleDownloadState(singleElements.downloadBtn, singleElements.cancelBtn, false);
        }

    });

    singleElements.cancelBtn.addEventListener('click', () => {
        downloader.cancel(); // downloader 모듈의 cancel 함수 호출
        handleDownloadState(singleElements.downloadBtn, singleElements.cancelBtn, false);
        updateUI("Download cancelled");
    });


    // Playlist 다운로드 (index.html 에서 script 블록에서 옮겨옴)
    const playlistElements = {
        url: document.getElementById('playlistUrl'),
        format: document.getElementById('playlistFormat'),
        quality: document.getElementById('playlistQuality'),
        speedLimit: document.getElementById('playlistSpeedLimit'),
        concurrency: document.getElementById('playlistConcurrency'),
        downloadBtn: document.getElementById('downloadPlaylistBtn'),
        cancelBtn: document.getElementById('cancelPlaylistBtn')
    };

    playlistElements.downloadBtn.addEventListener('click', async () => {
        const url = playlistElements.url.value.trim();
        if (!url) {
            updateUI("Please enter a playlist URL.");
            return;
        }

        handleDownloadState(playlistElements.downloadBtn, playlistElements.cancelBtn, true);
        try {
            await downloader.startDownload( // downloader 모듈의 startDownload 함수 호출
                url,
                playlistElements.format.value,
                playlistElements.quality.value,
                playlistElements.speedLimit.value,
                parseInt(playlistElements.concurrency.value || '1', 10)
            );
            updateUI("Playlist download complete!"); // 다운로드 완료 UI 업데이트
        } catch (err) {
            console.error("Playlist download error:", err);
            updateUI("Playlist download failed: " + err.message);
        } finally {
            handleDownloadState(playlistElements.downloadBtn, playlistElements.cancelBtn, false);
        }
    });

    playlistElements.cancelBtn.addEventListener('click', () => {
        downloader.cancel(); // downloader 모듈의 cancel 함수 호출
        handleDownloadState(playlistElements.downloadBtn, playlistElements.cancelBtn, false);
        updateUI("Download cancelled");
    });


    // ... (subscription 관련 UI 코드는 ui.js 로 옮겨오되, downloader 와 분리된 별도 모듈로 추후 구현 예정이므로, ui.js 에서는 일단 주석 처리하거나 최소한의 UI 관련 코드만 남겨둠) ...

});