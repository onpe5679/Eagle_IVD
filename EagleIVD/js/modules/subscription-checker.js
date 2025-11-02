const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const subscriptionDb = require('./subscription-db');
const { VideoDownloadQueue, VideoStatus } = require('./video-download-queue');
const DuplicateHandler = require('./duplicate-handler');

// Random User-Agent 리스트 및 선택 함수
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.96 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.5790.102 Safari/537.36'
];
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ytdlp 인자 빌더: User-Agent, 쿠키, 소스주소 옵션과 기본 플래그 및 URL 결합
function buildYtdlpArgs(urls, options = {}, baseFlags = []) {
  const args = [];

  const {
    userAgent,
    cookieFile,
    sourceAddress,
    // 네트워크 안정화 옵션 (기본값 적용)
    forceIpv6 = false,
    forceIpv4 = true,
    noCheckFormats = true,
  } = options || {};

  if (userAgent) args.push('--user-agent', userAgent);
  if (cookieFile) args.push('--cookies', cookieFile);
  if (sourceAddress) args.push('--source-address', sourceAddress);

  // 네트워크 경로 강제 (IPv6가 지정되면 IPv6 우선, 아니면 기본적으로 IPv4 강제)
  if (forceIpv6) args.push('--force-ipv6');
  else if (forceIpv4) args.push('--force-ipv4');

  // 포맷 실제 다운로드 검증 생략으로 지연/멈춤 완화
  if (noCheckFormats) args.push('--no-check-formats');

  args.push(...baseFlags);
  if (Array.isArray(urls)) args.push(...urls);
  else args.push(urls);
  return args;
}

/**
 * 구독 확인 로직을 담당하는 클래스
 */
class SubscriptionChecker {
  /**
   * @param {object} downloadManager - yt-dlp 호출을 위한 DownloadManager 인스턴스
   * @param {function} updateStatusUI - 상태 메시지 업데이트 콜백
   * @param {object} importer - 다운로드된 파일 임포트 로직 인스턴스
   * @param {number} libraryId - 현재 라이브러리 ID
   */
  constructor(downloadManager, updateStatusUI, importer, libraryId) {
    this.downloadManager = downloadManager;
    this.updateStatusUI = updateStatusUI;
    this.importer = importer;
    this.libraryId = libraryId;
    this.isChecking = false;
    this.duplicateHandler = new DuplicateHandler(libraryId);
  }

  /**
   * 모든 구독을 확인하고 새 영상 다운로드까지 처리합니다.
   * @param {Array} subscriptions - 구독 목록
   * @param {function} progressCallback - 진행 상황 콜백
   * @param {object} options - 옵션 객체 (concurrency, metadataBatchSize 등)
   */
  async checkAllSubscriptions(subscriptions, progressCallback, options = {}) {
    if (this.isChecking) {
      console.log("Already checking subscriptions");
      return [];
    }
    this.isChecking = true;

    const {
      concurrency = 3,
      metadataBatchSize = 30,
      downloadBatchSize = 5,
      rateLimit = 0,
      sourceAddress = '',
      randomUa = false,
      threadNics = [],
      threadCookies = []
    } = options;

    const total = subscriptions.length;
    if (total === 0) {
      console.log("No subscriptions to check");
      this.isChecking = false;
      return [];
    }

    try {
      // 1단계: 각 구독의 새 영상 수를 병렬로 확인
      const metadataTasks = subscriptions.map(async (sub) => {
        if (!this.isChecking) return null;
        try {
          // metadata count 조회용 인자 (NIC, UA, Cookie 제외)
          const args = buildYtdlpArgs(sub.url, { sourceAddress: '', userAgent: '', cookieFile: '' }, [
            '--skip-download','--flat-playlist','--print-json','--no-warnings','--ignore-errors',
            '--socket-timeout','30','--retries','1','--file-access-retries','1'
          ]);
          const fetchedIds = [];
          let playlistMeta = null;
          await new Promise((resolve) => {
            const proc = spawn(this.downloadManager.ytDlpPath, args);
            proc.stderr.on('data', () => {});
            proc.on('error', (err) => {
              console.error('yt-dlp metadataTasks error:', err);
              resolve();
            });
            let buf = '';
            proc.stdout.on('data', (d) => {
              buf += d.toString();
              const lines = buf.split("\n"); buf = lines.pop() || '';
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const item = JSON.parse(line);
                  if (!playlistMeta) playlistMeta = item;
                  if (item.id) fetchedIds.push(item.id);
                } catch {}
              }
            });
            proc.on('close', () => resolve());
          });
          
          console.log(`[Phase1 Debug] Playlist "${sub.user_title || sub.youtube_title}": YouTube에서 ${fetchedIds.length}개 영상 발견`);
          
          // DB에서 완전 처리된 영상 ID로 정확한 비교 (Phase 1과 실제 처리 일치)
          const completedVideoIds = await subscriptionDb.getCompletedVideoIds(sub.id);
          const completedSet = new Set(completedVideoIds);
          console.log(`[Phase1 Debug] Playlist "${sub.user_title || sub.youtube_title}": DB에서 ${completedSet.size}개 완료된 영상 발견`);
          console.log(`[Phase1 Debug] 완료된 영상 ID들:`, Array.from(completedSet));
          console.log(`[Phase1 Debug] YouTube ID들:`, fetchedIds.slice(0, 5), '...(총 ' + fetchedIds.length + '개)');
          
          const newVideoIds = fetchedIds.filter(id => !completedSet.has(id));
          const newCount = newVideoIds.length;
          console.log(`[Phase1 Debug] 새 영상 ${newCount}개:`, newVideoIds.slice(0, 3), newVideoIds.length > 3 ? '...' : '');
          
          // include fetchedIds and completedSet to avoid re-fetch in checkSubscription
          return { subscription: sub, newVideoCount: newCount, fetchedIds, completedVideoIds };
        } catch (error) {
          console.error(`[Phase1 Error] ${sub.user_title || sub.youtube_title}:`, error);
          return { subscription: sub, newVideoCount: 0, fetchedIds: [], completedVideoIds: [] };
        }
      });
      const resultsPhase1 = (await Promise.all(metadataTasks)).filter(r => r !== null);
      const subscriptionsWithNewVideoCount = resultsPhase1;
      console.log(`[Summary] 총 ${subscriptionsWithNewVideoCount.length}개의 재생목록 확인 완료`);

