// js/plugin.js
import Downloader from './downloader.js'; // Downloader 클래스 import
import './ui.js'; // ui.js import (ui.js 내부에서 UI 초기화 및 이벤트 리스너 등록)

let downloadManager; // Downloader 인스턴스를 저장할 변수

eagle.onPluginCreate(async (plugin) => {
    console.log("onPluginCreate triggered");

    downloadManager = new Downloader( // Downloader 인스턴스 생성 (UI 업데이트 함수 ui.js 에서 정의된 함수 사용)
        plugin.path,
        window.updateUI, // ui.js 에서 정의된 window.updateUI 함수 전달
        window.updateCommandPreview, // ui.js 에서 정의된 window.updateCommandPreview 함수 전달
        window.updateProgress // ui.js 에서 정의된 window.updateProgress 함수 전달
    );

    try {
        await downloadManager.initialize(); // Downloader 초기화
    } catch (error) {
        console.error("Failed to initialize download manager:", error);
        return;
    }

    // ... (subscriptionManager 관련 코드는 일단 보류) ...

    // window.handleDownload 함수 정의 (ui.js 로 옮김)
    // window.handleDownloadPlaylist 함수 정의 (ui.js 로 옮김)
    // window.cancelDownload 함수 정의 (ui.js 로 옮김)
    // window.fetchYoutubePreview 함수 정의 (ui.js 로 옮김)
    // window.addSubscription 함수 정의 (subscription 기능 보류)
    // window.removeSubscription 함수 정의 (subscription 기능 보류)
    // window.loadSubscriptions 함수 정의 (subscription 기능 보류)
    // window.checkAllSubscriptions 함수 정의 (subscription 기능 보류)

});

eagle.onPluginRun(() => {
    console.log("eagle.onPluginRun triggered");
});