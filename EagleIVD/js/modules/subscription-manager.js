/**
 * 구독 관리자 모듈
 * YouTube 플레이리스트 및 채널 구독 관리
 */

const fs = require("fs").promises;
const path = require("path");
const { spawn } = require("child_process");
const EventEmitter = require('events');
const subscriptionDb = require('./subscription-db');
const SubscriptionChecker = require('./subscription-checker');
const SubscriptionImporter = require('./subscription-importer');

/**
 * 구독 관리 기본 클래스
 */
class SubscriptionManager extends EventEmitter {
  /**
   * 구독 관리자 초기화
   * @param {string} pluginPath - 플러그인 경로
   */
  constructor(pluginPath) {
    super();
    this.pluginPath = pluginPath;
    this.subscriptions = [];
    this.isChecking = false;
    this.downloadManager = null;
    this.checker = null;
    this.stats = {
      duplicatesFound: 0,
      duplicatesResolved: 0,
      inconsistenciesFound: 0,
      inconsistenciesResolved: 0,
      errors: []
    };
    this.prefixUploadDate = true;
    this.importer = new SubscriptionImporter(this.updateStatusUI.bind(this), this.prefixUploadDate);
  }

  /**
   * 데이터베이스 초기화 및 초기 구독 로드를 수행합니다.
   * @returns {Promise<void>}
  */
  async initialize() {
    await this.loadSubscriptions();
    console.log("Subscription Manager initialized and subscriptions loaded.");
  }

  /**
   * 다운로드 관리자 설정
   * @param {object} downloadManager - 다운로드 관리자 인스턴스
  */
  setDownloadManager(downloadManager) {
    this.downloadManager = downloadManager;
    this.checker = new SubscriptionChecker(downloadManager, this.updateStatusUI.bind(this), this.importer);
  }

  /**
   * 구독 목록 로드
   * @returns {Promise<Array>} 구독 목록
   */
  async loadSubscriptions() {
    // DB가 초기화되었는지 확인 (선택적 안전 장치)
    if (!subscriptionDb) {
      throw new Error("Database is not initialized yet.");
    }
    this.subscriptions = await subscriptionDb.getAllPlaylists();
    return this.subscriptions;
  }

  /**
   * 구독 목록 저장 (요약 필드만 업데이트)
   * - videos 카운트는 개별 임포트 완료 시 즉시 증가 처리됨
   * - 여기서는 last_checked, videos_from_yt만 갱신
   * @param {Array} [results=[]] - checkAllSubscriptions 결과 배열
   * @returns {Promise<void>}
   */
  async saveSubscriptions(results = []) {
    // 결과를 구독 ID 기준으로 쉽게 찾기 위한 Map 생성
    const resultMap = new Map();
    if (Array.isArray(results)) {
      for (const r of results) {
        if (r && r.subscription && r.subscription.id) {
          resultMap.set(r.subscription.id, r);
        }
      }
    }

    for (const sub of this.subscriptions) {
      const result = resultMap.get(sub.id);
      if (result && result.subscription) {
        const last_checked = result.subscription.lastCheck || new Date().toISOString();
        const videos_from_yt = (result.stats && result.stats.totalVideosFound !== undefined)
          ? result.stats.totalVideosFound
          : sub.videos_from_yt;

        try {
          await subscriptionDb.updatePlaylistSummary(sub.id, { last_checked, videos_from_yt });
          console.log(`[SaveSubs] Summary updated for playlist ${sub.id} (last_checked, videos_from_yt)`);
        } catch (updateError) {
          console.error(`[SaveSubs] Failed to update summary for playlist ${sub.id}:`, updateError);
        }
      } else {
        // 결과가 없으면 요약 업데이트 생략 (기존 값 유지)
      }
    }
  }