      // 2단계: 새 영상 수에 따라 정렬 (옵션으로 비활성화 가능)
      if (options.enableSorting !== false) {
        subscriptionsWithNewVideoCount.sort((a, b) => a.newVideoCount - b.newVideoCount);
      }

      // 3단계: 정렬된 순서대로 처리
      const results = [];
      for (let i = 0; i < subscriptionsWithNewVideoCount.length; i += concurrency) {
        if (!this.isChecking) break;
        const batch = subscriptionsWithNewVideoCount.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map((item, idx) => {
            // 스레드별 옵션 분기
            const threadSource = threadNics[idx] || sourceAddress;
            const threadCookie = threadCookies[idx] || '';
            const threadUA = randomUa ? getRandomUserAgent() : '';
            return this.checkSubscription(
              item.subscription,
              i + idx + 1,
              total,
              progressCallback,
              { metadataBatchSize, downloadBatchSize, rateLimit, sourceAddress: threadSource, cookieFile: threadCookie, userAgent: threadUA, preFetchedIds: item.fetchedIds, preFetchedCompletedIds: item.completedVideoIds }
            );
          })
        );
        results.push(...batchResults);
      }

      const newVideosCount = results.filter(r => r.newVideos > 0).length;
      this.updateStatusUI(`구독 확인 완료: ${total}개 중 ${newVideosCount}개에서 새 영상 발견`);
      return results;
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * 개별 구독 확인 및 다운로드 처리
   * @param {object} sub - 구독 객체
   * @param {number} current - 현재 인덱스
   * @param {number} total - 전체 개수
   * @param {function} progressCallback - 진행 상황 콜백
   * @param {object} options - 옵션 객체
   */
  async checkSubscription(sub, current, total, progressCallback, options = {}) {
    if (!this.isChecking) {
      return { subscription: sub, newVideos: 0, skippedVideos: 0, errorVideos: 0, stats: {} };
    }
    const { metadataBatchSize = 30, downloadBatchSize = 5, rateLimit = 0, sourceAddress = '', cookieFile = '', userAgent = '' } = options;
    if (progressCallback) {
      progressCallback(current, total, `플레이리스트 확인 중: ${sub.user_title || sub.youtube_title || sub.url}`);
    }
    const stats = { totalVideosFound: 0, newVideosFound: 0, processedVideos: 0, downloadedVideos: 0, skippedVideos: 0, errorVideos: 0 };
    const failedVideoErrors = new Map();
    try {
      // Phase 1: flat-playlist 메타데이터 조회 (필요 시만 실행)
      let fetchedIds = [];
      let playlistMetadata = null;
      if (options.preFetchedIds && Array.isArray(options.preFetchedIds)) {
        fetchedIds = options.preFetchedIds.slice();
      } else {
        const phase1Args = buildYtdlpArgs(sub.url, options, [
          '--skip-download','--flat-playlist','--print-json','--no-warnings','--ignore-errors',
          '--socket-timeout','30','--retries','1','--file-access-retries','1'
        ]);
        await new Promise(resolve => {
          const proc = spawn(this.downloadManager.ytDlpPath, phase1Args);
          proc.on('error', err => { console.error('yt-dlp checkSubscription phase1 error:', err); resolve(); });
          let buf = '';
          proc.stdout.on('data', data => {
            buf += data.toString();
            const lines = buf.split('\n'); buf = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const item = JSON.parse(line);
                if (!playlistMetadata) playlistMetadata = item;
                if (item.id) fetchedIds.push(item.id);
              } catch {}
            }
          });
          proc.stderr.on('data', () => {});
          proc.on('close', () => resolve());
        });
      }
      stats.totalVideosFound = fetchedIds.length;

      // DB에서 완전히 처리된 영상 ID 목록 조회 (pre-fetched 사용 우선)
      let completedVideoIds = options.preFetchedCompletedIds;
      if (!completedVideoIds || !Array.isArray(completedVideoIds)) {
        completedVideoIds = await subscriptionDb.getCompletedVideoIds(sub.id);
      }
      const completedSet = new Set(completedVideoIds);
      console.log(`[DB] 재생목록 "${sub.user_title || sub.youtube_title || '제목 없음'}" - DB에서 ${completedSet.size}개의 완전 처리된 영상 발견`);

      // 완전 처리되지 않은 새 영상 ID만 필터링
      const newVideoIds = fetchedIds.filter(id => !completedSet.has(id));
      stats.newVideosFound = newVideoIds.length;
      this.updateStatusUI(`${sub.user_title || sub.youtube_title || sub.url}: ${stats.newVideosFound}개의 새 영상 발견 (DB 비교)`);
      if (!newVideoIds.length) {
        console.log(`[Check] 재생목록 "${sub.user_title || sub.youtube_title || '제목 없음'}" (${sub.url}) - 새로운 영상 없음`);
        return { subscription: sub, newVideos: 0, skippedVideos: stats.skippedVideos, errorVideos: stats.errorVideos, stats };
      }

      // Phase 2: 새 영상 메타데이터 조회
      const videoUrlBatches = [];
      for (let i = 0; i < newVideoIds.length; i += metadataBatchSize) {
        videoUrlBatches.push(newVideoIds.slice(i, i + metadataBatchSize).map(id => `https://www.youtube.com/watch?v=${id}`));
      }
      const downloadedMetadata = {};
      for (let i = 0; i < videoUrlBatches.length; i++) {
        const batchUrls = videoUrlBatches[i];
        this.updateStatusUI(`${sub.user_title || sub.youtube_title || sub.url}: 메타데이터 가져오는 중 (${i+1}/${videoUrlBatches.length})`);
        const metaArgs = buildYtdlpArgs(batchUrls, options, [
          '--skip-download','--print-json','--no-warnings','--ignore-errors','--newline',
          '--socket-timeout','30','--retries','1','--file-access-retries','1'
        ]);
        await new Promise(resolve => {
          const mproc = spawn(this.downloadManager.ytDlpPath, metaArgs);
          let mBuf = '';
          mproc.stdout.on('data', data => {
            mBuf += data.toString();
            const lines = mBuf.split('\n'); mBuf = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const item = JSON.parse(line);
                if (item.id) { downloadedMetadata[item.id] = item; stats.processedVideos++; }
              } catch {}
            }
          });
          mproc.stderr.on('data', () => {});
          mproc.on('error', err => {
            console.error('yt-dlp metadata batch error:', err);
            resolve();
          });
          mproc.on('close', () => resolve());
        });
      }

      // 플레이리스트 설정 정의 (Phase 1.5에서 사용하기 위해 미리 정의)
      const playlistSettings = {
        title: sub.user_title || sub.youtube_title || 'Unknown Playlist',
        format: sub.format || 'best',
        quality: sub.quality || '',
        folderName: sub.user_title || sub.youtube_title,
        sourceAddress: sourceAddress,
        userAgent: userAgent,
        cookieFile: cookieFile
      };

      // Phase 1.5: 라이브러리 내 중복 검사
      this.updateStatusUI(`${sub.user_title || sub.youtube_title || sub.url}: 중복 영상 검사 중...`);
      const duplicateIds = [];
      const duplicateProcessingResults = [];
      let playlistFolderId = null;

      // 재생목록 폴더 확인/생성
      try {
        const allFolders = await eagle.folder.getAll();
        const exactMatch = allFolders.filter(f => f.name === playlistSettings.folderName);
        if (exactMatch.length > 0) {
          playlistFolderId = exactMatch[0].id;
          console.log(`[Phase1.5] 기존 폴더 사용: "${playlistSettings.folderName}" (ID: ${playlistFolderId})`);
        } else {
          const newFolder = await eagle.folder.create({ name: playlistSettings.folderName });
          playlistFolderId = newFolder.id;
          console.log(`[Phase1.5] 새 폴더 생성: "${playlistSettings.folderName}" (ID: ${playlistFolderId})`);
        }
      } catch (folderError) {
        console.error(`[Phase1.5] 폴더 처리 오류:`, folderError);
      }

      // 각 새 영상에 대해 중복 검사
      for (const videoId of newVideoIds) {
        try {
          const duplicateInfo = await this.duplicateHandler.findExistingVideoInLibrary(videoId);
          if (duplicateInfo) {
            console.log(`[Phase1.5] 중복 영상 발견: ${videoId} (원본: ${duplicateInfo.title})`);
            duplicateIds.push(videoId);
            
            if (playlistFolderId) {
              // Eagle 아이템 업데이트 (폴더 추가 + annotation 업데이트)
              const success = await this.duplicateHandler.processDuplicateVideo(
                duplicateInfo, 
                playlistFolderId, 
                playlistSettings.folderName,
                downloadedMetadata[videoId]
              );
              
              if (success) {
                // 중복 영상 DB 레코드 생성
                await this.duplicateHandler.createDuplicateRecord({
                  playlistId: sub.id,
                  videoId: videoId,
                  title: duplicateInfo.title,
                  masterVideoId: duplicateInfo.dbRecordId,
                  metadata: downloadedMetadata[videoId] || {}
                });
                
                duplicateProcessingResults.push({ videoId, status: 'success', action: 'duplicate_processed' });
                stats.skippedVideos++;
                console.log(`[Phase1.5] 중복 영상 처리 완료: ${videoId}`);
              } else {
                console.warn(`[Phase1.5] 중복 영상 Eagle 처리 실패: ${videoId}`);
                duplicateProcessingResults.push({ videoId, status: 'failed', action: 'eagle_update_failed' });
              }
            }
          }
        } catch (duplicateError) {
          console.error(`[Phase1.5] 중복 검사 오류 for ${videoId}:`, duplicateError);
        }
      }

      // 중복되지 않은 영상들만 다운로드 대상으로 필터링
      const videosToDownload = newVideoIds.filter(id => !duplicateIds.includes(id));
      const duplicateCount = duplicateIds.length;
      
      console.log(`[Phase1.5] 중복 검사 완료: 총 ${newVideoIds.length}개 중 ${duplicateCount}개 중복, ${videosToDownload.length}개 다운로드 예정`);
      
      if (duplicateCount > 0) {
        this.updateStatusUI(`${sub.user_title || sub.youtube_title || sub.url}: ${duplicateCount}개 중복 영상 처리, ${videosToDownload.length}개 다운로드 예정`);
      }

      if (videosToDownload.length === 0) {
        console.log(`[Phase1.5] 다운로드할 새 영상이 없음 (모두 중복)`);
        // 플레이리스트의 videoIds 업데이트 (중복 영상도 포함)
        sub.videoIds = Array.from(new Set([...(sub.videoIds || []), ...newVideoIds]));
        sub.lastCheck = Date.now();
        // 최종 결과 반환 (중복 처리만 완료)
        return { subscription: sub, newVideos: 0, skippedVideos: duplicateCount, errorVideos: 0, stats };
      }

      // Phase 3: 새로운 큐 시스템을 사용한 다운로드 처리 (중복 제외)
      this.updateStatusUI(`${sub.user_title || sub.youtube_title || sub.url}: ${videosToDownload.length}개 영상을 큐에 추가하여 다운로드 시작`);
      
      // UI 설정값 적용 (동시 다운로드 수, 속도 제한)
      this.downloadManager.applyUISettings();
      
      // Eagle 임포트 모듈 설정
      if (this.importer && this.downloadManager.downloadQueue) {
        this.downloadManager.downloadQueue.setImporter(this.importer);
      }
      
      // 속도 제한 설정 (rateLimit 옵션에서)
      if (rateLimit > 0 && this.downloadManager.downloadQueue) {
        this.downloadManager.downloadQueue.setRateLimit(rateLimit);
      }
      
      // 개별 영상을 큐에 추가
      const playlistInfo = {
        id: this.getPlaylistId(sub.url),
        playlistDbId: sub.id,
        title: playlistSettings.title,
        url: sub.url,
        folderName: playlistSettings.folderName,
        format: playlistSettings.format,
        quality: playlistSettings.quality,
        sourceAddress: playlistSettings.sourceAddress,
        userAgent: playlistSettings.userAgent,
        cookieFile: playlistSettings.cookieFile,
        uploader: playlistMetadata?.uploader || 'Unknown'
      };
      
      // VideoDownloadItem 생성 및 큐에 추가 (중복 제외된 영상만)
      const { VideoDownloadItem } = require('./video-download-queue');
      const videoItems = [];
      
      for (const videoId of videosToDownload) {
        const metadata = downloadedMetadata[videoId] || { id: videoId, title: `Video ${videoId}` };
        const videoItem = new VideoDownloadItem(metadata, playlistInfo);
        videoItems.push(videoItem);
        
        // 다운로드 관리자의 큐에 직접 추가
        if (!this.downloadManager.downloadQueue.queue.find(item => item.id === videoId)) {
          this.downloadManager.downloadQueue.queue.push(videoItem);
          this.downloadManager.downloadQueue.stats.total++;
        }
      }
      
      // 다운로드 큐 시작 (아직 실행 중이 아니라면)
      // 새 영상이 1개만 있으면 동시 다운로드 수를 1로 제한 (효율성)
      const optimalConcurrency = videosToDownload.length === 1 ? 1 : downloadBatchSize;
      if (!this.downloadManager.downloadQueue.isRunning) {
        this.downloadManager.downloadQueue.setMaxConcurrent(optimalConcurrency);
        this.downloadManager.downloadQueue.start();
      } else {
        // 이미 실행 중이면 동시 다운로드 수만 조정
        this.downloadManager.downloadQueue.setMaxConcurrent(optimalConcurrency);
      }
      
      // 다운로드 완료를 기다림 (중복 제외된 영상만)
      const successIds = [];
      const failedIds = [];
      
      await new Promise((resolve) => {
        let completedCount = 0;
        const totalVideosToDownload = videosToDownload.length;
        
        const handleVideoCompleted = (videoItem) => {
          if (videosToDownload.includes(videoItem.id)) {
            successIds.push(videoItem.id);
            completedCount++;
            stats.downloadedVideos++;
            
            this.updateStatusUI(`${sub.user_title || sub.youtube_title}: 완료 (${completedCount}/${totalVideosToDownload}) - ${videoItem.title}`);
            
            if (completedCount >= totalVideosToDownload) {
              this.downloadManager.downloadQueue.removeListener('videoCompleted', handleVideoCompleted);
              this.downloadManager.downloadQueue.removeListener('videoFailed', handleVideoFailed);
              resolve();
            }
          }
        };
        
        const handleVideoFailed = (videoItem) => {
          if (videosToDownload.includes(videoItem.id)) {
            failedIds.push(videoItem.id);
            completedCount++;
            stats.errorVideos++;
            failedVideoErrors.set(videoItem.id, videoItem.errorMessage || '다운로드 실패');
            
            this.updateStatusUI(`${sub.user_title || sub.youtube_title}: 실패 (${completedCount}/${totalVideosToDownload}) - ${videoItem.title}`);
            
            if (completedCount >= totalVideosToDownload) {
              this.downloadManager.downloadQueue.removeListener('videoCompleted', handleVideoCompleted);
              this.downloadManager.downloadQueue.removeListener('videoFailed', handleVideoFailed);
              resolve();
            }
          }
        };
        
        // 이벤트 리스너 등록
        this.downloadManager.downloadQueue.on('videoCompleted', handleVideoCompleted);
        this.downloadManager.downloadQueue.on('videoFailed', handleVideoFailed);
        
        // 타임아웃 설정 (30분)
        setTimeout(() => {
          this.downloadManager.downloadQueue.removeListener('videoCompleted', handleVideoCompleted);
          this.downloadManager.downloadQueue.removeListener('videoFailed', handleVideoFailed);
          console.warn(`Timeout waiting for downloads to complete for playlist: ${sub.user_title || sub.youtube_title}`);
          resolve();
        }, 30 * 60 * 1000);
      });
      
      console.log(`[Download Queue] 재생목록 "${sub.user_title || sub.youtube_title}" - 성공: ${successIds.length}, 실패: ${failedIds.length}`);

      // 다운로드 성공한 영상들을 DB에 추가
      for (const videoId of successIds) {
        const metadata = downloadedMetadata[videoId] || {};
        const videoData = {
          playlist_id: sub.id,
          video_id: videoId,
          title: metadata.title || videoId,
          status: 'completed', // 상태 통일: completed 사용
          downloaded: true,
          auto_download: sub.autoDownload || false,
          skip: false,
          eagle_linked: false, // 초기 상태는 false, importer가 true로 변경
          source_playlist_url: sub.url,
          first_attempt: new Date().toISOString(),
          downloaded_at: new Date().toISOString(),
          library_id: this.libraryId
        };
        console.log(`[DB Add Success] Playlist "${sub.user_title || sub.youtube_title}": Adding ${metadata.title || videoId} (ID: ${videoId})`);
        try {
          await subscriptionDb.addVideo(videoData);
          // Importer가 선행되어 DB 레코드가 없어서 eagle_linked 업데이트에 실패한 경우를 보완
          // (여기서 레코드가 방금 생성되었으므로 확실히 1로 설정)
          try {
            await subscriptionDb.markVideoAsEagleLinked(videoId, this.libraryId);
            console.log(`[DB Update] Ensured eagle_linked=1 for ${videoId} in library ${this.libraryId} after addVideo`);
          } catch (e) {
            console.error(`[DB Add Success] Failed to set eagle_linked for ${videoId} in library ${this.libraryId}:`, e);
          }
        } catch (dbError) {
          console.error(`[DB AddVideo - Success] Error adding video ${videoId} for playlist ${sub.id}:`, dbError, videoData);
        }
      }

      // 실패한 영상들도 DB에 기록 (이미 선언된 failedIds 사용)
      for (const videoId of failedIds) {
        const metadata = downloadedMetadata[videoId] || {};
        const videoData = {
          playlist_id: sub.id,
          video_id: videoId,
          title: metadata.title || videoId,
          status: 'failed',
          downloaded: false,
          auto_download: sub.autoDownload || false,
          skip: true,  // 실패한 영상은 자동으로 스킵 처리
          eagle_linked: false,
          source_playlist_url: sub.url,
          failed_reason: failedVideoErrors.get(videoId) || '알 수 없는 오류로 다운로드 실패',
          first_attempt: new Date().toISOString(),
          library_id: this.libraryId
        };
        console.log(`[DB Add Failed] Playlist "${sub.user_title || sub.youtube_title}": Recording failed video ${metadata.title || videoId} (ID: ${videoId})`);
        try {
          await subscriptionDb.addVideo(videoData);
        } catch (dbError) {
          console.error(`[DB AddVideo - Failed] Error adding video ${videoId} for playlist ${sub.id}:`, dbError, videoData);
        }
      }

      // 플레이리스트의 videoIds 업데이트 및 마지막 확인 시간 기록
      sub.videoIds = Array.from(new Set([...(sub.videoIds || []), ...newVideoIds]));
      sub.lastCheck = Date.now();

      // Eagle에 임포트는 video-download-queue.js에서 개별적으로 처리됨
      // 여기서는 별도 임포트 불필요 (중복 방지)
      console.log(`✅ Download queue handling Eagle import for ${successIds.length} videos`);

      // 최종 결과 반환 (실제 다운로드 성공/실패 반영)
      return { subscription: sub, newVideos: stats.downloadedVideos, skippedVideos: stats.skippedVideos, errorVideos: stats.errorVideos, stats };
    } catch (error) {
      console.error('Subscription check error:', error);
      return { subscription: sub, newVideos: 0, skippedVideos: 0, errorVideos: 1, stats: {} };
    }
  }

  /**
   * URL에서 재생목록 ID 추출
   * @param {string} url
   * @returns {string|null}
   */
  getPlaylistId(url) {
    const match = url.match(/list=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }
}

module.exports = SubscriptionChecker;
