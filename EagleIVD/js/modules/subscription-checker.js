const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const subscriptionDb = require('./subscription-db');

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
function buildYtdlpArgs(urls, options, baseFlags) {
  const args = [];
  if (options.userAgent) args.push('--user-agent', options.userAgent);
  if (options.cookieFile) args.push('--cookies', options.cookieFile);
  if (options.sourceAddress) args.push('--source-address', options.sourceAddress);
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
          const existing = new Set(sub.videoIds || []);
          const newCount = fetchedIds.filter(id => !existing.has(id)).length;
          return { subscription: sub, newVideoCount: newCount };
        } catch {
          return { subscription: sub, newVideoCount: 0 };
        }
      });
      const resultsPhase1 = (await Promise.all(metadataTasks)).filter(r => r !== null);
      const subscriptionsWithNewVideoCount = resultsPhase1;
      console.log(`[Summary] 총 ${subscriptionsWithNewVideoCount.length}개의 재생목록 확인 완료`);

      // 2단계: 새 영상 수에 따라 정렬
      subscriptionsWithNewVideoCount.sort((a, b) => a.newVideoCount - b.newVideoCount);

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
              { metadataBatchSize, downloadBatchSize, rateLimit, sourceAddress: threadSource, cookieFile: threadCookie, userAgent: threadUA }
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
      // Phase 1: flat-playlist 메타데이터 조회 args
      const phase1Args = buildYtdlpArgs(sub.url, options, [
        '--skip-download','--flat-playlist','--print-json','--no-warnings','--ignore-errors',
        '--socket-timeout','30','--retries','1','--file-access-retries','1'
      ]);
      let fetchedIds = [];
      let playlistMetadata = null;
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
      stats.totalVideosFound = fetchedIds.length;

      // DB에서 현재 재생목록(sub.id)에 속한 영상 ID 목록 조회
      const existingVideosInDb = await subscriptionDb.getVideosByPlaylist(sub.id);
      const existingSet = new Set(existingVideosInDb.map(v => v.video_id));
      console.log(`[DB] 재생목록 "${sub.user_title || sub.youtube_title || '제목 없음'}" - DB에서 ${existingSet.size}개의 기존 영상 발견`);

      // DB에 없는 새 영상 ID만 필터링
      const newVideoIds = fetchedIds.filter(id => !existingSet.has(id));
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

      // Phase 3: 실제 다운로드 처리
      this.updateStatusUI(`${sub.user_title || sub.youtube_title || sub.url}: ${newVideoIds.length}개 영상 다운로드 시작`);
      const playlistId = this.getPlaylistId(sub.url);
      const tempFolder = path.join(this.downloadManager.downloadFolder, `subscription_${playlistId}`);
      console.log(`[Download] 재생목록 "${sub.user_title || sub.youtube_title || '제목 없음'}" 다운로드 시작 (URL: ${sub.url})`);
      await fs.mkdir(tempFolder, { recursive: true });
      const successIds = [];
      for (let i = 0; i < newVideoIds.length; i += downloadBatchSize) {
        const batch = newVideoIds.slice(i, i + downloadBatchSize);
        console.log(`[Batch] 재생목록 "${sub.user_title || sub.youtube_title || '제목 없음'}" - ${i+1}~${Math.min(i+downloadBatchSize, newVideoIds.length)}/${newVideoIds.length} 처리 중`);
        // Phase 3: 실제 다운로드 처리 args
        const downloadFlags = [
          '--ffmpeg-location', this.downloadManager.ffmpegPath,
          '-o', `${tempFolder}/%(id)s_%(title)s.%(ext)s`,
          '--progress','--no-warnings','--ignore-errors','--newline',
          '--socket-timeout','30','--retries','1','--file-access-retries','1'
        ];
        const args = buildYtdlpArgs(batch.map(id => `https://www.youtube.com/watch?v=${id}`), options, downloadFlags);
        // 포맷 설정
        if (sub.format === 'mp3') { args.push('-x','--audio-format','mp3'); }
        else if (sub.format === 'best') { args.push('-f','bv*+ba/b'); }
        else {
          let fmt = sub.format;
          if (sub.quality) fmt += `-${sub.quality}`;
          args.push('-f',fmt);
        }
        await new Promise(resolve => {
          const proc = spawn(this.downloadManager.ytDlpPath, args);
          proc.stdout.on('data', data => {
            const output = data.toString();
            this.updateStatusUI(output, true);
            if (output.includes('Destination:')) {
              const m = output.match(/Destination: .*[\\\/]([A-Za-z0-9_-]{11})_/);
              if (m && m[1]) {
                successIds.push(m[1]);
                stats.downloadedVideos++;
              }
            }
          });
          proc.stderr.on('data', data => {
            const msg = data.toString();
            console.error(`[Error] 재생목록 "${sub.user_title || sub.youtube_title || '제목 없음'}" (${sub.url}) - 다운로드 오류:`, msg);

            // 다양한 패턴으로 영상 ID와 오류 메시지 추출
            let errorMatch = msg.match(/ERROR: \[youtube\] ([^:]+): (.+)/)
                        || msg.match(/ERROR: ([^:]+): (.+)/)
                        || msg.match(/WARNING: video download failed: ([^\s]+) - (.+)/i);

            if (errorMatch) {
              const videoId = errorMatch[1];
              const errorMessage = errorMatch[2] || msg.trim();
              stats.errorVideos++;
              // 특정 videoId에 대한 오류 메시지 저장
              failedVideoErrors.set(videoId, errorMessage);
              this.updateStatusUI(`경고: 영상 다운로드 실패 (${videoId}): ${errorMessage}`);
            } else if (msg.includes('ERROR:') || msg.includes('WARNING:')) {
              stats.errorVideos++; // 에러 카운트는 증가
              this.updateStatusUI(`경고: 다운로드 실패 - ${msg.trim()}`);
              // 특정 ID 추출 실패 시, 현재 배치 내 영상들에 일반 오류 메시지 기록
              // (이미 특정 오류가 기록된 영상은 제외)
              batch.forEach(videoId => {
                if (!failedVideoErrors.has(videoId)) {
                  failedVideoErrors.set(videoId, msg.trim());
                }
              });
            }
          });
          proc.on('error', err => {
            console.error('yt-dlp download error:', err);
            resolve();
          });
          proc.on('close', () => resolve());
        });
      }

      // 다운로드 성공한 영상들을 DB에 추가
      for (const videoId of successIds) {
        const metadata = downloadedMetadata[videoId] || {};
        const videoData = {
          playlist_id: sub.id,
          video_id: videoId,
          title: metadata.title || videoId,
          status: 'done',
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
        } catch (dbError) {
          console.error(`[DB AddVideo - Success] Error adding video ${videoId} for playlist ${sub.id}:`, dbError, videoData);
        }
      }

      // 실패한 영상들도 DB에 기록
      const failedIds = newVideoIds.filter(id => !successIds.includes(id));
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

      // Eagle에 임포트 및 임시 파일 정리
      await this.importer.importAndRemoveDownloadedFiles(tempFolder, sub.url, playlistMetadata, sub.folderName, downloadedMetadata);
      try { await fs.rm(tempFolder, { recursive: true, force: true }); } catch {} // 임시 폴더 삭제 시도

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