  /**
   * 구독 추가
   * @param {object} options - 구독 옵션
   * @param {string} options.url - 구독 URL
   * @param {string} options.folderName - 저장 폴더 이름 (선택)
   * @param {string} options.format - 비디오 형식 (선택)
   * @param {string} options.quality - 비디오 품질 (선택)
   * @returns {Promise<void>}
   */
  async addSubscription({ url, folderName, format, quality }) {
    if (this.subscriptions.find(s => s.url === url)) {
      throw new Error("Already subscribed to that URL");
    }

    const newSub = {
      url,
      folderName: folderName || "",
      format: format || "best",
      quality: quality || "",
      videoIds: [],
      title: "",
      lastCheck: null,
      autoDownload: false,
      skip: false
    };

    // 메타데이터 취득
    try {
      const metadata = await this.downloadManager.getMetadata(url);
      if (metadata) {
        newSub.title = metadata.playlist_title || metadata.playlist || this.getPlaylistId(url);
        if (metadata.entries) newSub.videoIds = metadata.entries.map(e => e.id);
        newSub.videosFromYT = newSub.videoIds.length;
      }
    } catch {
      newSub.title = url;
    }

    // DB에 추가
    const id = await subscriptionDb.addPlaylist({
      user_title: newSub.folderName || newSub.title,
      youtube_title: newSub.title,
      videos_from_yt: newSub.videoIds.length,
      videos: newSub.videoIds.length,
      url: newSub.url,
      format: newSub.format,
      quality: newSub.quality,
      auto_download: newSub.autoDownload,
      skip: newSub.skip
    });
    newSub.id = id;
    this.subscriptions.push(newSub);

    console.log(`Subscribed to playlist: ${newSub.title} (${url})`);
    this.emit('subscriptionAdded', newSub);
  }

  /**
   * 구독 제거
   * @param {number} id - 구독 ID
   * @param {boolean} deleteVideos - 관련 영상도 함께 삭제할지 여부
   * @returns {Promise<void>}
   */
  async removeSubscription(id, deleteVideos = false) {
    try {
      await subscriptionDb.deletePlaylist(id, deleteVideos);
      this.subscriptions = this.subscriptions.filter(sub => sub.id !== id);
      this.emit('subscription-removed', id);
    } catch (error) {
      console.error('Error removing subscription:', error);
      throw error;
    }
  }

  /**
   * 모든 구독 확인
   * @param {Function} progressCallback - 진행 상황 콜백 함수
   * @param {Object} options - 다운로드 옵션
   * @returns {Promise<void>}
   */
  async checkAllSubscriptions(progressCallback, options = {}) {
    await this.loadSubscriptions();
    // checker.checkAllSubscriptions 결과를 results 변수에 저장
    const results = await this.checker.checkAllSubscriptions(this.subscriptions, progressCallback, options);
    // 결과를 saveSubscriptions에 전달
    await this.saveSubscriptions(results);
    this.emit('checkComplete');
  }

  /**
   * 개별 구독 확인 및 다운로드
   * @param {object} sub - 구독 정보
   * @param {number} current - 현재 진행 중인 구독 인덱스
   * @param {number} total - 전체 구독 수
   * @param {Function} progressCallback - 진행 상황 콜백 함수
   * @param {Object} options - 다운로드 옵션
   * @param {number} options.metadataBatchSize - 메타데이터 배치 크기 (기본값: 30)
   * @param {number} options.downloadBatchSize - 다운로드 배치 크기 (기본값: 5)
   * @param {number} options.rateLimit - 다운로드 속도 제한 (KB/s, 0=무제한)
   * @returns {Promise<object>} 구독 확인 결과 객체
   */
  async checkSubscription(sub, current, total, progressCallback, options = {}) {
    return await this.checker.checkSubscription(sub, current, total, progressCallback, options);
  }

