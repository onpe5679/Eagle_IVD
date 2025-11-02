/**
 * 다운로드 관리 모듈
 * YouTube 비디오 다운로드 처리 담당
 */

const { spawn } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const utils = require("./utils");
const EventEmitter = require('events');
const { VideoDownloadQueue, VideoStatus } = require('./video-download-queue');

/**
 * 다운로드 관리 클래스
 */
class DownloadManager extends EventEmitter {
  /**
   * 다운로드 관리자 초기화
   * @param {string} pluginPath - 플러그인 경로
   */
  constructor(pluginPath) {
    super();
    this.downloadFolder = path.join(pluginPath, "downloads");
    this.isDownloading = false;
    this.currentProcess = null;
    this.ytDlpPath = process.platform === "win32"
      ? path.join(pluginPath, "yt-dlp.exe")
      : path.join(pluginPath, "yt-dlp");
    this.ffmpegPath = null;
    this.activeDownloads = new Map();
    
    // 새로운 큐 시스템
    this.downloadQueue = null;
    this.useQueueSystem = true; // 큐 시스템 사용 여부
  }

  /**
   * 다운로드 관리자 초기화
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      this.ffmpegPath = await utils.getFFmpegPath();
      await this.initializeFolder();
      
      // 새로운 큐 시스템 초기화
      if (this.useQueueSystem) {
        this.initializeQueue();
      }
    } catch (error) {
      console.error("Failed to initialize download manager:", error);
      this.updateStatusUI(`Error: Failed to initialize. ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 다운로드 큐 초기화 및 이벤트 핸들러 설정
   */
  initializeQueue() {
    this.downloadQueue = new VideoDownloadQueue(this);
    
    // 큐 이벤트 리스너 설정
    this.downloadQueue.on('queueStarted', () => {
      this.updateStatusUI('Download queue started');
      this.emit('queueStarted');
    });
    
    this.downloadQueue.on('queueStopped', () => {
      this.updateStatusUI('Download queue stopped');
      this.emit('queueStopped');
    });
    
    this.downloadQueue.on('queueCompleted', (stats) => {
      this.updateStatusUI(`Queue completed: ${stats.completed}/${stats.total} downloads successful`);
      this.emit('queueCompleted', stats);
    });
    
    this.downloadQueue.on('videoStarted', (videoItem) => {
      this.updateStatusUI(`Starting: ${videoItem.title}`);
      this.emit('videoStarted', videoItem);
    });
    
    this.downloadQueue.on('videoProgress', (videoItem) => {
      // UI 업데이트를 verbose 처리 (10% 단위로만)
      const progressInt = Math.floor(videoItem.progress);
      if ((progressInt % 10 === 0 && progressInt !== videoItem.lastUIUpdateProgress) || 
          (videoItem.progress === 100 && videoItem.lastUIUpdateProgress !== 100)) {
        this.updateStatusUI(`${videoItem.title}: ${progressInt}%`);
        videoItem.lastUIUpdateProgress = progressInt;
      }
      this.emit('videoProgress', videoItem);
    });
    
    this.downloadQueue.on('videoCompleted', (videoItem) => {
      this.updateStatusUI(`Completed: ${videoItem.title}`);
      this.emit('videoCompleted', videoItem);
    });
    
    this.downloadQueue.on('videoFailed', (videoItem) => {
      this.updateStatusUI(`Failed: ${videoItem.title} - ${videoItem.errorMessage}`);
      this.emit('videoFailed', videoItem);
    });
    
    this.downloadQueue.on('videoImported', (videoItem) => {
      this.updateStatusUI(`Imported to Eagle: ${videoItem.title}`);
      this.emit('videoImported', videoItem);
    });
    
    this.downloadQueue.on('queueProgress', (stats) => {
      this.emit('queueProgress', stats);
    });
    
    console.log('Download queue initialized');
  }
  
