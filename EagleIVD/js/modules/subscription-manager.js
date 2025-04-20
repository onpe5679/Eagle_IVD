/**
 * 구독 관리자 모듈
 * YouTube 플레이리스트 및 채널 구독 관리
 */

const fs = require("fs").promises;
const path = require("path");
const { spawn } = require("child_process");
const EventEmitter = require('events');

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
    this.subFile = path.join(pluginPath, "subscriptions.json");
    this.subscriptions = [];
    this.isChecking = false;
    this.downloadManager = null;
    this.stats = {
      duplicatesFound: 0,
      duplicatesResolved: 0,
      inconsistenciesFound: 0,
      inconsistenciesResolved: 0,
      errors: []
    };
    this.prefixUploadDate = true;
  }

  /**
   * 다운로드 관리자 설정
   * @param {object} downloadManager - 다운로드 관리자 인스턴스
   */
  setDownloadManager(downloadManager) {
    this.downloadManager = downloadManager;
  }

  /**
   * 구독 목록 로드
   * @returns {Promise<Array>} 구독 목록
   */
  async loadSubscriptions() {
    try {
      const content = await fs.readFile(this.subFile, "utf8");
      this.subscriptions = JSON.parse(content);
    } catch (e) {
      console.log("No subscriptions file or read error, starting fresh");
      this.subscriptions = [];
    }
    return this.subscriptions;
  }

  /**
   * 구독 목록 저장
   * @returns {Promise<void>}
   */
  async saveSubscriptions() {
    await fs.writeFile(this.subFile, JSON.stringify(this.subscriptions, null, 2), "utf8");
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
      lastCheck: null
    };

    // 구독 정보를 가져오는 부분
    try {
      const metadata = await this.downloadManager.getMetadata(url);
      if (metadata) {
        newSub.title = metadata.playlist_title || metadata.playlist || this.getPlaylistId(url);
        // 구독 추가 시 전체 영상 ID 목록을 저장
        if (metadata.entries && metadata.entries.length > 0) {
          newSub.videoIds = metadata.entries.map(entry => entry.id);
        } else {
          newSub.videoIds = [];
        }
      }
    } catch (error) {
      console.error("Error fetching playlist metadata:", error);
      // 메타데이터를 가져오는 데 실패한 경우에도 기본적인 정보로 구독을 추가
      newSub.title = url; // URL을 타이틀로 사용하거나, 다른 기본값을 설정
      newSub.videoIds = []; // 비디오 ID를 빈 배열로 설정
    }

    this.subscriptions.push(newSub);
    await this.saveSubscriptions();

    console.log(`Subscribed to playlist: ${newSub.title} (${url})`);
    this.emit('subscriptionAdded', newSub);
  }

  /**
   * 구독 제거
   * @param {string} url - 구독 URL
   * @returns {Promise<void>}
   */
  async removeSubscription(url) {
    const subscription = this.subscriptions.find(s => s.url === url);
    if (subscription) {
      this.subscriptions = this.subscriptions.filter(s => s.url !== url);
      await this.saveSubscriptions();
      console.log("Unsubscribed from playlist:", url);
      this.emit('subscriptionRemoved', subscription);
    } else {
      console.log("Subscription not found:", url);
    }
  }

  /**
   * 모든 구독 확인 및 새 비디오 다운로드
   * @param {Function} progressCallback - 진행 상황 콜백 함수
   * @param {Object} options - 다운로드 옵션
   * @param {number} options.concurrency - 동시 처리할 최대 구독 수 (기본값: 3)
   * @param {number} options.metadataBatchSize - 메타데이터 배치 크기 (기본값: 30)
   * @param {number} options.downloadBatchSize - 다운로드 배치 크기 (기본값: 5)
   * @param {number} options.rateLimit - 다운로드 속도 제한 (KB/s, 0=무제한)
   * @returns {Promise<void>}
   */
  async checkAllSubscriptions(progressCallback, options = {}) {
    if (this.isChecking) {
      console.log("Already checking subscriptions. Please wait.");
      return;
    }

    const {
      concurrency = 3,
      metadataBatchSize = 30,
      downloadBatchSize = 5,
      rateLimit = 0,
      sourceAddress = ''
    } = options;

    console.log("Checking for new videos with options:", { 
      concurrency, 
      metadataBatchSize, 
      downloadBatchSize, 
      rateLimit,
      sourceAddress
    });
    
    this.isChecking = true;
    const total = this.subscriptions.length;
    
    try {
      // 구독 목록을 배열로 복사
      const subscriptions = [...this.subscriptions];
      const results = [];
      
      // 병렬 처리를 위한 함수
      const processInBatches = async () => {
        // concurrency 단위로 처리할 배치 생성
        while (subscriptions.length > 0 && this.isChecking) {
          const batch = subscriptions.splice(0, concurrency);
          
          // 배치 내의 구독을 병렬로 처리
          const batchPromises = batch.map((sub, index) => {
            return this.checkSubscription(
              sub, 
              total - subscriptions.length - batch.length + index + 1, 
              total, 
              progressCallback,
              { metadataBatchSize, downloadBatchSize, rateLimit, sourceAddress }
            );
          });
          
          // 현재 배치의 모든 작업이 완료될 때까지 대기
          const batchResults = await Promise.all(batchPromises);
          results.push(...batchResults);
        }
      };
      
      await processInBatches();
      
      // 결과 요약
      const newVideosCount = results.filter(r => r.newVideos > 0).length;
      console.log(`Checked ${total} subscriptions, found new videos in ${newVideosCount} playlists.`);
      this.updateStatusUI(`구독 확인 완료: ${total}개 중 ${newVideosCount}개에서 새 영상 발견`);
      
    } finally {
      this.isChecking = false;
      console.log("Finished checking all subscriptions.");
      this.emit('checkComplete');
    }
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
    if (!this.isChecking) {
      return { subscription: sub, newVideos: 0, error: null };
    }

    // 옵션에 sourceAddress 추가
    const {
      metadataBatchSize = 30,
      downloadBatchSize = 5,
      rateLimit = 0,
      sourceAddress = ''
    } = options;
    
    if (progressCallback) {
      progressCallback(
        current,
        total,
        `플레이리스트 확인 중: ${sub.title || sub.url}`
      );
    }
    
    // 결과 통계 초기화
    const stats = {
      totalVideosFound: 0,
      newVideosFound: 0,
      processedVideos: 0,
      downloadedVideos: 0,
      skippedVideos: 0,
      errorVideos: 0
    };
    
    try {
      // Phase 1: 경량화된 메타데이터만 먼저 확인 (최적화된 방식)
      const phase1Args = [
        "--skip-download",
        "--flat-playlist",
        "--print-json",
        "--no-warnings",
        "--ignore-errors",
        sub.url
      ];
      // sourceAddress 옵션 적용
      if (sourceAddress) {
        phase1Args.unshift(sourceAddress);
        phase1Args.unshift('--source-address');
        console.log('Phase1 yt-dlp args with sourceAddress:', phase1Args);
      } else {
        console.log('Phase1 yt-dlp args:', phase1Args);
      }
      
      let fetchedVideoIds = [];
      let playlistMetadata = null;
      
      await new Promise((resolve, reject) => {
        const phase1Process = spawn(this.downloadManager.ytDlpPath, phase1Args);
        
        let buffer = '';
        phase1Process.stdout.on("data", (data) => {
          // 스트림 데이터를 버퍼에 축적
          buffer += data.toString();
          
          // 완전한 JSON 객체가 포함된 라인만 처리
          const lines = buffer.split("\n");
          // 마지막 라인은 불완전할 수 있으므로 버퍼에 다시 저장
          buffer = lines.pop() || '';
          
          // 완전한 라인 처리
          for (const line of lines) {
            if (!line.trim()) continue;
            
            try {
              if (line.startsWith("{")) {
                const item = JSON.parse(line);
                
                if (!playlistMetadata) {
                  playlistMetadata = item;
                }
                
                // 확실한 ID 정보만 추출
                if (item.id) {
                  fetchedVideoIds.push(item.id);
                }
              }
            } catch (e) {
              console.error("Phase1 JSON parse error:", e);
              // JSON 파싱 오류는 무시하고 계속 진행
            }
          }
        });
        
        phase1Process.stderr.on("data", (data) => {
          const errorMsg = data.toString();
          console.error("Phase1 yt-dlp stderr:", errorMsg);
          
          // 비공개 영상 등 경고 로그
          if (errorMsg.includes("Private video") || errorMsg.includes("This video is unavailable")) {
            this.updateStatusUI(`경고: ${sub.title || sub.url}에 접근할 수 없는 영상이 포함되어 있습니다`);
            stats.skippedVideos++;
          }
        });
        
        phase1Process.on("close", (code) => {
          // 남은 버퍼 처리
          if (buffer.trim()) {
            try {
              const item = JSON.parse(buffer);
              if (item.id && !fetchedVideoIds.includes(item.id)) {
                fetchedVideoIds.push(item.id);
              }
            } catch (e) {
              console.error("Buffer JSON parse error:", e);
            }
          }
          
          // 오류가 있어도 가져온 데이터로 계속 진행
          if (fetchedVideoIds.length > 0) {
            stats.totalVideosFound = fetchedVideoIds.length;
            resolve();
          } else if (code !== 0 && code !== null) {
            // 전혀 가져오지 못한 경우에만 오류로 처리
            reject(new Error(`Phase1: yt-dlp exited with code ${code}`));
          } else {
            // 영상이 없는 경우 정상 종료
            resolve();
          }
        });
      });
      
      // 새 비디오 ID 필터링 (메모리 효율적 방식)
      const videoIdSet = new Set(sub.videoIds); // O(1) 조회를 위한 Set 사용
      const newVideoIds = fetchedVideoIds.filter(id => !videoIdSet.has(id));
      stats.newVideosFound = newVideoIds.length;
      
      console.log(`플레이리스트 ${sub.title || sub.url}: 총 ${fetchedVideoIds.length}개 중 ${newVideoIds.length}개 새 영상 발견${stats.skippedVideos > 0 ? `, ${stats.skippedVideos}개 영상 건너뜀` : ''}`);
      
      if (newVideoIds.length === 0) {
        this.updateStatusUI(`${sub.title || sub.url}: 새 영상 없음${stats.skippedVideos > 0 ? ` (${stats.skippedVideos}개 영상 건너뜀)` : ''}`);
        return { subscription: sub, newVideos: 0, error: null, stats };
      }
      
      this.updateStatusUI(`${sub.title || sub.url}: ${newVideoIds.length}개의 새 영상 발견`);
      
      // 새 영상이 있을 때만 임시 폴더 생성
      const playlistId = this.getPlaylistId(sub.url);
      const tempFolder = path.join(
        this.downloadManager.downloadFolder,
        "subscription_" + playlistId
      );
      
      try {
        // 폴더 생성 시도
        await fs.mkdir(tempFolder, { recursive: true });
        console.log(`임시 폴더 생성됨: ${tempFolder}`);
        
        // Phase 2: 새 영상의 자세한 메타데이터 취득 (다운로드 없이)
        // 새 영상 URL 목록 구성 (metadataBatchSize 단위로 처리)
        const videoUrlBatches = [];
        
        for (let i = 0; i < newVideoIds.length; i += metadataBatchSize) {
          videoUrlBatches.push(
            newVideoIds.slice(i, i + metadataBatchSize).map(id => `https://www.youtube.com/watch?v=${id}`)
          );
        }
        
        const downloadedVideoIds = [];
        const downloadedMetadata = {};
        let failedVideoIds = [];
        
        // 새 영상 메타데이터 일괄 처리
        for (let i = 0; i < videoUrlBatches.length; i++) {
          const batchUrls = videoUrlBatches[i];
          this.updateStatusUI(`${sub.title || sub.url}: 새 영상 메타데이터 가져오는 중 (${i+1}/${videoUrlBatches.length})`);
          
          // 메타데이터 가져오기 (배치 단위)
          const metadataArgs = [
            "--skip-download",
            "--print-json",
            "--no-warnings",
            "--ignore-errors",  // 오류 무시하고 계속 진행
            "--newline",
            "--socket-timeout", "30",  // 소켓 타임아웃 설정 (초)
            "--retries", "1",          // 재시도 횟수 제한
            "--file-access-retries", "1", // 파일 액세스 재시도 제한
            ...batchUrls
          ];
          // sourceAddress 옵션 적용
          if (sourceAddress) {
            metadataArgs.unshift(sourceAddress);
            metadataArgs.unshift('--source-address');
            console.log('Metadata yt-dlp args with sourceAddress:', metadataArgs);
          } else {
            console.log('Metadata yt-dlp args:', metadataArgs);
          }
          
          await new Promise((resolve) => {
            const startTime = Date.now();
            console.log(`메타데이터 배치 ${i+1}/${videoUrlBatches.length} 처리 시작 - ${batchUrls.length}개 URL`);
            
            const metadataProcess = spawn(this.downloadManager.ytDlpPath, metadataArgs);
            let metaBuffer = '';
            
            // 타임아웃 설정 (3분)
            const timeoutId = setTimeout(() => {
              console.log(`메타데이터 배치 ${i+1} 처리 타임아웃 - 20초 초과`);
              this.updateStatusUI(`경고: 메타데이터 처리 타임아웃 - 다음 배치로 진행합니다`);
              
              if (metadataProcess.exitCode === null) {
                metadataProcess.kill();
              }
              resolve(); // 타임아웃이어도 다음 단계로 진행
            }, 20000); // 20 = 20000ms
            
            metadataProcess.stdout.on("data", (data) => {
              metaBuffer += data.toString();
              
              const lines = metaBuffer.split("\n");
              metaBuffer = lines.pop() || '';
              
              for (const line of lines) {
                if (!line.trim()) continue;
                
                try {
                  if (line.startsWith("{")) {
                    const item = JSON.parse(line);
                    if (item.id && !downloadedVideoIds.includes(item.id)) {
                      downloadedVideoIds.push(item.id);
                      downloadedMetadata[item.id] = item; // 메타데이터 저장
                      stats.processedVideos++;
                      
                      // 진행 상황 업데이트 (10개마다)
                      if (stats.processedVideos % 10 === 0) {
                        console.log(`현재까지 ${stats.processedVideos}개 영상 메타데이터 처리됨`);
                      }
                    }
                  }
                } catch (e) {
                  console.error("Metadata JSON parse error:", e);
                }
              }
            });
            
            metadataProcess.stderr.on("data", (data) => {
              const errorMsg = data.toString();
              console.error("Metadata yt-dlp stderr:", errorMsg);
              
              // 오류 영상 ID 추출 시도
              const errorVideoMatch = errorMsg.match(/ERROR: \[youtube\] ([^:]+):/);
              if (errorVideoMatch && errorVideoMatch[1]) {
                const errorVideoId = errorVideoMatch[1];
                failedVideoIds.push(errorVideoId);
                stats.errorVideos++;
                this.updateStatusUI(`경고: 영상 [${errorVideoId}] 접근 불가 - 건너뜁니다`);
                console.log(`영상 [${errorVideoId}] 접근 불가 - 오류: ${errorMsg.split('\n')[0]}`);
              }
              
              // 비공개 영상 등 경고 로그
              if (errorMsg.includes("Private video") || errorMsg.includes("This video is unavailable")) {
                this.updateStatusUI(`경고: 접근할 수 없는 영상이 있습니다. 건너뜁니다.`);
                stats.skippedVideos++;
              }
            });
            
            metadataProcess.on("close", (code) => {
              clearTimeout(timeoutId); // 타임아웃 해제
              
              const endTime = Date.now();
              const elapsedTime = (endTime - startTime) / 1000; // 초 단위
              console.log(`메타데이터 배치 ${i+1} 처리 완료 - 소요시간: ${elapsedTime.toFixed(1)}초, 종료 코드: ${code}`);
              
              if (metaBuffer.trim()) {
                try {
                  const item = JSON.parse(metaBuffer);
                  if (item.id && !downloadedVideoIds.includes(item.id)) {
                    downloadedVideoIds.push(item.id);
                    downloadedMetadata[item.id] = item;
                    stats.processedVideos++;
                  }
                } catch (e) {
                  console.error("Metadata buffer parse error:", e);
                }
              }
              
              // 항상 resolve하여 계속 진행
              resolve();
            });
          });
        }
        
        // 모든 영상이 실패한 경우
        if (downloadedVideoIds.length === 0) {
          this.updateStatusUI(`${sub.title || sub.url}: 모든 새 영상을 처리할 수 없습니다. 건너뜁니다.`);
          
          // 영상 ID를 기존 목록에 추가 (다음 체크에서 다시 시도하지 않도록)
          if (failedVideoIds.length > 0) {
            sub.videoIds = Array.from(new Set([...sub.videoIds, ...failedVideoIds]));
            await this.saveSubscriptions();
            console.log(`실패한 영상 ID ${failedVideoIds.length}개가 구독 목록에 추가되었습니다.`);
          }
          
          return { 
            subscription: sub, 
            newVideos: 0,
            skippedVideos: stats.skippedVideos,
            errorVideos: stats.errorVideos,
            stats,
            error: `${stats.errorVideos}개 영상 접근 불가`,
          };
        }
        
        // Phase 3: 실제 다운로드 (새 영상만)
        this.updateStatusUI(`${sub.title || sub.url}: ${downloadedVideoIds.length}개 영상 다운로드 시작`);
        
        // 영상을 downloadBatchSize 단위로 나누어 다운로드
        const downloadedFiles = [];
        const successfullyDownloadedIds = [];
        
        for (let i = 0; i < downloadedVideoIds.length; i += downloadBatchSize) {
          const batchIds = downloadedVideoIds.slice(i, i + downloadBatchSize);
          const batchUrls = batchIds.map(id => `https://www.youtube.com/watch?v=${id}`);
          
          this.updateStatusUI(`${sub.title || sub.url}: 영상 다운로드 중 (${i+1}-${Math.min(i+downloadBatchSize, downloadedVideoIds.length)}/${downloadedVideoIds.length})`);
          
          const phase3Args = [
            "--ffmpeg-location", this.downloadManager.ffmpegPath,
            "-o", `${tempFolder}/%(id)s_%(title)s.%(ext)s`,
            "--progress",
            "--no-warnings",
            "--ignore-errors",  // 오류 무시하고 계속 진행
            "--newline",
            "--socket-timeout", "30",  // 소켓 타임아웃 설정 (초)
            "--retries", "1",          // 재시도 횟수 제한
            "--file-access-retries", "1" // 파일 액세스 재시도 제한
          ];
          // sourceAddress 옵션 적용
          if (sourceAddress) {
            phase3Args.unshift(sourceAddress);
            phase3Args.unshift('--source-address');
            console.log('Phase3 yt-dlp args with sourceAddress:', phase3Args);
          } else {
            console.log('Phase3 yt-dlp args:', phase3Args);
          }

          // 속도 제한 적용
          if (rateLimit > 0) {
            phase3Args.push("--limit-rate", `${rateLimit}K`);
          }

          // 포맷 및 품질 설정 추가
          if (sub.format === "mp3") {
            phase3Args.push("-x", "--audio-format", "mp3");
          } else if (sub.format === "best") {
            phase3Args.push("-f", "bv*+ba/b");
          } else {
            let formatString = sub.format;
            if (sub.quality) {
              formatString += `-${sub.quality}`;
            }
            phase3Args.push("-f", formatString);
          }

          // 배치 URL 추가
          phase3Args.push(...batchUrls);
          
          await new Promise((resolve) => {
            const phase3Process = spawn(this.downloadManager.ytDlpPath, phase3Args);
            
            phase3Process.stdout.on("data", (data) => {
              const output = data.toString();
              this.updateProgress(output);
              
              // 다운로드 완료된 파일 ID 추출 시도
              if (output.includes("[download] 100%")) {
                const downloadMatch = output.match(/\[download\] 100%.+Destination: .+\/([^_]+)_/);
                if (downloadMatch && downloadMatch[1]) {
                  successfullyDownloadedIds.push(downloadMatch[1]);
                  stats.downloadedVideos++;
                }
              }
            });
            
            phase3Process.stderr.on("data", (data) => {
              const errorMsg = data.toString();
              console.error("Download yt-dlp stderr:", errorMsg);
              
              // 오류 영상 ID 추출 시도
              const errorVideoMatch = errorMsg.match(/ERROR: \[youtube\] ([^:]+):/);
              if (errorVideoMatch && errorVideoMatch[1]) {
                stats.errorVideos++;
                this.updateStatusUI(`경고: 영상 다운로드 실패: ${errorVideoMatch[1]}`);
              }
            });
            
            phase3Process.on("close", () => {
              // 항상 resolve하여 계속 진행
              resolve();
            });
          });
        }
        
        // 모든 영상이 실패한 경우 체크
        if (successfullyDownloadedIds.length === 0 && downloadedVideoIds.length > 0) {
          this.updateStatusUI(`${sub.title || sub.url}: 모든 영상 다운로드에 실패했습니다.`);
        } else {
          console.log(`${sub.title || sub.url}: ${successfullyDownloadedIds.length}/${downloadedVideoIds.length}개 영상 다운로드 완료`);
        }
        
        // 기존 videoIds와 모든 시도한 영상 ID 병합 (성공한 것과 실패한 것 모두)
        sub.videoIds = Array.from(new Set([...sub.videoIds, ...downloadedVideoIds]));
        sub.lastCheck = Date.now();
        await this.saveSubscriptions();
        
        // 수집된 개별 메타데이터와 함께 파일 임포트
        await this.importAndRemoveDownloadedFiles(
          tempFolder, 
          sub.url, 
          playlistMetadata, 
          sub.folderName, 
          downloadedMetadata
        );
        
        return { 
          subscription: sub, 
          newVideos: stats.downloadedVideos, 
          skippedVideos: stats.skippedVideos,
          errorVideos: stats.errorVideos,
          stats,
          error: null 
        };
      } finally {
        // 임시 폴더 삭제 (오류가 발생해도 항상 실행)
        try {
          await fs.rm(tempFolder, { recursive: true, force: true });
          console.log(`임시 폴더 삭제됨: ${tempFolder}`);
        } catch (error) {
          console.error(`임시 폴더 삭제 실패: ${tempFolder}`, error);
        }
      }
    } catch (error) {
      console.error(
        `재생목록 확인 중 오류 발생 ${sub.title || sub.url}:`,
        error
      );
      this.updateStatusUI(
        `재생목록 확인 중 오류: ${sub.title || sub.url}: ${error.message}`
      );
      return { 
        subscription: sub, 
        newVideos: 0, 
        skippedVideos: stats.skippedVideos,
        errorVideos: stats.errorVideos,
        stats,
        error: error.message 
      };
    }
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
  async importAndRemoveDownloadedFiles(folder, url, metadata, customFolderName, videoMetadata = {}) {
    try {
      const files = await fs.readdir(folder);
      console.log("Files in directory:", files);

      // 폴더명 결정: customFolderName 우선, 없으면 fallback
      const folderName = customFolderName && customFolderName.trim() ? 
        customFolderName : (metadata.playlist || this.getPlaylistId(url) || "Default Playlist");

      // 먼저 기존에 동일 이름의 폴더가 있는지 검색 (keyword대신 name으로 정확히 매칭)
      let playlistFolderId = null;
      console.log(`Looking for existing folder: "${folderName}"`);
      
      try {
        // 정확한 이름으로 폴더 검색 (Eagle API의 keyword 대신 정확한 이름 비교)
        const allFolders = await eagle.folder.getAll();
        console.log(`Total folders: ${allFolders.length}`);
        
        // 이름이 정확히 일치하는 폴더 찾기
        const exactMatchFolders = allFolders.filter(f => f.name === folderName);
        console.log(`Found ${exactMatchFolders.length} folders with exact name match: "${folderName}"`);
        
        if (exactMatchFolders.length > 0) {
          // 이미 존재하는 폴더 재사용 (여러 개 있으면 첫 번째 것 사용)
          playlistFolderId = exactMatchFolders[0].id;
          console.log(`Using existing folder: "${folderName}" (ID: ${playlistFolderId})`);
        } else {
          // 일치하는 폴더가 없으면 새로 생성
          try {
            const newFolder = await eagle.folder.create({ name: folderName });
            playlistFolderId = newFolder.id;
            console.log(`Created new folder: "${folderName}" (ID: ${playlistFolderId})`);
          } catch (createError) {
            // 혹시 생성 중에 오류가 발생하면, 다시 검색하여 마지막으로 생성됐을 가능성 있는 폴더 찾기
            if (createError.message.includes("already exists")) {
              const updatedFolders = await eagle.folder.getAll();
              const newExactMatchFolders = updatedFolders.filter(f => f.name === folderName);
              if (newExactMatchFolders.length > 0) {
                playlistFolderId = newExactMatchFolders[0].id;
                console.log(`Using newly found folder: "${folderName}" (ID: ${playlistFolderId})`);
              }
            } else {
              throw createError;
            }
          }
        }
        
        if (!playlistFolderId) {
          console.error(`Failed to create or find folder: "${folderName}"`);
        }
      } catch (error) {
        console.error(`Error in folder operations:`, error);
        throw error;
      }

      // 파일 추가
      for (const file of files) {
        // .txt 파일 건너뛰기 (여전히 임시 파일이 있을 경우 대비)
        if (file.endsWith(".txt")) continue;
        
        const filePath = path.join(folder, file);
        try {
          const fileStat = await fs.stat(filePath);
          if (fileStat.isFile()) {
            // 파일명에서 videoId 추출: 언더바(_)가 포함된 ID도 정확히 처리
            let videoId = null;
            let currentMetadata = metadata; // 기본 메타데이터
            // videoMetadata 매핑에 기반하여 파일명이 해당 ID로 시작하는지 확인
            if (videoMetadata) {
              for (const id of Object.keys(videoMetadata)) {
                if (file.startsWith(`${id}_`)) {
                  videoId = id;
                  currentMetadata = videoMetadata[id];
                  break;
                }
              }
            }
            // videoMetadata에서 찾지 못한 경우 YouTube ID 길이(11) 기반으로 추출
            if (!videoId) {
              // URL에서 video ID 추출 시도
              const urlMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
              videoId = urlMatch ? urlMatch[1] : null;
              if (videoMetadata && videoMetadata[videoId]) {
                currentMetadata = videoMetadata[videoId];
              }
            }
            // 파일 제목: "{videoId}_제목"에서 ID 부분 제거
            let videoTitle = path.basename(file, path.extname(file));
            if (videoTitle.startsWith(`${videoId}_`)) {
              videoTitle = videoTitle.substring(videoId.length + 1);
            }

            // 제목 앞에 업로드 날짜를 붙이도록 설정된 경우 처리
            let displayName = videoTitle;
            if (this.prefixUploadDate && currentMetadata.upload_date) {
              displayName = currentMetadata.upload_date + ' ' + videoTitle;
            }
            const fileMetadata = {
              name: displayName,
              website: videoId ? `https://www.youtube.com/watch?v=${videoId}` : url,
              annotation: `Video ID: ${videoId || 'N/A'}
Upload Date: ${currentMetadata.upload_date || "N/A"}
Views: ${currentMetadata.view_count || "N/A"}`,
              tags: [
                `Platform: ${url.includes("youtube.com") || url.includes("youtu.be") ? "youtube.com" : new URL(url).hostname}`,
                `Playlist: ${folderName}`,
                `Channel: ${currentMetadata.uploader || "N/A"}`
              ].filter(Boolean), // null 값 필터링
              folders: playlistFolderId ? [playlistFolderId] : []
            };

            // Eagle 라이브러리에 추가
            try {
              const item = await eagle.item.addFromPath(filePath, fileMetadata);
              console.log(`Added ${file} to Eagle`, item);
              this.emit('videoAdded', { file, metadata: fileMetadata });
            } catch (addError) {
              if (addError.message.includes("Item already exists")) {
                console.log(`${file} already exists in Eagle library. Adding to folder.`);
                
                // URL로 아이템 검색 (videoId가 있으면 개별 영상 URL, 없으면 재생목록 URL)
                const searchURL = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
                const items = await eagle.item.get({ website: searchURL });
                
                if (items.length > 0) {
                  const item = items[0];
                  let newFolders = item.folders || [];
                  if (playlistFolderId && !newFolders.includes(playlistFolderId)) {
                    newFolders.push(playlistFolderId);
                  }
                  await eagle.item.modify(item.id, { folders: newFolders });
                  console.log(`Updated item ${item.id} to include folder ${playlistFolderId}`);
                } else {
                  console.error(`Failed to find item with URL ${searchURL}`);
                }
              } else {
                throw addError;
              }
            }

            // 처리 완료된 파일 삭제
            await fs.unlink(filePath);
            console.log(`Removed ${file} from downloads folder`);
          }
        } catch (error) {
          console.error(`Error adding or removing file ${file}:`, error);
        }
      }
    } catch (error) {
      console.error("Error reading or deleting files in directory:", error);
    }
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
    this.checkInterval = null; // 주기적 확인 인터벌
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