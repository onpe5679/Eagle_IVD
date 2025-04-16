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
   * @returns {Promise<void>}
   */
  async checkAllSubscriptions(progressCallback) {
    if (this.isChecking) {
      console.log("Already checking subscriptions. Please wait.");
      return;
    }

    console.log("Checking for new videos in subscribed playlists...");
    this.isChecking = true;
    const total = this.subscriptions.length;
    let current = 0;

    try {
      for (const sub of this.subscriptions) {
        if (!this.isChecking) {
          console.log("Cancelled checkAllSubscriptions");
          return;
        }
        current++;

        const playlistId = this.getPlaylistId(sub.url);
        const tempFolder = path.join(
          this.downloadManager.downloadFolder,
          "subscription_" + playlistId
        );

        try {
          // 폴더 생성 시도
          await fs.mkdir(tempFolder, { recursive: true });
          console.log(`Temp folder created or already exists: ${tempFolder}`);

          if (progressCallback) {
            progressCallback(
              current,
              total,
              `Checking playlist: ${sub.title || sub.url}`
            );
          }

          // Phase 1: 재생목록의 전체 영상 ID와 메타데이터 조회 (다운로드 없이)
          const phase1Args = [
            "--skip-download",
            "--print-json",
            sub.url
          ];
          let fetchedVideoIds = [];
          let playlistMetadata = null;
          await new Promise((resolve, reject) => {
            const phase1Process = spawn(this.downloadManager.ytDlpPath, phase1Args);
            phase1Process.stdout.on("data", (data) => {
              const lines = data.toString().split("\n").filter(line => line.trim());
              lines.forEach(line => {
                try {
                  const item = JSON.parse(line);
                  if (!playlistMetadata) {
                    playlistMetadata = item;
                  }
                  if (item.id) {
                    fetchedVideoIds.push(item.id);
                  }
                } catch (e) {
                  console.error("Phase1 JSON parse error:", e);
                }
              });
            });
            phase1Process.stderr.on("data", (data) => {
              console.error("Phase1 yt-dlp stderr:", data.toString());
            });
            phase1Process.on("close", (code) => {
              if (code === 0 || code === null) {
                resolve();
              } else {
                reject(new Error(`Phase1: yt-dlp exited with code ${code}`));
              }
            });
          });

          const newVideoIds = fetchedVideoIds.filter(id => !sub.videoIds.includes(id));
          if (newVideoIds.length === 0) {
            this.updateStatusUI(`No new videos found in playlist ${sub.title || sub.url}`);
            continue; // 다음 구독으로 넘어감
          }

          // Phase 2: 새 영상만 다운로드하도록 기존 videoIds와 다른 ID 필터링
          // 새 영상 ID만 포함하는 URL 생성
          const videoUrls = newVideoIds.map(id => `https://www.youtube.com/watch?v=${id}`);
          
          const phase2Args = [
            "--ffmpeg-location", this.downloadManager.ffmpegPath,
            "--print-json",
            "-o", `${tempFolder}/%(id)s_%(title)s.%(ext)s`,
            "--progress",
            "--no-warnings",
            "--newline"
          ];

          // 포맷 및 품질 설정 추가
          if (sub.format === "mp3") {
            phase2Args.push("-x", "--audio-format", "mp3");
          } else if (sub.format === "best") {
            phase2Args.push("-f", "bv*+ba/b");
          } else {
            let formatString = sub.format;
            if (sub.quality) {
              formatString += `-${sub.quality}`;
            }
            phase2Args.push("-f", formatString);
          }

          // 각 영상 URL을 phase2Args에 추가
          phase2Args.push(...videoUrls);
          
          let downloadedVideoIds = [];
          let downloadedMetadata = {};
          
          await new Promise((resolve, reject) => {
            const phase2Process = spawn(this.downloadManager.ytDlpPath, phase2Args);
            phase2Process.stdout.on("data", (data) => {
              const lines = data.toString().split("\n").filter(line => line.trim());
              lines.forEach(line => {
                try {
                  if (line.startsWith("{")) {
                    const item = JSON.parse(line);
                    if (item.id && !downloadedVideoIds.includes(item.id)) {
                      downloadedVideoIds.push(item.id);
                      downloadedMetadata[item.id] = item; // 메타데이터 저장
                    }
                  }
                } catch (e) {
                  console.error("Phase2 JSON parse error:", e);
                }
              });
              this.updateProgress(data.toString());
            });
            
            phase2Process.stderr.on("data", (data) => {
              console.error("Phase2 yt-dlp stderr:", data.toString());
              this.updateStatusUI(`Error: ${data.toString().trim()}`);
            });
            
            phase2Process.on("close", async (code) => {
              if (code === 0 || code === null) {
                console.log(`Finished downloading new videos for playlist: ${sub.title || sub.url}`);
                
                // 기존 videoIds와 새로 다운로드된 영상 ID 병합
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
                resolve();
              } else {
                reject(new Error(`Phase2: yt-dlp exited with code ${code}`));
              }
            });
          });
        } catch (error) {
          console.error(
            `Error checking for new videos in playlist ${
              sub.title || sub.url
            }:`,
            error
          );
          this.updateStatusUI(
            `Error checking playlist ${sub.title || sub.url}: ${error.message}`
          );
        } finally {
          // 임시 폴더 삭제 시도
          try {
            await fs.rm(tempFolder, { recursive: true, force: true });
            console.log(`Removed temp folder: ${tempFolder}`);
          } catch (error) {
            console.error(`Failed to remove temp folder: ${tempFolder}`, error);
          }
        }
      }
    } finally {
      this.isChecking = false;
      console.log("Finished checking all subscriptions.");
      this.emit('checkComplete');
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
      
      // ID 기반 태그 검색 (태그에 videoId가 있는지)
      if (videoId) {
        const itemsByTag = await eagle.item.get({ 
          tags: [`videoId:${videoId}`] 
        });
        
        return itemsByTag.length > 0;
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
            // 파일명에서 videoId 추출 (형식: "{id}_{title}.{ext}")
            let videoId = null;
            let currentMetadata = metadata; // 기본값은 플레이리스트 메타데이터
            
            // 파일명에서 영상 ID 추출 시도
            const idMatch = file.match(/^([^_]+)_/);
            if (idMatch && idMatch[1]) {
              videoId = idMatch[1];
              if (videoMetadata && videoMetadata[videoId]) {
                // 개별 영상의 메타데이터가 있으면 사용
                currentMetadata = videoMetadata[videoId];
              }
            }
            
            // 비디오 제목 (ID_ 부분 제거)
            let videoTitle = path.basename(file, path.extname(file));
            if (videoId) {
              videoTitle = videoTitle.replace(`${videoId}_`, '');
            }

            // 각 영상별 고유 메타데이터로 파일 메타데이터 준비
            const fileMetadata = {
              name: videoTitle,
              website: videoId ? `https://www.youtube.com/watch?v=${videoId}` : url,
              annotation: `Upload Date: ${currentMetadata.upload_date || "N/A"}\nViews: ${currentMetadata.view_count || "N/A"}`,
              tags: [
                `Platform: ${url.includes("youtube.com") || url.includes("youtu.be") ? "youtube.com" : new URL(url).hostname}`,
                `Playlist: ${folderName}`,
                `Channel: ${currentMetadata.uploader || "N/A"}`,
                videoId ? `videoId:${videoId}` : null // 영상 ID를 태그로 추가 (중복 확인용)
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