  /**
   * UI 설정값을 읽어서 큐에 적용
   */
  applyUISettings() {
    if (!this.downloadQueue) return;
    
    try {
      // 동시 다운로드 수 (downloadBatchSize)
      const downloadBatchSize = parseInt(document.getElementById('downloadBatchSize')?.value) || 3;
      this.downloadQueue.setMaxConcurrent(downloadBatchSize);
      
      // 속도 제한 (rateLimit)
      const rateLimit = parseInt(document.getElementById('rateLimit')?.value) || 0;
      this.downloadQueue.setRateLimit(rateLimit);
      
      console.log(`UI settings applied - Concurrent: ${downloadBatchSize}, Rate limit: ${rateLimit} KB/s`);
    } catch (error) {
      console.error('Failed to apply UI settings:', error);
    }
  }

  /**
   * 다운로드 폴더 초기화 (이전 파일들 정리 포함)
   * @returns {Promise<void>}
   */
  async initializeFolder() {
    try {
      await fs.mkdir(this.downloadFolder, { recursive: true });
      
      // 플러그인 시작 시 downloads 폴더의 이전 파일들 정리
      try {
        const files = await fs.readdir(this.downloadFolder);
        if (files.length > 0) {
          console.log(`[Cleanup] Cleaning up ${files.length} files from downloads folder`);
          for (const file of files) {
            const filePath = path.join(this.downloadFolder, file);
            try {
              await fs.unlink(filePath);
              console.log(`[Cleanup] Removed: ${file}`);
            } catch (unlinkError) {
              console.warn(`[Cleanup] Failed to remove ${file}:`, unlinkError);
            }
          }
          console.log("[Cleanup] Downloads folder cleanup completed");
        }
      } catch (cleanupError) {
        console.warn("[Cleanup] Failed to clean downloads folder:", cleanupError);
      }
      
      console.log("Download folder ready:", this.downloadFolder);
    } catch (error) {
      console.error("Failed to create download folder:", error);
      throw error;
    }
  }

