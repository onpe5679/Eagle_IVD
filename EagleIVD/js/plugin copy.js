const { spawn } = require("child_process");
const fs = require("fs").promises;
const path = require("path");

class DownloadManager {
  constructor(pluginPath) {
    this.downloadFolder = path.join(pluginPath, "downloads");
    this.isDownloading = false;
    this.currentProcess = null;
    this.ytDlpPath = process.platform === "win32"
      ? path.join(pluginPath, "yt-dlp.exe")
      : path.join(pluginPath, "yt-dlp");
    this.ffmpegPath = null;
  }

  async initialize() {
    try {
      this.ffmpegPath = await getFFmpegPath();
      await this.initializeFolder();
    } catch (error) {
      console.error("Failed to initialize download manager:", error);
      this.updateStatusUI(`Error: Failed to initialize. ${error.message}`);
      throw error;
    }
  }

  async initializeFolder() {
    try {
      await fs.mkdir(this.downloadFolder, { recursive: true });
      console.log("Download folder ready:", this.downloadFolder);
    } catch (error) {
      console.error("Failed to create download folder:", error);
      throw error;
    }
  }

  async startDownload(url, format, quality, speedLimit, concurrency) {
    if (this.isDownloading) {
      throw new Error("Download already in progress");
    }

    this.isDownloading = true;
    this.updateStatusUI("Starting download...");

    const playlistId = this.getPlaylistId(url);
    const tempFolder = playlistId
      ? path.join(this.downloadFolder, playlistId)
      : this.downloadFolder;

    try {
      await fs.mkdir(tempFolder, { recursive: true });
      console.log("Temp download folder ready:", tempFolder);
    } catch (error) {
      console.error("Failed to create temp download folder:", error);
      this.isDownloading = false;
      throw error;
    }

    const args = this.constructArgs(
      url,
      format,
      quality,
      speedLimit,
      concurrency,
      tempFolder
    );

    return new Promise((resolve, reject) => {
      this.currentProcess = spawn(this.ytDlpPath, args);
      this.updateCommandPreview(this.ytDlpPath, args);

      this.currentProcess.stdout.on("data", (data) => {
        const output = data.toString();
        console.log("yt-dlp stdout:", output);
        this.updateProgress(output);
      });

      this.currentProcess.stderr.on("data", (data) => {
        const errorOutput = data.toString();
        console.error("yt-dlp stderr:", errorOutput);
        this.updateStatusUI(`Error: ${errorOutput}`);
      });

      this.currentProcess.on("close", async (code) => {
        this.isDownloading = false;
        this.currentProcess = null;

        if (code === 0) {
          if (playlistId) {
            try {
              await fs.rm(tempFolder, { recursive: true, force: true });
              console.log(`Removed temp folder: ${tempFolder}`);
            } catch (error) {
              console.error(
                `Failed to remove temp folder: ${tempFolder}`,
                error
              );
            }
          }
          resolve();
        } else {
          reject(new Error(`Download failed with code ${code}`));
        }
      });
    });
  }

