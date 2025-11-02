/**
 * 개별 영상 다운로드 큐 관리자
 * 재생목록을 개별 영상으로 분해하여 순차적으로 다운로드
 */

const { spawn } = require("child_process");
const EventEmitter = require('events');
const path = require("path");

/**
 * 영상 다운로드 상태
 */
const VideoStatus = {
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

/**
 * 개별 영상 정보
 */
class VideoDownloadItem {
  constructor(videoData, playlistInfo) {
    this.id = videoData.id;
    this.title = videoData.title || 'Unknown Title';
    this.url = `https://www.youtube.com/watch?v=${this.id}`;
    this.uploader = videoData.uploader || playlistInfo.uploader || 'Unknown';
    this.upload_date = videoData.upload_date;
    this.view_count = videoData.view_count;
    this.duration = videoData.duration;
    
    // 재생목록 정보
    this.playlistId = playlistInfo.id;
    this.playlistDbId = playlistInfo.playlistDbId || null;
    this.playlistTitle = playlistInfo.title;
    this.folderName = playlistInfo.folderName || playlistInfo.title;
    
    // 다운로드 설정
    this.format = playlistInfo.format || 'best';
    this.quality = playlistInfo.quality || '';
    
    // 상태 관리
    this.status = VideoStatus.PENDING;
    this.progress = 0;
    this.errorMessage = null;
    this.downloadedFilePath = null;
    this.retryCount = 0;
    this.maxRetries = 2;
    
    // Verbose 로그 처리용
    this.lastLoggedProgress = -1;
    this.lastUIUpdateProgress = -1;
    
    // 네트워크 설정
    this.sourceAddress = playlistInfo.sourceAddress || '';
    this.userAgent = playlistInfo.userAgent || '';
    this.cookieFile = playlistInfo.cookieFile || '';
  }
  
  /**
   * 재시도 가능한지 확인
   */
  canRetry() {
    return this.retryCount < this.maxRetries && this.status === VideoStatus.FAILED;
  }
  
  /**
   * 재시도 횟수 증가
   */
  incrementRetry() {
    this.retryCount++;
  }
}

/**
 * 비디오 다운로드 큐 관리자
 */
class VideoDownloadQueue extends EventEmitter {
  constructor(downloadManager) {
    super();
    this.downloadManager = downloadManager;
    this.queue = [];
    this.activeDownloads = new Map(); // videoId -> process
    this.maxConcurrent = 3;
    this.rateLimit = 0; // KB/s, 0 = unlimited
    this.isRunning = false;
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    };
    
    // Eagle 임포트를 위한 importer 참조
    this.importer = null;
  }
  
  /**
   * Eagle 임포트 모듈 설정
   * @param {Object} importer - SubscriptionImporter 인스턴스
   */
  setImporter(importer) {
    this.importer = importer;
  }
  
  /**
   * 속도 제한 설정
   * @param {number} rateLimitKBps - 속도 제한 (KB/s)
   */
  setRateLimit(rateLimitKBps) {
    this.rateLimit = Math.max(0, rateLimitKBps);
    console.log(`Rate limit set to: ${this.rateLimit} KB/s`);
  }
  
  /**
   * 재생목록을 개별 영상으로 분해하여 큐에 추가
   * @param {string} playlistUrl - 재생목록 URL
   * @param {Object} playlistSettings - 재생목록 설정 (format, quality, folderName 등)
   * @returns {Promise<number>} 추가된 영상 수
   */
  async addPlaylistToQueue(playlistUrl, playlistSettings = {}) {
    try {
      // 재생목록 메타데이터 가져오기
      const playlistMetadata = await this.downloadManager.getPlaylistMetadata(playlistUrl);
      
      if (!playlistMetadata || playlistMetadata.length === 0) {
        throw new Error('No videos found in playlist');
      }
      
      // 재생목록 정보 구성
      const playlistInfo = {
        id: this.extractPlaylistId(playlistUrl),
        title: playlistSettings.title || playlistMetadata[0]?.playlist || 'Unknown Playlist',
        url: playlistUrl,
        folderName: playlistSettings.folderName,
        format: playlistSettings.format || 'best',
        quality: playlistSettings.quality || '',
        sourceAddress: playlistSettings.sourceAddress || '',
        userAgent: playlistSettings.userAgent || '',
        cookieFile: playlistSettings.cookieFile || '',
        uploader: playlistMetadata[0]?.uploader
      };
      
      // 개별 영상을 큐에 추가
      let addedCount = 0;
      for (const videoData of playlistMetadata) {
        if (videoData.id) {
          const videoItem = new VideoDownloadItem(videoData, playlistInfo);
          
          // 중복 체크
          if (!this.queue.find(item => item.id === videoItem.id)) {
            this.queue.push(videoItem);
            addedCount++;
          }
        }
      }
      
      this.stats.total += addedCount;
      
      this.emit('playlistAdded', {
        playlistId: playlistInfo.id,
        title: playlistInfo.title,
        videoCount: addedCount
      });
      
      console.log(`Added ${addedCount} videos from playlist: ${playlistInfo.title}`);
      return addedCount;
      
    } catch (error) {
      console.error('Failed to add playlist to queue:', error);
      throw error;
    }
  }
  
  /**
   * 개별 영상을 큐에 추가
   * @param {string} videoUrl - 영상 URL
   * @param {Object} settings - 다운로드 설정
   */
  async addVideoToQueue(videoUrl, settings = {}) {
    try {
      // 영상 메타데이터 가져오기
      const metadata = await this.downloadManager.getMetadata(videoUrl);
      
      const playlistInfo = {
        id: 'single-video',
        title: settings.folderName || 'Single Videos',
        url: videoUrl,
        folderName: settings.folderName || 'Single Videos',
        format: settings.format || 'best',
        quality: settings.quality || '',
        sourceAddress: settings.sourceAddress || '',
        userAgent: settings.userAgent || '',
        cookieFile: settings.cookieFile || ''
      };
      
      const videoItem = new VideoDownloadItem(metadata, playlistInfo);
      
      // 중복 체크
      if (!this.queue.find(item => item.id === videoItem.id)) {
        this.queue.push(videoItem);
        this.stats.total++;
        
        this.emit('videoAdded', videoItem);
        console.log(`Added video to queue: ${videoItem.title}`);
      }
      
    } catch (error) {
      console.error('Failed to add video to queue:', error);
      throw error;
    }
  }
  
  /**
   * 큐 시작
   */
  start() {
    if (this.isRunning) {
      console.log('Queue is already running');
      return;
    }
    
    this.isRunning = true;
    this.emit('queueStarted');
    console.log(`Queue started with ${this.queue.length} videos`);
    
    // 동시 다운로드 시작
    this.processQueue();
  }
  
  /**
   * 큐 중지
   */
  stop() {
    this.isRunning = false;
    
    // 활성 다운로드 중지
    for (const [videoId, process] of this.activeDownloads) {
      if (process && process.kill) {
        process.kill();
      }
    }
    
    this.activeDownloads.clear();
    this.emit('queueStopped');
    console.log('Queue stopped');
  }
  
  /**
   * 큐 처리 (동시 다운로드)
   */
  async processQueue() {
    while (this.isRunning && this.queue.length > 0) {
      // 현재 활성 다운로드 수 확인
      if (this.activeDownloads.size >= this.maxConcurrent) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      
      // 다운로드할 영상 찾기
      const videoItem = this.queue.find(item => 
        item.status === VideoStatus.PENDING || 
        (item.status === VideoStatus.FAILED && item.canRetry())
      );
      
      if (!videoItem) {
        // 처리할 영상이 없으면 대기
        if (this.activeDownloads.size === 0) {
          // 모든 다운로드 완료
          this.completeQueue();
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      
      // 영상 다운로드 시작
      this.downloadVideo(videoItem);
      
      // 짧은 딜레이 (동시 시작 방지)
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  /**
   * 개별 영상 다운로드
   * @param {VideoDownloadItem} videoItem - 다운로드할 영상
   */
  async downloadVideo(videoItem) {
    videoItem.status = VideoStatus.DOWNLOADING;
    
    // 스레드 ID 생성 (로그 구분용)
    const threadId = videoItem.id.substring(0, 8);
    videoItem.threadId = threadId;
    
    this.emit('videoStarted', videoItem);
    
    try {
      // 다운로드 명령어 구성
      const args = this.buildVideoDownloadArgs(videoItem);
      
      console.log(`🚀 [Thread-${threadId}] Starting download: ${videoItem.title}`);
      
      // yt-dlp 프로세스 시작
      const process = spawn(this.downloadManager.ytDlpPath, args);
      this.activeDownloads.set(videoItem.id, process);
      
      let outputBuffer = '';
      
      process.stdout.on('data', (data) => {
        const output = data.toString();
        outputBuffer += output;
        
        // 진행률 파싱
        const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (progressMatch) {
          videoItem.progress = parseFloat(progressMatch[1]);
          // 진행률 로그를 verbose 레벨로 처리 (10% 단위로만 출력)
          const progressInt = Math.floor(videoItem.progress);
          if (progressInt % 10 === 0 && progressInt !== videoItem.lastLoggedProgress) {
            console.log(`📊 [Thread-${threadId}] Progress: ${progressInt}% - ${videoItem.title}`);
            videoItem.lastLoggedProgress = progressInt;
          } else if (videoItem.progress === 100 && videoItem.lastLoggedProgress !== 100) {
            console.log(`📊 [Thread-${threadId}] Progress: 100% - ${videoItem.title}`);
            videoItem.lastLoggedProgress = 100;
          }
          this.emit('videoProgress', videoItem);
        }
        
        // 중요한 로그만 출력 (스레드 구분)
        const lines = output.split('\n').filter(line => line.trim());
        for (const line of lines) {
          if (line.includes('[download]') && line.includes('Destination:')) {
            console.log(`📥 [Thread-${threadId}] ${line.trim()}`);
          } else if (line.includes('[download]') && line.includes('has already been downloaded')) {
            console.log(`⚠️ [Thread-${threadId}] ${line.trim()}`);
          }
        }
      });
      
      process.stderr.on('data', (data) => {
        const errorOutput = data.toString().trim();
        if (errorOutput) {
          console.error(`❌ [Thread-${threadId}] Error: ${errorOutput}`);
        }
      });
      
      process.on('close', async (code) => {
        this.activeDownloads.delete(videoItem.id);
        
        const subscriptionDb = require('./subscription-db');
        
        if (code === 0) {
          videoItem.status = VideoStatus.COMPLETED;
          videoItem.progress = 100;
          this.stats.completed++;
          
          // 데이터베이터에 다운로드 완료 상태 업데이트
          try {
            await subscriptionDb.markVideoDownloadComplete(videoItem.id, 'completed');
            console.log(`✅ [Thread-${threadId}] DB updated: ${videoItem.title} marked as completed`);
          } catch (dbError) {
            console.error(`❌ [Thread-${threadId}] DB update failed for ${videoItem.title}:`, dbError);
          }
          
          // 개별 영상 다운로드 완료 시 즉시 Eagle 임포트
          if (this.importer) {
            try {
              console.log(`🎯 [Thread-${threadId}] Starting Eagle import for: ${videoItem.title}`);
              
              // 개별 영상 메타데이터 구성
              const videoMetadata = {
                [videoItem.id]: {
                  id: videoItem.id,
                  title: videoItem.title,
                  uploader: videoItem.uploader,
                  upload_date: videoItem.upload_date,
                  view_count: videoItem.view_count,
                  duration: videoItem.duration
                }
              };
              
              // 플레이리스트 메타데이터 구성
              const playlistMetadata = {
                playlist: videoItem.playlistTitle,
                uploader: videoItem.uploader,
                id: videoItem.playlistId
              };
              
              // Eagle에 즉시 임포트
              await this.importer.importAndRemoveDownloadedFiles(
                this.downloadManager.downloadFolder,
                videoItem.url,
                playlistMetadata,
                videoItem.folderName,
                videoMetadata
              );
              
              console.log(`✅ [Thread-${threadId}] Eagle import completed for: ${videoItem.title}`);
              this.emit('videoImported', videoItem);
              // 성공적으로 임포트까지 끝난 경우, 플레이리스트 videos 카운트를 즉시 +1
              try {
                if (videoItem.playlistDbId) {
                  await subscriptionDb.incrementPlaylistVideos(videoItem.playlistDbId, 1);
                  console.log(`📈 [Thread-${threadId}] Playlist ${videoItem.playlistDbId} videos count incremented`);
                }
              } catch (incErr) {
                console.error(`⚠️ [Thread-${threadId}] Failed to increment playlist videos:`, incErr);
              }
              
            } catch (importError) {
              console.error(`❌ [Thread-${threadId}] Eagle import failed for ${videoItem.title}:`, importError);
              // Eagle 임포트 실패 시 처리 락 해제
              try {
                await subscriptionDb.releaseVideoProcessingLock(videoItem.id);
                console.log(`🔓 [Thread-${threadId}] Released processing lock for failed Eagle import: ${videoItem.title}`);
              } catch (unlockError) {
                console.error(`❌ [Thread-${threadId}] Failed to release processing lock:`, unlockError);
              }
            }
          } else {
            // Importer가 없는 경우 처리 락 해제
            try {
              await subscriptionDb.releaseVideoProcessingLock(videoItem.id);
            } catch (unlockError) {
              console.error(`❌ [Thread-${threadId}] Failed to release processing lock:`, unlockError);
            }
          }
          
          this.emit('videoCompleted', videoItem);
          console.log(`✅ [Thread-${threadId}] Download completed: ${videoItem.title}`);
        } else {
          videoItem.status = VideoStatus.FAILED;
          videoItem.errorMessage = `Process exited with code ${code}`;
          videoItem.incrementRetry();
          this.stats.failed++;
          
          // 데이터베이스에 실패 상태 업데이트 및 처리 락 해제
          try {
            await subscriptionDb.markVideoDownloadComplete(videoItem.id, 'failed', videoItem.errorMessage);
            console.log(`❌ [Thread-${threadId}] DB updated: ${videoItem.title} marked as failed`);
          } catch (dbError) {
            console.error(`❌ [Thread-${threadId}] DB update failed for ${videoItem.title}:`, dbError);
            // DB 업데이트 실패 시에도 처리 락 해제 시도
            try {
              await subscriptionDb.releaseVideoProcessingLock(videoItem.id);
            } catch (unlockError) {
              console.error(`❌ [Thread-${threadId}] Failed to release processing lock:`, unlockError);
            }
          }
          
          this.emit('videoFailed', videoItem);
          console.error(`❌ [Thread-${threadId}] Download failed: ${videoItem.title} (code: ${code})`);
        }
        
        this.emit('queueProgress', this.getQueueStats());
      });
      
    } catch (error) {
      this.activeDownloads.delete(videoItem.id);
      videoItem.status = VideoStatus.FAILED;
      videoItem.errorMessage = error.message;
      videoItem.incrementRetry();
      this.stats.failed++;
      this.emit('videoFailed', videoItem);
      console.error(`Download failed: ${videoItem.title}`, error);
    }
  }
  
  /**
   * 개별 영상 다운로드 인수 구성
   * @param {VideoDownloadItem} videoItem - 영상 정보
   * @returns {Array<string>} 명령줄 인수
   */
  buildVideoDownloadArgs(videoItem) {
    const args = [
      '--ffmpeg-location', this.downloadManager.ffmpegPath,
      '-o', path.join(this.downloadManager.downloadFolder, '%(title)s.%(ext)s'),
      '--progress',
      '--newline',
      '--no-warnings',
      '--no-check-formats',
      '--force-ipv4',
      '--socket-timeout', '15',
      '--retries', '1',
      '--file-access-retries', '1'
    ];
    
    // 포맷 설정 (분리된 파일 방지)
    if (videoItem.format === 'best') {
      args.push('-f', 'bv*+ba/b');
      args.push('--merge-output-format', 'mp4'); // 분리된 파일을 mp4로 병합
    } else if (videoItem.format === 'mp3') {
      args.push('-x', '--audio-format', 'mp3');
    } else {
      let formatString = videoItem.format;
      if (videoItem.quality) {
        formatString += `-${videoItem.quality}`;
      }
      args.push('-f', formatString);
      args.push('--merge-output-format', 'mp4'); // 분리된 파일을 mp4로 병합
    }
    
    // 속도 제한 설정 (UI에서 설정한 값 적용)
    if (this.rateLimit && this.rateLimit > 0) {
      args.push('--limit-rate', `${this.rateLimit}K`);
    }
    
    // 네트워크 설정
    if (videoItem.sourceAddress) {
      args.push('--source-address', videoItem.sourceAddress);
    }
    
    if (videoItem.userAgent) {
      args.push('--user-agent', videoItem.userAgent);
    }
    
    if (videoItem.cookieFile) {
      args.push('--cookies', videoItem.cookieFile);
    }
    
    // URL 추가
    args.push(videoItem.url);
    
    return args;
  }
  
  /**
   * URL에서 재생목록 ID 추출
   * @param {string} url - 재생목록 URL
   * @returns {string} 재생목록 ID
   */
  extractPlaylistId(url) {
    const match = url.match(/list=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : 'unknown';
  }
  
  /**
   * 큐 완료 처리
   */
  completeQueue() {
    this.isRunning = false;
    this.emit('queueCompleted', this.getQueueStats());
    console.log('Queue completed:', this.getQueueStats());
  }
  
  /**
   * 큐 통계 반환
   * @returns {Object} 통계 정보
   */
  getQueueStats() {
    return {
      total: this.stats.total,
      completed: this.stats.completed,
      failed: this.stats.failed,
      cancelled: this.stats.cancelled,
      pending: this.queue.filter(item => item.status === VideoStatus.PENDING).length,
      downloading: this.activeDownloads.size
    };
  }
  
  /**
   * 현재 큐 상태 반환
   * @returns {Array<VideoDownloadItem>} 큐의 모든 영상
   */
  getQueueItems() {
    return this.queue;
  }
  
  /**
   * 특정 영상 제거
   * @param {string} videoId - 제거할 영상 ID
   */
  removeVideo(videoId) {
    const index = this.queue.findIndex(item => item.id === videoId);
    if (index !== -1) {
      const videoItem = this.queue[index];
      
      // 다운로드 중이면 중지
      if (this.activeDownloads.has(videoId)) {
        const process = this.activeDownloads.get(videoId);
        if (process && process.kill) {
          process.kill();
        }
        this.activeDownloads.delete(videoId);
      }
      
      // 큐에서 제거
      this.queue.splice(index, 1);
      this.stats.cancelled++;
      
      this.emit('videoRemoved', videoItem);
    }
  }
  
  /**
   * 큐 초기화
   */
  clearQueue() {
    this.stop();
    this.queue = [];
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    };
    this.emit('queueCleared');
  }
  
  /**
   * 동시 다운로드 수 설정
   * @param {number} maxConcurrent - 최대 동시 다운로드 수
   */
  setMaxConcurrent(maxConcurrent) {
    this.maxConcurrent = Math.max(1, Math.min(10, maxConcurrent));
    console.log(`Max concurrent downloads set to: ${this.maxConcurrent}`);
  }
}

module.exports = {
  VideoDownloadQueue,
  VideoDownloadItem,
  VideoStatus
};