  /**
   * 다운로드 시작
   * @param {string} url - 다운로드할 URL
   * @param {string} format - 다운로드 포맷
   * @param {string} quality - 다운로드 품질
   * @param {number} speedLimit - 속도 제한 (KB/s)
   * @param {number} concurrency - 동시 다운로드 수
   * @returns {Promise} - 다운로드 완료 프로미스
   */
  startDownload(url, format, quality, speedLimit, concurrency) {
    return new Promise((resolve, reject) => {
      // 다운로드 중인지 확인
      if (this.currentProcess) {
        reject(new Error("Download already in progress"));
        return;
      }

      try {
        this.cancelled = false;
        // 명령어 구성
        const command = this.buildCommand(
          url,
          format,
          quality,
          speedLimit,
          concurrency
        );

        // 직접 명령어 미리보기 업데이트 (순환 호출 방지)
        const commandPreview = document.getElementById("commandPreview");
        const commandPreviewArea = document.getElementById("commandPreviewArea");
        
        if (commandPreview) {
          commandPreview.textContent = command;
        }
        
        if (commandPreviewArea) {
          commandPreviewArea.classList.remove("hidden");
        }
        
        // 로그에 명령어 추가
        console.log("실행 명령어:", command);

        // 자식 프로세스 시작 전에 카운터와 콜스택 문제 방지를 위한 조치
        let statusUpdateCount = 0;
        const MAX_STATUS_UPDATES = 1000; // 최대 상태 업데이트 횟수 제한

        // 자식 프로세스 시작
        const childProcess = require("child_process");
        this.currentProcess = childProcess.exec(
          command,
          { maxBuffer: 1024 * 1024 * 10 }, // 10MB 버퍼 크기
          (error, stdout, stderr) => {
            this.currentProcess = null;

            if (this.cancelled) {
              reject(new Error("Download was cancelled"));
              return;
            }

            if (error) {
              // PhantomJS 관련 오류 처리
              if (stderr && stderr.includes && (stderr.includes('PhantomJS') && stderr.includes('formats may be missing'))) {
                const errorMessage = "다운로드에 필요한 PhantomJS가 없습니다. https://phantomjs.org/download.html 에서 다운로드하세요.";
                console.error(errorMessage);
                if (window.updateUI) {
                  window.updateUI(errorMessage);
                }
                reject(new Error(errorMessage));
                return;
              }

              // 명령어 관련 오류 처리
              if (error.message && error.message.includes("this.buildCommand is not a function")) {
                const errorMessage = "다운로드 명령어 구성에 실패했습니다. 개발자에게 문의하세요.";
                console.error(errorMessage);
                if (window.updateUI) {
                  window.updateUI(errorMessage);
                }
                reject(new Error(errorMessage));
                return;
              }

              console.error(`Download failed: ${error.message}`);
              console.error(`stderr: ${stderr}`);
              reject(error);
              return;
            }

            console.log("Download completed successfully");
            resolve(stdout);
          }
        );

        // 프로세스 출력 처리
        this.currentProcess.stdout.on("data", (data) => {
          console.log(`stdout: ${data}`);
          // 상태 업데이트 제한
          if (statusUpdateCount < MAX_STATUS_UPDATES) {
            statusUpdateCount++;
            if (window.updateUI) {
              // 진행 상태 파싱 시도
              const progressMatch = data.toString().match(/\[download\]\s+(\d+\.?\d*)%/);
              if (progressMatch) {
                window.updateUI(`다운로드 진행률: ${progressMatch[1]}%`);
              } else {
                window.updateUI(`다운로드 정보: ${data}`);
              }
            }
          }
        });

        this.currentProcess.stderr.on("data", (data) => {
          console.log(`stderr: ${data}`);
          // PhantomJS 오류 무시
          const dataStr = data.toString();
          if (dataStr.includes('PhantomJS') && dataStr.includes('formats may be missing')) {
            console.log("PhantomJS 관련 경고 메시지입니다. 다운로드는 계속됩니다.");
            return;
          }
          
          // 상태 업데이트 제한
          if (statusUpdateCount < MAX_STATUS_UPDATES) {
            statusUpdateCount++;
            if (window.updateUI && !dataStr.includes("[download]")) {
              window.updateUI(`다운로드 정보: ${dataStr}`);
            }
          }
        });
      } catch (error) {
        this.currentProcess = null;
        console.error("Failed to start download:", error);
        reject(error);
      }
    });
  }

  /**
   * yt-dlp 인수 구성
   * @param {string} url - 다운로드할 URL
   * @param {string} format - 비디오 포맷
   * @param {string} quality - 비디오 품질
   * @param {number} speedLimit - 다운로드 속도 제한
   * @param {number} concurrency - 동시 다운로드 수
   * @param {string} tempFolder - 임시 다운로드 폴더
   * @returns {Array<string>} 명령줄 인수 배열
   */
  constructArgs(url, format, quality, speedLimit, concurrency, tempFolder) {
    const formatArgs = this.getFormatArgs(format, quality);
    const baseArgs = [
      "--ffmpeg-location",
      this.ffmpegPath,
      "-o",
      path.join(tempFolder, "%(title)s.%(ext)s"),
      "--progress",
      "--no-warnings",
      "--no-check-formats",
      "--force-ipv4",
      "--socket-timeout", "15",
      "--retries", "1",
      "--file-access-retries", "1",
      "--newline",
      url,
    ];

    if (concurrency && concurrency > 1) {
      baseArgs.push("-N", concurrency.toString());
    }
    if (speedLimit) {
      baseArgs.push("--limit-rate", `${speedLimit}K`);
    }

    return [...formatArgs, ...baseArgs];
  }

  /**
   * 포맷 인수 구성
   * @param {string} format - 비디오 포맷
   * @param {string} quality - 비디오 품질
   * @returns {Array<string>} 포맷 관련 인수 배열
   */
  getFormatArgs(format, quality) {
    if (format === "best") {
      return ["-f", "bv*+ba/b"];
    }

    if (format === "mp3") {
      return ["-x", "--audio-format", "mp3"];
    }

    let formatString = format;
    if (quality) {
      formatString += `-${quality}`;
    }

    return ["-f", formatString];
  }