  constructArgs(url, format, quality, speedLimit, concurrency, tempFolder) {
    const formatArgs = this.getFormatArgs(format, quality);
    const baseArgs = [
      "--ffmpeg-location",
      this.ffmpegPath,
      "-o",
      path.join(tempFolder, "%(title)s.%(ext)s"),
      "--progress",
      "--no-warnings",
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

  cancel() {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.isDownloading = false;
      this.currentProcess = null;
      this.updateStatusUI("Download cancelled");
    }
  }

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

  updateCommandPreview(ytDlpPath, args) {
    const command = `${ytDlpPath} ${args.join(" ")}`;
    if (window.updateCommandPreview) {
      window.updateCommandPreview(command);
    }
  }

  updateStatusUI(message) {
    console.log("updateUI called with message:", message);
    if (window.updateUI) {
      window.updateUI(message);
    }
  }

  async getMetadata(url) {
    const args = [
      "--ffmpeg-location",
      this.ffmpegPath,
      "--print-json",
      "--no-warnings",
      "--skip-download", // 메타데이터만 필요
      "--flat-playlist", // 재생목록도 단일 영상처럼 처리
      "--playlist-end",
      "1", // 재생목록을 단일 영상처럼 취급하기 위해 첫 번째 항목만 가져옴
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
            console.log("Raw metadata:", metadata); // 원본 JSON 출력
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

  getPlaylistId(url) {
    const match = url.match(/list=([a-zA-Z0-9_-]+)/);
    if (match) {
      return match[1];
    }
    return null;
  }

  async getPlaylistMetadata(url) {
    return new Promise((resolve, reject) => {
      const args = [
        "--flat-playlist",
        "--print-json",
        "--no-warnings",
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

async function getFFmpegPath() {
  try {
    const ffmpegPaths = await eagle.extraModule.ffmpeg.getPaths();
    console.log("ffmpeg paths:", ffmpegPaths);
    return ffmpegPaths.ffmpeg;
  } catch (error) {
    console.error("Failed to get FFmpeg path:", error);
    throw new Error("Failed to get FFmpeg path");
  }
}

async function importAndRemoveDownloadedFiles(folder, url, metadata) {
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
          } catch (addError) {
            if (addError.message.includes("Item already exists")) {
              console.log(
                `${file} already exists in Eagle library. Adding to folder.`
              );
              const items = await eagle.item.find({ website: url, });
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

// YouTube URL에서 썸네일과 제목을 가져오는 함수
async function fetchYoutubePreview(url) {
  try {
    const videoId = getYoutubeVideoId(url);
    if (!videoId) {
      throw new Error("Invalid YouTube URL");
    }

    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    const title = await getYoutubeVideoTitle(url);

    updateYoutubePreviewUI(thumbnailUrl, title);
  } catch (error) {
    console.error("Error fetching YouTube preview:", error);
    updateUI("Error fetching YouTube preview");
  }
}

// URL에서 YouTube 비디오 ID를 추출하는 함수
function getYoutubeVideoId(url) {
  const videoIdRegex =
    /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/;
  const match = url.match(videoIdRegex);
  return match ? match[1] : null;
}

// yt-dlp를 사용하여 YouTube 비디오 제목을 가져오는 함수
async function getYoutubeVideoTitle(url) {
  return new Promise((resolve, reject) => {
    const ytDlpProcess = spawn(downloadManager.ytDlpPath, [
      "--get-title",
      url,
    ]);
    let title = "";

    ytDlpProcess.stdout.on("data", (data) => {
      title += data.toString();
    });

    ytDlpProcess.stderr.on("data", (data) => {
      console.error("yt-dlp stderr:", data.toString());
    });

    ytDlpProcess.on("close", (code) => {
      if (code === 0) {
        resolve(title.trim());
      } else {
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });
  });
}

// UI에 YouTube 썸네일과 제목을 업데이트하는 함수
function updateYoutubePreviewUI(thumbnailUrl, title) {
  const youtubeThumb = document.getElementById("youtube-thumb");
  const youtubeTitle = document.getElementById("youtube-title");

  if (thumbnailUrl && youtubeThumb) {
    youtubeThumb.src = thumbnailUrl;
    youtubeThumb.classList.add("show");
  }

  if (title && youtubeTitle) {
    youtubeTitle.textContent = title;
  }
}

// ---------------------------------------------------
// SubscriptionManager: 구독 목록 관리
// (subscriptions.json) + checkAllSubscriptions 구현
// ---------------------------------------------------
class SubscriptionManager {
  constructor(pluginPath) {
    this.subFile = path.join(pluginPath, "subscriptions.json");
    this.subscriptions = [];
  }

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

  async saveSubscriptions() {
    await fs.writeFile(this.subFile, JSON.stringify(this.subscriptions, null, 2), "utf8");
  }

  async addSubscription({ url, folderName, format, quality }) {
    if (this.subscriptions.find(s => s.url === url)) {
      throw new Error("Already subscribed that URL");
    }

    const newSub = {
      url,
      folderName: folderName || "",
      format: format || "best",
      quality: quality || "",
      lastCheckedVideoId: null,
      title: "",
    };

    // 구독 정보를 가져오는 부분
    try {
      const metadata = await downloadManager.getMetadata(url);
      if (metadata) {
        newSub.title = metadata.playlist_title || metadata.playlist || playlistId;
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
  }

  async removeSubscription(url) {
    this.subscriptions = this.subscriptions.filter((s) => s.url !== url);
    await this.saveSubscriptions();
    console.log("Unsubscribed from playlist:", url);
  }

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

      const playlistId = downloadManager.getPlaylistId(sub.url);
      const tempFolder = path.join(
        downloadManager.downloadFolder,
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

        const lastCheckedVideoId = sub.lastCheckedVideoId;

        const args = [
          "--ffmpeg-location",
          downloadManager.ffmpegPath,
          "-o",
          `${tempFolder}/%(title)s.%(ext)s`,
          "--progress",
          "--no-warnings",
          "--newline",
          "--print-json", // JSON 형식의 출력을 위해 추가
          ...(lastCheckedVideoId
            ? ["--playlist-start", lastCheckedVideoId]
            : []),
          sub.url,
        ];

        const { updated, metadata } = await new Promise(
          (resolve, reject) => {
            let updated = false;
            let latestVideoId = null;
            let metadata = null;
            const currentProcess = spawn(downloadManager.ytDlpPath, args);

            currentProcess.stdout.on("data", (data) => {
              const output = data.toString();
              console.log("yt-dlp stdout:", output);

              // JSON 형식의 메타데이터 파싱 시도
              if (output.startsWith("{")) {
                try {
                  const item = JSON.parse(output);
                  metadata = item; // 첫 번째 항목의 메타데이터 저장
                  if (!lastCheckedVideoId) {
                    // 처음 동영상을 가져올때 lastCheckedVideoId이 undefined이므로 첫번째 영상 이후부터 저장
                    updated = true;
                    latestVideoId = item.id;
                  } else if (item.id === lastCheckedVideoId) {
                    // 더 이상 새 동영상이 없으므로 중지
                    console.log(
                      "Reached last checked video, stopping:",
                      item.id
                    );
                    currentProcess.kill(); // 프로세스 중지
                  } else if (!updated) {
                    // 첫 번째 새 동영상이면 lastCheckedVideoId을 업데이트
                    updated = true;
                    latestVideoId = item.id;
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

              downloadManager.updateProgress(output);
            });

            currentProcess.stderr.on("data", (data) => {
              const errorOutput = data.toString();
              console.error("yt-dlp stderr:", errorOutput);
              downloadManager.updateStatusUI(`Error: ${errorOutput}`);
            });

            currentProcess.on("close", async (code) => {
              if (code === 0) {
                console.log(
                  `Finished checking playlist: ${sub.title || sub.url}`
                );

                // 다운로드 받은 파일들을 이글 라이브러리에 추가
                if (updated) {
                  await importAndRemoveDownloadedFiles(
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
          downloadManager.updateStatusUI(
            `Downloaded new videos from playlist ${sub.title || sub.url}`
          );
        } else {
          downloadManager.updateStatusUI(
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
        downloadManager.updateStatusUI(
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
  }
}

  cancelCheck() {
    this.isChecking = false;
    if (downloadManager) {
      downloadManager.cancel();
    }
  }
}

let downloadManager;
let subscriptionManager;

eagle.onPluginCreate(async (plugin) => {
  console.log("onPluginCreate triggered");

  downloadManager = new DownloadManager(plugin.path);
  subscriptionManager = new SubscriptionManager(plugin.path);

  try {
    await downloadManager.initialize();
    await subscriptionManager.loadSubscriptions();
  } catch (error) {
    console.error("Failed to initialize managers:", error);
    return;
  }

  // UI 업데이트 함수
  function updateUI(message) {
    const statusArea = document.getElementById("statusArea");
    if (statusArea) {
      statusArea.textContent = message;
    }
  }

  // UI 업데이트 함수
  function updateUI(message) {
    const statusArea = document.getElementById("statusArea");
    if (statusArea) {
      statusArea.textContent = message;
    }
  }

  // 구독 목록 UI 업데이트 함수
  function updateSubscriptionListUI(subscriptions) {
    const subscriptionList = document.getElementById("subscriptionList");
    if (subscriptionList) {
      subscriptionList.innerHTML = ""; // 기존 목록을 지웁니다.

      subscriptions.forEach((subscription) => {
        const listItem = document.createElement("div");
        listItem.className = "subscription-item";
        listItem.innerHTML = `
                    <div class="font-semibold">${
                      subscription.title || "Untitled Playlist"
                    }</div>
                    <div class="text-sm text-gray-500">
                        URL: ${subscription.url}
                    </div>
                    <div class="text-sm text-gray-500">
                        Folder: ${
                          subscription.folderName || "Default"
                        } | Format: ${subscription.format} ${
          subscription.quality || ""
        }
                    </div>
                    <div class="text-sm text-gray-500">
                        Last Check: ${new Date(
                          subscription.lastCheck
                        ).toLocaleString()}
                    </div>
                `;
        subscriptionList.appendChild(listItem);
      });
    }
  }

  // window.handleDownload 함수 정의
  window.handleDownload = async (
    url,
    format,
    quality,
    speedLimit,
    concurrency
  ) => {
    try {
      console.log("Handling download for single URL:", url);
      const metadata = await downloadManager.getMetadata(url);
      console.log("Metadata fetched:", metadata);

      await downloadManager.startDownload(
        url,
        format,
        quality,
        speedLimit,
        concurrency
      );
      console.log("Download complete!");
      updateUI("Download complete!");

      await importAndRemoveDownloadedFiles(
        downloadManager.downloadFolder,
        url,
        metadata
      );
    } catch (error) {
      console.error("Download failed:", error);
      updateUI(`Download failed: ${error.message}`);
    }
  };

  // window.handleDownloadPlaylist 함수 정의
  window.handleDownloadPlaylist = async (
    url,
    format,
    quality,
    speedLimit,
    concurrency
  ) => {
    try {
      console.log("Handling download for playlist URL:", url);

      // 메타데이터를 먼저 가져옵니다.
      const playlistMetaArray = await downloadManager.getPlaylistMetadata(url);
      const playlistMetadataMap = {};
      playlistMetaArray.forEach((item) => {
        playlistMetadataMap[item.id] = item;
      });
      console.log(
        `Fetched metadata for ${playlistMetaArray.length} items in playlist.`
      );

      // 다운로드를 시작합니다.
      await downloadManager.startDownload(
        url,
        format,
        quality,
        speedLimit,
        concurrency
      );
      console.log("Playlist download complete!");
      updateUI("Playlist download complete!");

      // 다운로드 완료 후, 메타데이터를 사용하여 Eagle에 추가합니다.
      await importAndRemoveDownloadedFiles(
        downloadManager.downloadFolder,
        playlistMetadataMap
      );
    } catch (error) {
      console.error("Playlist download failed:", error);
      updateUI(`Playlist download failed: ${error.message}`);
    }
  };

  // window.cancelDownload 함수 정의
  window.cancelDownload = () => {
    downloadManager.cancel();
  };

  // window.fetchYoutubePreview 함수 정의
  window.fetchYoutubePreview = async (url) => {
    await fetchYoutubePreview(url);
  };

  // 구독 추가 함수
  window.addSubscription = async (subscriptionData) => {
    try {
      await subscriptionManager.addSubscription(subscriptionData);
      const subscriptions = await subscriptionManager.loadSubscriptions();
      updateSubscriptionListUI(subscriptions); // UI 업데이트
      updateUI(`Subscription added for: ${subscriptionData.url}`);
    } catch (error) {
      console.error("Failed to add subscription:", error);
      updateUI(`Error: ${error.message}`);
    }
  };

  // 구독 삭제 함수
  window.removeSubscription = async (url) => {
    try {
      await subscriptionManager.removeSubscription(url);
      const subscriptions = await subscriptionManager.loadSubscriptions();
      updateSubscriptionListUI(subscriptions); // UI 업데이트
      updateUI(`Subscription removed for: ${url}`);
    } catch (error) {
      console.error("Failed to remove subscription:", error);
      updateUI(`Error: ${error.message}`);
    }
  };

  // 구독 목록 불러오기 함수
  window.loadSubscriptions = async () => {
    const subscriptions = await subscriptionManager.loadSubscriptions();
    updateSubscriptionListUI(subscriptions); // UI 업데이트
    return subscriptions;
  };

  // 모든 구독 확인 함수
  window.checkAllSubscriptions = async (progressCallback) => {
    try {
      await subscriptionManager.checkAllSubscriptions(progressCallback);
      updateUI("All subscriptions checked for new videos.");
    } catch (error) {
      console.error("Failed to check subscriptions:", error);
      updateUI(`Error: ${error.message}`);
    }
  };
});

eagle.onPluginRun(() => {
  console.log("eagle.onPluginRun triggered");
});