  /**
   * 비디오 ID로 중복 여부 확인
   * @param {string} videoUrl - 비디오 URL
   * @param {string} videoId - 비디오 ID
   * @returns {Promise<boolean>} 중복 여부
   */
  async isDuplicate(videoUrl, videoId) {
    try {
      // Eagle API로 URL 기반 검색
      const items = await eagle.item.get({
        url: videoUrl
      });
      
      if (items.length > 0) {
        console.log(`Video already exists: ${videoUrl}`);
        return true;
      }
      
      // ID 기반 annotation 검색
      if (videoId) {
        const itemsByAnnotation = await eagle.item.get({ 
          annotation: `Video ID: ${videoId}` 
        });
        
        return itemsByAnnotation.length > 0;
      }
      
      return false;
    } catch (error) {
      console.error('Error checking duplicate:', error);
      return false; // 오류 시 중복 아님으로 처리
    }
  }

  /**
   * 체크 취소
   */
  cancelCheck() {
    this.isChecking = false;
  }

  /**
   * URL에서 재생목록 ID 추출
   * @param {string} url - 비디오 또는 재생목록 URL
   * @returns {string|null} 재생목록 ID
   */
  getPlaylistId(url) {
    const match = url.match(/list=([a-zA-Z0-9_-]+)/);
    if (match) {
      return match[1];
    }
    return null;
  }

  /**
   * 다운로드된 파일 가져오기 및 삭제
   * @param {string} folder - 다운로드 폴더
   * @param {string} url - 다운로드 URL
   * @param {object} metadata - 비디오 메타데이터
   * @param {string} customFolderName - 사용자 지정 폴더 이름
   * @param {object} videoMetadata - 개별 영상 메타데이터
   * @returns {Promise<void>}
   */
  async importAndRemoveDownloadedFiles(
    folder,
    url,
    metadata,
    customFolderName,
    videoMetadata = {},
    expectedVideoIds = []
  ) {
    return await this.importer.importAndRemoveDownloadedFiles(
      folder,
      url,
      metadata,
      customFolderName,
      videoMetadata,
      expectedVideoIds
    );
  }

  /**
   * 다운로드 진행 상황 업데이트
   * @param {string} output - yt-dlp 출력
   */
  updateProgress(output) {
    const match = output.match(
      /\[download\]\s+(\d+\.?\d*)%\s+of\s+([\d.]+[KMGT]?iB)\s+at\s+([\d.]+[KMGT]?iB\/s)\s+ETA\s+([\d:]+)/
    );
    // [download] 메시지도 진행률로 처리
    const isDownloadMessage = output.trim().startsWith('[download]');
    
    if (match || isDownloadMessage) {
      this.updateStatusUI(output, true);
    } else {
      this.updateStatusUI(output, false);
    }
  }

  /**
   * UI 상태 업데이트
   * @param {string} message - 상태 메시지
   * @param {boolean} isProgress - 다운로드 진행상황 메시지 여부
   */
  updateStatusUI(message, isProgress = false) {
    if (isProgress) {
      // 다운로드 진행률 및 [download] 관련 메시지는 debug 레벨로 출력
      console.debug("updateUI called with message:", message);
    } else {
      // 일반 메시지는 log 레벨로 출력
    console.log("updateUI called with message:", message);
    }
    
    if (window.updateUI) {
      window.updateUI(message);
    }
    this.emit('statusUpdate', message);
  }
}

/**
 * 향상된 구독 관리 클래스 (확장 기능 포함)
 */
class EnhancedSubscriptionManager extends SubscriptionManager {
  /**
   * 향상된 구독 관리자 초기화
   * @param {string} pluginPath - 플러그인 경로
   */
  constructor(pluginPath) {
    super(pluginPath);
    this.checkInterval = null;
  }
  
  /**
   * 자동 체크 시작
   * @param {number} intervalMinutes - 체크 간격 (분)
   */
  startAutoCheck(intervalMinutes = 60) {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    
    // 인터벌 설정 (밀리초 단위)
    const interval = intervalMinutes * 60 * 1000;
    
    this.checkInterval = setInterval(async () => {
      console.log(`Auto-checking subscriptions (${new Date().toLocaleString()})`);
      await this.checkAllSubscriptions();
    }, interval);
    
    console.log(`Automatic subscription check started (every ${intervalMinutes} minutes)`);
    this.emit('autoCheckStarted', intervalMinutes);
  }
  