  /**
   * yt-dlp 명령어 구성
   * @param {string} url - 다운로드할 URL
   * @param {string} format - 비디오 포맷
   * @param {string} quality - 비디오 품질
   * @param {number} speedLimit - 다운로드 속도 제한
   * @param {number} concurrency - 동시 다운로드 수
   * @returns {string} 실행할 명령어
   */
  buildCommand(url, format, quality, speedLimit, concurrency) {
    // 포맷 처리
    let formatOption = "";
    if (format === "best") {
      formatOption = "-f bv*+ba/b";
    } else if (format === "mp3") {
      formatOption = "-x --audio-format mp3";
    } else {
      let formatString = format;
      if (quality) {
        formatString += `-${quality}`;
      }
      formatOption = `-f ${formatString}`;
    }

    // 기본 명령어 구성 (+ 안정화 플래그 적용)
    let command = `"${this.ytDlpPath}" ${formatOption} --ffmpeg-location "${this.ffmpegPath}" -o "${path.join(this.downloadFolder, '%(title)s.%(ext)s')}" --progress --newline --no-warnings --no-check-formats --force-ipv4 --socket-timeout 15 --retries 1 --file-access-retries 1`;

    // 추가 옵션
    if (concurrency && concurrency > 1) {
      command += ` -N ${concurrency}`;
    }
    if (speedLimit) {
      command += ` --limit-rate ${speedLimit}K`;
    }

    // URL 추가
    command += ` "${url}"`;

    console.log("생성된 명령어:", command);
    return command;
  }

  /**
   * 개별 영상 다운로드 (새로운 큐 시스템 사용)
   * @param {string} url - 영상 URL
   * @param {string} format - 다운로드 포맷
   * @param {string} quality - 다운로드 품질
   * @param {Object} options - 추가 옵션 (sourceAddress, userAgent, cookieFile 등)
   * @returns {Promise} - 다운로드 완료 프로미스
   */
  async startVideoDownload(url, format = 'best', quality = '', options = {}) {
    if (!this.downloadQueue) {
      throw new Error('Queue system not initialized');
    }
    
    const settings = {
      format,
      quality,
      folderName: options.folderName || 'Single Videos',
      sourceAddress: options.sourceAddress || '',
      userAgent: options.userAgent || '',
      cookieFile: options.cookieFile || ''
    };
    
    await this.downloadQueue.addVideoToQueue(url, settings);
    
    if (!this.downloadQueue.isRunning) {
      this.downloadQueue.start();
    }
    
    return new Promise((resolve, reject) => {
      const handleComplete = (stats) => {
        this.downloadQueue.removeListener('queueCompleted', handleComplete);
        this.downloadQueue.removeListener('videoFailed', handleFailed);
        resolve(stats);
      };
      
      const handleFailed = (videoItem) => {
        if (videoItem.url === url && !videoItem.canRetry()) {
          this.downloadQueue.removeListener('queueCompleted', handleComplete);
          this.downloadQueue.removeListener('videoFailed', handleFailed);
          reject(new Error(videoItem.errorMessage));
        }
      };
      
      this.downloadQueue.on('queueCompleted', handleComplete);
      this.downloadQueue.on('videoFailed', handleFailed);
    });
  }
  
