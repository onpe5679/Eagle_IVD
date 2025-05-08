// js/controllers/download-controller.js
/**
 * 다운로드 관련 UI 이벤트 바인딩
 */
module.exports.bindEvents = function(downloadManager, uiController) {
  const downloadBtn = document.getElementById('downloadBtn');
  if (downloadBtn) {
    console.log('다운로드 버튼 찾음');
    downloadBtn.addEventListener('click', () => {
      if (downloadBtn.disabled) return;
      downloadBtn.disabled = true;
      downloadBtn.classList.add('opacity-50');
      const cancelBtn = document.getElementById('cancelBtn');
      if (cancelBtn) cancelBtn.classList.remove('hidden');

      const url = document.getElementById('singleUrl').value;
      const format = document.getElementById('formatSelect').value;
      const quality = document.getElementById('qualitySelect').value;
      const speedLimit = document.getElementById('speedLimitInput').value;
      const concurrency = document.getElementById('concurrencyInput').value;
      console.log('다운로드 버튼 클릭됨, URL:', url);
      window.handleDownload(url, format, quality, speedLimit, concurrency)
        .then(() => {
          console.log('다운로드 완료');
          downloadBtn.disabled = false;
          downloadBtn.classList.remove('opacity-50');
          if (cancelBtn) cancelBtn.classList.add('hidden');
        })
        .catch(error => {
          console.error('다운로드 실패:', error);
          downloadBtn.disabled = false;
          downloadBtn.classList.remove('opacity-50');
          if (cancelBtn) cancelBtn.classList.add('hidden');
        });
    });
  }

  const playlistBtn = document.getElementById('downloadPlaylistBtn');
  if (playlistBtn) {
    console.log('플레이리스트 버튼 찾음');
    playlistBtn.addEventListener('click', () => {
      const url = document.getElementById('playlistUrl').value;
      const format = document.getElementById('playlistFormat').value;
      const quality = document.getElementById('playlistQuality').value;
      const speedLimit = document.getElementById('playlistSpeedLimit').value;
      const concurrency = document.getElementById('playlistConcurrency').value;
      console.log('플레이리스트 버튼 클릭됨, URL:', url);
      window.handleDownloadPlaylist(url, format, quality, speedLimit, concurrency);
    });
  }

  const cancelButtons = [
    document.getElementById('cancelBtn'),
    document.getElementById('cancelPlaylistBtn'),
    document.getElementById('cancelSubscriptionBtn')
  ].filter(btn => btn !== null);
  console.log(`${cancelButtons.length}개의 취소 버튼 찾음`);
  cancelButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      console.log('취소 버튼 클릭됨');
      window.cancelDownload();
    });
  });
};
