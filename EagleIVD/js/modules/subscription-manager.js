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
      lastCheckedVideoId: null,
      title: "",
      lastCheck: null
    };

    // 구독 정보를 가져오는 부분
    try {
      const metadata = await this.downloadManager.getMetadata(url);
      if (metadata) {
        newSub.title = metadata.playlist_title || metadata.playlist || this.getPlaylistId(url);
        // 구독 추가 시 비디오 ID를 가져오는 부분 수정
        if (metadata.entries && metadata.entries.length > 0) {
          newSub.lastCheckedVideoId = metadata.entries[0].id; // 첫 번째 비디오를 사용
        } else {
          // 비디오가 없는 경우 비디오 ID를 null로 설정
          newSub.lastCheckedVideoId = null;
        }
      }
    } catch (error) {
      console.error("Error fetching playlist metadata:", error);
      // 메타데이터를 가져오는 데 실패한 경우에도 기본적인 정보로 구독을 추가
      newSub.title = url; // URL을 타이틀로 사용하거나, 다른 기본값을 설정
      newSub.lastCheckedVideoId = null; // 비디오 ID를 null로 설정
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

          // 이전 lastCheckedVideoId 확인
          const lastCheckedVideoId = sub.lastCheckedVideoId;

          // 기본 인수 설정
          const args = [
            "--ffmpeg-location",
            this.downloadManager.ffmpegPath,
            "-o",
            `${tempFolder}/%(title)s.%(ext)s`,
            "--progress",
            "--no-warnings",
            "--newline",
            "--print-json", // JSON 형식의 출력을 위해 추가
          ];

          // 포맷 및 품질 설정 추가
          if (sub.format === "mp3") {
            args.push("-x", "--audio-format", "mp3");
          } else if (sub.format === "best") {
            args.push("-f", "bv*+ba/b");
          } else {
            let formatString = sub.format;
            if (sub.quality) {
              formatString += `-${sub.quality}`;
            }
            args.push("-f", formatString);
          }
          
          // 최종 URL 추가
          args.push(sub.url);

          const { updated, metadata } = await new Promise(
            (resolve, reject) => {
              let updated = false;
              let latestVideoId = null;
              let metadata = null;
              let firstVideo = true;
              let skipExisting = !!lastCheckedVideoId;
              const currentProcess = spawn(this.downloadManager.ytDlpPath, args);

              currentProcess.stdout.on("data", (data) => {
                const output = data.toString();
                console.log("yt-dlp stdout:", output);

                // JSON 형식의 메타데이터 파싱 시도
                if (output.startsWith("{")) {
                  try {
                    const item = JSON.parse(output);
                    
                    // 메타데이터 저장 (첫 번째 항목)
                    if (firstVideo) {
                      metadata = item;
                      firstVideo = false;
                    }
                    
                    // 이미 확인한 비디오인지 확인
                    if (skipExisting && lastCheckedVideoId === item.id) {
                      console.log("Reached last checked video, stopping:", item.id);
                      skipExisting = false; // 이후 비디오부터 다운로드
                      currentProcess.kill(); // 프로세스 중지
                    } 
                    else if (!skipExisting) {
                      // 새 비디오를 발견한 경우
                      if (!updated) {
                        updated = true;
                        latestVideoId = item.id;
                      }
                    }
                  } catch (error) {
                    console.error("Failed to parse JSON:", error);
                    reject(
                      new Error(
                        `Failed to parse JSON output from yt-dlp: ${error.message}`
                      )
                    );
                  }
                }

                this.updateProgress(output);
              });

              currentProcess.stderr.on("data", (data) => {
                const errorOutput = data.toString();
                console.error("yt-dlp stderr:", errorOutput);
                this.updateStatusUI(`Error: ${errorOutput}`);
              });

              currentProcess.on("close", async (code) => {
                if (code === 0 || code === null) { // null은 kill() 호출 시
                  console.log(
                    `Finished checking playlist: ${sub.title || sub.url}`
                  );

                  // 다운로드 받은 파일들을 이글 라이브러리에 추가
                  if (updated) {
                    await this.importAndRemoveDownloadedFiles(
                      tempFolder,
                      sub.url,
                      metadata
                    );
                    console.log(
                      "Imported and removed downloaded files for playlist:",
                      sub.title
                    );

                    // 구독 정보 업데이트
                    sub.lastCheckedVideoId = latestVideoId;
                    sub.lastCheck = Date.now();
                    await this.saveSubscriptions();
                    console.log(
                      "Updated subscription details for:",
                      sub.title
                    );
                  }

                  resolve({ updated, metadata });
                } else {
                  reject(
                    new Error(
                      `yt-dlp process exited with code ${code} for playlist ${
                        sub.title || sub.url
                      }`
                    )
                  );
                }
              });
            }
          );

          // UI에 다운로드 완료 메시지 표시
          if (updated) {
            this.updateStatusUI(
              `Downloaded new videos from playlist ${sub.title || sub.url}`
            );
          } else {
            this.updateStatusUI(
              `No new videos found in playlist ${sub.title || sub.url}`
            );
          }
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
   * @returns {Promise<void>}
   */
  async importAndRemoveDownloadedFiles(folder, url, metadata) {
    try {
      const files = await fs.readdir(folder);
      console.log("Files in directory:", files);

      // 재생목록 이름으로 폴더 생성 (이미 존재하는 경우 해당 폴더 사용)
      let playlistFolderId = null;
      if (metadata.playlist) {
        try {
          const newFolder = await eagle.folder.create({
            name: metadata.playlist,
          });
          playlistFolderId = newFolder.id;
        } catch (error) {
          if (error.message.includes("already exists")) {
            const folders = await eagle.folder.get();
            const existingFolder = folders.find(
              (f) => f.name === metadata.playlist
            );
            if (existingFolder) {
              playlistFolderId = existingFolder.id;
            }
          } else {
            throw error;
          }
        }
      }

      // 파일 추가
      for (const file of files) {
        const filePath = path.join(folder, file);
        try {
          const fileStat = await fs.stat(filePath);
          if (fileStat.isFile()) {
            // 비디오 파일 메타데이터에서 필요한 정보 추출
            const videoTitle = path.basename(file, path.extname(file));

            // 메타데이터 준비
            const fileMetadata = {
              name: videoTitle,
              website: url,
              annotation: `Upload Date: ${
                metadata.upload_date || "N/A"
              }\nViews: ${metadata.view_count || "N/A"}`,
              tags: [
                `Platform: ${
                  url.includes("youtube.com") || url.includes("youtu.be")
                    ? "youtube.com"
                    : new URL(url).hostname
                }`,
                `Playlist: ${metadata.playlist || "N/A"}`,
                `Channel: ${metadata.uploader || "N/A"}`,
              ],
              folders: playlistFolderId ? [playlistFolderId] : [],
            };

            // Eagle 라이브러리에 비디오 파일 추가
            try {
              const item = await eagle.item.addFromPath(
                filePath,
                fileMetadata
              );
              console.log(`Added ${file} to Eagle`, item);
              this.emit('videoAdded', { file, metadata: fileMetadata });
            } catch (addError) {
              if (addError.message.includes("Item already exists")) {
                console.log(
                  `${file} already exists in Eagle library. Adding to folder.`
                );
                const items = await eagle.item.get({ website: url });
                if (items.length > 0) {
                  const item = items[0];
                  let newFolders = item.folders || [];
                  if (
                    playlistFolderId &&
                    !newFolders.includes(playlistFolderId)
                  ) {
                    newFolders.push(playlistFolderId);
                  }
                  await eagle.item.modify(item.id, {
                    folders: newFolders,
                  });
                  console.log(
                    `Updated item ${item.id} to include folder ${playlistFolderId}`
                  );
                } else {
                  console.error(`Failed to find item with URL ${url}`);
                }
              } else {
                throw addError;
              }
            }

            // 추가된 파일 삭제
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