  /**
   * 재생목록 다운로드 (새로운 큐 시스템 사용)
   * @param {string} url - 재생목록 URL
   * @param {string} format - 다운로드 포맷
   * @param {string} quality - 다운로드 품질
   * @param {Object} options - 추가 옵션
   * @returns {Promise} - 다운로드 완료 프로미스
   */
  async startPlaylistDownload(url, format = 'best', quality = '', options = {}) {
    if (!this.downloadQueue) {
      throw new Error('Queue system not initialized');
    }
    
    // 동시 다운로드 수 설정
    if (options.maxConcurrent) {
      this.downloadQueue.setMaxConcurrent(options.maxConcurrent);
    }
    
    const playlistSettings = {
      format,
      quality,
      folderName: options.folderName,
      sourceAddress: options.sourceAddress || '',
      userAgent: options.userAgent || '',
      cookieFile: options.cookieFile || ''
    };
    
    const addedCount = await this.downloadQueue.addPlaylistToQueue(url, playlistSettings);
    
    if (!this.downloadQueue.isRunning) {
      this.downloadQueue.start();
    }
    
    return new Promise((resolve, reject) => {
      const handleComplete = (stats) => {
        this.downloadQueue.removeListener('queueCompleted', handleComplete);
        resolve({ ...stats, totalAdded: addedCount });
      };
      
      this.downloadQueue.on('queueCompleted', handleComplete);
    });
  }
  
  /**
   * 큐에 여러 재생목록 추가
   * @param {Array} playlists - 재생목록 배열 [{url, format, quality, folderName, ...}, ...]
   * @param {Object} globalOptions - 전역 옵션
   * @returns {Promise<number>} 총 추가된 영상 수
   */
  async startMultiplePlaylistsDownload(playlists, globalOptions = {}) {
    if (!this.downloadQueue) {
      throw new Error('Queue system not initialized');
    }
    
    // 동시 다운로드 수 설정
    if (globalOptions.maxConcurrent) {
      this.downloadQueue.setMaxConcurrent(globalOptions.maxConcurrent);
    }
    
    let totalAdded = 0;
    
    for (const playlist of playlists) {
      try {
        const playlistSettings = {
          format: playlist.format || 'best',
          quality: playlist.quality || '',
          folderName: playlist.folderName,
          sourceAddress: playlist.sourceAddress || globalOptions.sourceAddress || '',
          userAgent: playlist.userAgent || globalOptions.userAgent || '',
          cookieFile: playlist.cookieFile || globalOptions.cookieFile || ''
        };
        
        const addedCount = await this.downloadQueue.addPlaylistToQueue(playlist.url, playlistSettings);
        totalAdded += addedCount;
        
        this.updateStatusUI(`Added ${addedCount} videos from playlist: ${playlistSettings.folderName || 'Unknown'}`);
      } catch (error) {
        console.error(`Failed to add playlist ${playlist.url}:`, error);
        this.updateStatusUI(`Failed to add playlist: ${error.message}`);
      }
    }
    
    if (!this.downloadQueue.isRunning) {
      this.downloadQueue.start();
    }
    
    return totalAdded;
  }
  
  /**
   * 다운로드 취소
   */
  cancel() {
    // 기존 방식 취소
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.isDownloading = false;
      this.currentProcess = null;
      this.updateStatusUI("Download cancelled");
    }
    
