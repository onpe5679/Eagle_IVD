// js/controllers/preview-controller.js
const uiController = require('../modules/ui-controller.js');

/**
 * YouTube URL 입력 시 미리보기 및 클립보드 붙여넣기 이벤트 바인딩
 */
function bindPreviewUI() {
  // 클립보드 붙여넣기 버튼
  document.querySelectorAll('.paste-button').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        const input = button.parentElement.querySelector('input');
        input.value = text;
        input.dispatchEvent(new Event('input'));
        console.log('클립보드 텍스트 붙여넣기 성공:', text);
      } catch (err) {
        console.error('Failed to read clipboard:', err);
        uiController.showError('Failed to read clipboard');
      }
    });
  });
  // 단일 URL 입력
  const singleUrlInput = document.getElementById('singleUrl');
  if (singleUrlInput) {
    singleUrlInput.addEventListener('input', () => {
      const url = singleUrlInput.value.trim();
      if (url && url.includes('youtu')) {
        if (window.previewTimer) clearTimeout(window.previewTimer);
        window.previewTimer = setTimeout(() => {
          window.fetchYoutubePreview(url);
        }, 500);
      }
    });
  }
  // 플레이리스트 URL 입력
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
}

module.exports = { bindPreviewUI };