  /**
   * 자동 체크 중지
   */
  stopAutoCheck() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('Automatic subscription check stopped');
      this.emit('autoCheckStopped');
    }
  }
  
  /**
   * 채널 ID 가져오기
   * @param {string} url - 채널 URL
   * @returns {Promise<string>} 채널 ID
   */
  async getChannelId(url) {
    // yt-dlp로 채널 ID 추출
    return new Promise((resolve, reject) => {
      // 채널 정보 가져오기
      const args = ['--dump-single-json', '--skip-download', '--flat-playlist', url];
      const process = spawn(this.downloadManager.ytDlpPath, args);
      
      let data = '';
      process.stdout.on('data', chunk => {
        data += chunk.toString();
      });
      
      process.stderr.on('data', chunk => {
        console.error("yt-dlp stderr:", chunk.toString());
      });
      
      process.on('close', code => {
        console.log(`Channel info process exited with code ${code}`);
        if (code === 0 && data.trim()) {
          try {
            // JSON 파싱
            const info = JSON.parse(data);
            console.log("Channel info retrieved:", info.id, info.channel_id);
            // 채널 ID 반환 (채널 또는 업로더 ID)
            const channelId = info.channel_id || info.uploader_id || info.id;
            
            if (!channelId) {
              reject(new Error('No channel ID found in the response'));
              return;
            }
            
            resolve(channelId);
          } catch (error) {
            console.error("Failed to parse channel info JSON:", error);
            reject(new Error(`Failed to parse channel info: ${error.message}`));
          }
        } else {
          reject(new Error(`Failed to get channel ID: exit code ${code}`));
        }
      });
    });
  }
  
  /**
   * 채널 구독 추가
   * @param {object} options - 구독 옵션
   * @param {string} options.url - 채널 URL
   * @param {string} options.folderName - 저장 폴더 이름 (선택)
   * @param {string} options.format - 비디오 형식 (선택)
   * @param {string} options.quality - 비디오 품질 (선택)
   * @returns {Promise<void>}
   */
  async addChannelSubscription({ url, folderName, format, quality }) {
    // 채널 URL 검증
    if (!url.includes('youtube.com/channel/') && !url.includes('youtube.com/c/') && 
        !url.includes('youtube.com/user/') && !url.includes('@') && 
        !url.includes('youtube.com/')) {
      throw new Error('Invalid YouTube channel URL');
    }
    
    try {
      // 채널의 최근 업로드 플레이리스트 URL로 변환
      console.log("Getting channel ID for:", url);
      const channelId = await this.getChannelId(url);
      console.log("Found channel ID:", channelId);
      
      // 채널 업로드 플레이리스트
      let uploadsPlaylistUrl;
      
      if (channelId.startsWith('UC')) {
        // UC로 시작하는 채널 ID인 경우 바로 변환
        uploadsPlaylistUrl = `https://www.youtube.com/playlist?list=UU${channelId.substring(2)}`;
      } else {
        // 그 외 채널 ID는 채널 페이지로 변환
        uploadsPlaylistUrl = `https://www.youtube.com/channel/${channelId}/videos`;
      }
      
      console.log("Created uploads playlist URL:", uploadsPlaylistUrl);
      
      // 플레이리스트 추가
      return this.addSubscription({
        url: uploadsPlaylistUrl,
        folderName,
        format,
        quality,
        isChannel: true,  // 채널 표시
        originalUrl: url  // 원래 채널 URL 저장
      });
    } catch (error) {
      console.error("Failed to add channel subscription:", error);
      throw new Error(`Failed to add channel: ${error.message}`);
    }
  }
}

// 모듈 내보내기
module.exports = {
  SubscriptionManager,
  EnhancedSubscriptionManager
};