    // 큐 시스템 취소
    if (this.downloadQueue && this.downloadQueue.isRunning) {
      this.downloadQueue.stop();
      this.updateStatusUI("Queue stopped");
    }
  }
  
  /**
   * 큐 상태 반환
   * @returns {Object} 큐 통계 정보
   */
  getQueueStatus() {
    if (!this.downloadQueue) {
      return null;
    }
    
    return {
      stats: this.downloadQueue.getQueueStats(),
      items: this.downloadQueue.getQueueItems(),
      isRunning: this.downloadQueue.isRunning
    };
  }
  
  /**
   * 특정 영상 제거
   * @param {string} videoId - 제거할 영상 ID
   */
  removeVideoFromQueue(videoId) {
    if (this.downloadQueue) {
      this.downloadQueue.removeVideo(videoId);
    }
  }
  
  /**
   * 큐 초기화
   */
  clearQueue() {
    if (this.downloadQueue) {
      this.downloadQueue.clearQueue();
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
    if (match) {
      const progress = match[1];
      const fileSize = match[2];
      const speed = match[3];
      const eta = match[4];
      this.updateStatusUI(
        `Progress: ${progress}%, Size: ${fileSize}, Speed: ${speed}, ETA: ${eta}`
      );
    } else {
      this.updateStatusUI(output);
    }
  }

  /**
   * 명령어 미리보기 업데이트
   * @param {string} ytDlpPath - yt-dlp 경로
   * @param {Array<string>} args - 명령줄 인수
   */
  updateCommandPreview(ytDlpPath, args) {
    const command = `${ytDlpPath} ${args.join(" ")}`;
    // 직접 명령어 미리보기 영역 업데이트 (순환 호출 방지)
    const commandPreview = document.getElementById("commandPreview");
    const commandPreviewArea = document.getElementById("commandPreviewArea");
    
    if (commandPreview) {
      commandPreview.textContent = command;
    }
    
    if (commandPreviewArea) {
      commandPreviewArea.classList.remove("hidden");
    }
    
    // 로그에 명령어 추가
    console.log("실행 명령어:", command);
  }

  /**
   * UI 상태 업데이트
   * @param {string} message - 상태 메시지
   */
  updateStatusUI(message) {
    console.log("updateUI called with message:", message);
    if (window.updateUI) {
      window.updateUI(message);
    }
    // 이벤트 발생
    this.emit('statusUpdate', message);
  }

  /**
   * 비디오 메타데이터 가져오기
   * @param {string} url - 비디오 URL
   * @returns {Promise<Object>} 메타데이터 객체
   */
  async getMetadata(url) {
    const args = [
      "--ffmpeg-location",
      this.ffmpegPath,
      "--print-json",
      "--no-warnings",
      "--no-check-formats",
      "--force-ipv4",
      "--socket-timeout", "15",
      "--retries", "1",
      "--file-access-retries", "1",
      "--skip-download",
      "--flat-playlist",
      "--playlist-end",
      "1",
      url,
    ];

    return new Promise((resolve, reject) => {
      let metadata = "";
      const process = spawn(this.ytDlpPath, args);

      process.stdout.on("data", (data) => {
        metadata += data.toString();
      });

      process.stderr.on("data", (data) => {
        console.error("yt-dlp stderr:", data.toString());
      });

      process.on("close", (code) => {
        if (code === 0) {
          try {
            const parsedMetadata = JSON.parse(metadata);
            resolve(parsedMetadata);
          } catch (error) {
            console.error("Failed to parse metadata:", error);
            console.log("Raw metadata:", metadata);
            reject(
              new Error(`Failed to parse metadata: ${error.message}`)
            );
          }
        } else {
          reject(new Error(`yt-dlp exited with code ${code}`));
        }
      });
    });
  }

  /**
   * 재생목록 메타데이터 가져오기
   * @param {string} url - 재생목록 URL
   * @returns {Promise<Array<Object>>} 메타데이터 배열
   */
  async getPlaylistMetadata(url) {
    return new Promise((resolve, reject) => {
      const args = [
        "--flat-playlist",
        "--print-json",
        "--no-warnings",
        "--no-check-formats",
        "--force-ipv4",
        "--socket-timeout", "15",
        "--retries", "1",
        "--file-access-retries", "1",
        "--no-download",
        url,
      ];
      let allOutput = "";
      const proc = spawn(this.ytDlpPath, args, { cwd: this.downloadFolder });

      proc.stdout.on("data", (data) => {
        allOutput += data.toString();
      });
      proc.stderr.on("data", (err) => {
        console.error("yt-dlp stderr:", err.toString());
      });
      proc.on("close", (code) => {
        if (code === 0) {
          try {
            const lines = allOutput.split("\n").filter(Boolean);
            const results = lines.map((line) => JSON.parse(line));
            resolve(results);
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`getPlaylistMetadata exited with code ${code}`));
        }
      });
    });
  }
}

// 모듈 내보내기
module.exports = DownloadManager;
