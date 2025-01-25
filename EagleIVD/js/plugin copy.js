const { spawn } = require("child_process");
const fs = require("fs").promises;
const path = require("path");

// ------------------------------------------------------
// DownloadManager: yt-dlp 실행, 다운로드 관리
// (single/playlist 공통으로 사용)
// ------------------------------------------------------
class DownloadManager {
  constructor(pluginPath) {
    this.pluginPath = pluginPath;
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
      await fs.mkdir(this.downloadFolder, { recursive: true });
      console.log("Download folder ready:", this.downloadFolder);
    } catch (error) {
      console.error("Failed to init DownloadManager:", error);
      this.updateStatusUI(`Error init: ${error.message}`);
      throw error;
    }
  }

  // 단일 영상 메타 가져오기(간단히 첫번째 항목만)
  async getSingleMetadata(url) {
    return new Promise((resolve, reject) => {
      const args = [
        "--print-json",
        "--no-warnings",
        "--no-download",
        "--playlist-end",
        "1",
        url
      ];
      let output = "";
      const proc = spawn(this.ytDlpPath, args, { cwd: this.downloadFolder });
      proc.stdout.on("data", (data) => { output += data.toString(); });
      proc.stderr.on("data", (err) => { console.error("yt-dlp stderr:", err.toString()); });
      proc.on("close", (code) => {
        if (code === 0) {
          try {
            // 단일 항목 JSON 파싱
            const meta = JSON.parse(output);
            resolve(meta);
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`getSingleMetadata exited with code ${code}`));
        }
      });
    });
  }

  // 플레이리스트 전체 메타 가져오기
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

      proc.stdout.on("data", (data) => { allOutput += data.toString(); });
      proc.stderr.on("data", (err) => { console.error("yt-dlp stderr:", err.toString()); });
      proc.on("close", (code) => {
        if (code === 0) {
          try {
            const lines = allOutput.split("\n").filter(Boolean);
            const results = lines.map(line => JSON.parse(line));
            resolve(results); // [{id, title, url, ...}, ...]
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`getPlaylistMetadata exited with code ${code}`));
        }
      });
    });
  }

  // 실제 다운로드
  async startDownload(url, format, quality, speedLimit, concurrency) {
    if (this.isDownloading) {
      throw new Error("Download already in progress.");
    }
    this.isDownloading = true;
    this.updateStatusUI("Starting download...");

    const args = this.constructArgs(url, format, quality, speedLimit, concurrency);
    return new Promise((resolve, reject) => {
      this.currentProcess = spawn(this.ytDlpPath, args);
      this.updateCommandPreview(this.ytDlpPath, args);

      this.currentProcess.stdout.on("data", (data) => {
        const output = data.toString();
        console.log("yt-dlp stdout:", output);
        this.updateProgress(output);
      });
      this.currentProcess.stderr.on("data", (err) => {
        const str = err.toString();
        console.error("yt-dlp stderr:", str);
        this.updateStatusUI(`Error: ${str}`);
      });
      this.currentProcess.on("close", (code) => {
        this.isDownloading = false;
        this.currentProcess = null;
        if (code === 0) resolve();
        else reject(new Error(`Download failed with code ${code}`));
      });
    });
  }

  constructArgs(url, format, quality, speedLimit, concurrency) {
    // 파일명에 [%(id)s] 추가 -> 여러 개 영상일 때 videoId가 들어감
    const outputTemplate = "%(title)s [%(id)s].%(ext)s";

    const formatArgs = this.getFormatArgs(format, quality);
    const baseArgs = [
      "--ffmpeg-location", this.ffmpegPath,
      "-o", path.join(this.downloadFolder, outputTemplate),
      "--progress",
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
    let fmt = format;
    if (quality) fmt += `-${quality}`;
    return ["-f", fmt];
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
      const [_, progress, fileSize, speed, eta] = match;
      this.updateStatusUI(`Progress: ${progress}%, Size: ${fileSize}, Speed: ${speed}, ETA: ${eta}`);
    } else {
      this.updateStatusUI(output);
    }
  }

  updateCommandPreview(bin, args) {
    const cmd = `${bin} ${args.join(" ")}`;
    if (window.updateCommandPreview) {
      window.updateCommandPreview(cmd);
    }
  }

  updateStatusUI(message) {
    console.log("[DownloadManager] updateUI:", message);
    if (window.updateUI) {
      window.updateUI(message);
    }
  }
}

// FFmpeg 경로 가져오기
async function getFFmpegPath() {
  const ffmpegPaths = await eagle.extraModule.ffmpeg.getPaths();
  return ffmpegPaths.ffmpeg;
}

// ---------------------------------------------------------------------
// 단일 영상 다운로드 후 파일 -> Eagle 추가
// (파일명에 videoId가 없을 수 있으므로 간단히 "url"로 중복체크)
// ---------------------------------------------------------------------
async function importSingleDownloadedFiles(downloadFolder, meta, videoUrl) {
  try {
    const files = await fs.readdir(downloadFolder);
    for (const file of files) {
      const filePath = path.join(downloadFolder, file);
      const stat = await fs.stat(filePath);

      if (!stat.isFile()) continue;

      // single download -> 그냥 "videoUrl"을 website로
      const tags = [];
      if (meta && meta.extractor && meta.extractor.includes("youtube")) {
        tags.push("Platform: youtube.com");
      }
      // 중복 체크
      const existing = await eagle.item.get({ url: videoUrl });
      if (existing.length > 0) {
        // 기존 아이템 업데이트
        const existItem = await eagle.item.getById(existing[0].id);
        const newTags = new Set(existItem.tags || []);
        tags.forEach((t) => newTags.add(t));
        existItem.tags = Array.from(newTags);
        await existItem.save();

        console.log(`Updated existing single item:`, existItem.id);
      } else {
        // 새 아이템 추가
        const newId = await eagle.item.addFromPath(filePath, {
          name: meta.title || path.basename(file, path.extname(file)),
          website: videoUrl,
          annotation: `Uploader: ${meta.uploader || "N/A"}\nUploadDate: ${meta.upload_date || ""}`,
          tags
        });
        console.log("Single item added:", newId);
      }

      // 파일 삭제
      await fs.unlink(filePath);
      console.log("Removed downloaded file:", file);
    }
  } catch (err) {
    console.error("importSingleDownloadedFiles error:", err);
  }
}

// ---------------------------------------------------------------------
// 다중(플레이리스트) 파일 -> Eagle 추가
// (이미 작성된 importAndRemoveDownloadedFiles 함수 사용)
// ---------------------------------------------------------------------
async function importAndRemoveDownloadedFiles(folder, playlistMetadataMap) {
  try {
    const files = await fs.readdir(folder);
    console.log("Files in directory:", files);

    // 첫번째 영상 metadata로 플레이리스트명 추정
    let playlistFolderId = null;
    const exampleVideo = Object.values(playlistMetadataMap)[0];
    const playlistName = exampleVideo?.playlist_title || "MyPlaylist";
    // 폴더 생성 or 재활용
    try {
      const newFolder = await eagle.folder.create({ name: playlistName });
      playlistFolderId = newFolder.id;
    } catch (err) {
      if (err.message.includes("already exists")) {
        const allFolders = await eagle.folder.getAll();
        const existingFolder = allFolders.find(f => f.name === playlistName);
        if (existingFolder) {
          playlistFolderId = existingFolder.id;
        }
      } else {
        throw err;
      }
    }

    for (const file of files) {
      const filePath = path.join(folder, file);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }

      // 파일명에서 [videoId] 추출
      const match = file.match(/\[([A-Za-z0-9_-]{5,})\]\./);
      if (!match) {
        console.warn("Cannot find [id] in filename, skip:", file);
        continue;
      }
      const videoId = match[1];
      const metadata = playlistMetadataMap[videoId];
      if (!metadata) {
        console.warn("No metadata found for videoId:", videoId);
        continue;
      }

      // website = videoUrl
      const videoUrl = metadata.webpage_url || metadata.url;
      const tags = [`Uploader: ${metadata.uploader || "unknown"}`];
      if (metadata.extractor && metadata.extractor.includes("youtube")) {
        tags.push("Platform: youtube.com");
      }
      const itemMeta = {
        name: metadata.title || path.basename(file, path.extname(file)),
        website: videoUrl,
        annotation: `Upload Date: ${metadata.upload_date || "N/A"}\nViews: ${metadata.view_count || "N/A"}`,
        tags,
        folders: playlistFolderId ? [playlistFolderId] : [],
      };

      // 중복 체크
      const existing = await eagle.item.get({ url: videoUrl });
      if (existing.length > 0) {
        const existItem = await eagle.item.getById(existing[0].id);
        const newFolders = new Set(existItem.folders || []);
        if (playlistFolderId) newFolders.add(playlistFolderId);
        const newTags = new Set(existItem.tags || []);
        tags.forEach(t => newTags.add(t));
        existItem.folders = Array.from(newFolders);
        existItem.tags = Array.from(newTags);
        await existItem.save();
        console.log(`Updated existing item videoId=${videoId}`, existItem.id);
      } else {
        const newId = await eagle.item.addFromPath(filePath, itemMeta);
        console.log(`Added new item to Eagle. videoId=${videoId}`, newId);
      }

      // 파일 삭제
      await fs.unlink(filePath);
      console.log(`Removed file from downloads: ${file}`);
    }
  } catch (err) {
    console.error("Error in importAndRemoveDownloadedFiles:", err);
  }
}

// ---------------------------------------------------------------------
// SubscriptionManager: 구독 목록 관리
// (subscriptions.json) + checkAllSubscriptions 구현
// ---------------------------------------------------------------------
class SubscriptionManager {
  constructor(pluginPath) {
    this.subFile = path.join(pluginPath, "subscriptions.json");
    this.subscriptions = [];
    this.isChecking = false; // 체크 중이면 cancel 시그널 등 처리 가능
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
    // 중복 여부
    if (this.subscriptions.find(s => s.url === url)) {
      throw new Error("Already subscribed that URL");
    }
    const newSub = {
      url,
      folderName: folderName || "",
      format: format || "best",
      quality: quality || "",
      lastCheck: 0,
      title: "", // 나중에 구해올 수도 있음
    };
    this.subscriptions.push(newSub);
    await this.saveSubscriptions();
  }

  async removeSubscription(url) {
    this.subscriptions = this.subscriptions.filter(s => s.url !== url);
    await this.saveSubscriptions();
  }

  /**
   * checkAllSubscriptions
   * progressCallback(currentIndex, total, taskDesc)
   */
  async checkAllSubscriptions(progressCallback) {
    this.isChecking = true;
    const total = this.subscriptions.length;
    for (let i = 0; i < this.subscriptions.length; i++) {
      if (!this.isChecking) {
        console.log("Cancelled checkAllSubscriptions");
        return;
      }
      const sub = this.subscriptions[i];
      const idx = i + 1;
      if (progressCallback) {
        progressCallback(idx - 1, total, `Checking playlist: ${sub.url}`);
      }

      // 간단 구현: 플레이리스트 다운로드(전체), import
      // (실제로는 yt-dlp --download-archive나 lastCheck 활용해 '새 영상'만 받도록 가능)
      try {
        await downloadManager.startDownload(
          sub.url,
          sub.format || "best",
          sub.quality || "",
          "",
          1
        );
        // 메타 가져오기
        const metaArr = await downloadManager.getPlaylistMetadata(sub.url);
        const metaMap = {};
        metaArr.forEach(m => { if (m.id) metaMap[m.id] = m; });
        await importAndRemoveDownloadedFiles(downloadManager.downloadFolder, metaMap);

        sub.lastCheck = Date.now();
        // 임의로 첫번째 항목의 playlist_title을 sub.title로
        if (metaArr[0] && metaArr[0].playlist_title) {
          sub.title = metaArr[0].playlist_title;
        }
        // folderName은 이미 sub.folderName에 저장되어 있지만,
        // import 시에는 안 쓰고, default playlist_title만 사용 중
      } catch (err) {
        console.error("Subscription check error:", err);
      }
      await this.saveSubscriptions();

      if (progressCallback) {
        progressCallback(idx, total, `Finished playlist: ${sub.url}`);
      }
    }
    this.isChecking = false;
  }

  cancelCheck() {
    // 실제로는 yt-dlp 프로세스 cancelDownload() 호출
    this.isChecking = false;
    if (downloadManager) {
      downloadManager.cancel();
    }
  }
}

// 전역
let downloadManager;
let subscriptionManager;

eagle.onPluginCreate(async (plugin) => {
  console.log("onPluginCreate triggered");

  // Download Manager 초기화
  downloadManager = new DownloadManager(plugin.path);
  try {
    await downloadManager.initialize();
  } catch (e) {
    console.error("DownloadManager init error:", e);
    return;
  }

  // Subscription Manager 초기화
  subscriptionManager = new SubscriptionManager(plugin.path);
  await subscriptionManager.loadSubscriptions();

  // ---------------------------------------------------
  // Single Video
  // ---------------------------------------------------
  window.handleDownload = async (url, format, quality, speedLimit, concurrency) => {
    try {
      console.log("handleDownload single video:", url);
      // 1) 메타데이터
      let meta;
      try {
        meta = await downloadManager.getSingleMetadata(url);
      } catch (err) {
        console.warn("Fail to get single metadata, proceed with minimal info");
        meta = { webpage_url: url, title: url }; 
      }
      // 2) 다운로드
      await downloadManager.startDownload(url, format, quality, speedLimit, concurrency);
      console.log("Single download complete!");
      // 3) import
      await importSingleDownloadedFiles(downloadManager.downloadFolder, meta, url);
      if (window.updateUI) window.updateUI("Single download & import done.");
    } catch (e) {
      console.error("handleDownload error:", e);
      if (window.updateUI) window.updateUI("Single video download failed: " + e.message);
    }
  };

  // ---------------------------------------------------
  // Cancel Download
  // ---------------------------------------------------
  window.cancelDownload = () => {
    downloadManager.cancel();
  };

  // ---------------------------------------------------
  // Playlist Download
  // ---------------------------------------------------
  window.handleDownloadPlaylist = async (
    url, format, quality, speedLimit, concurrency
  ) => {
    try {
      console.log("Fetching metadata for entire playlist:", url);
      const playlistMetaArray = await downloadManager.getPlaylistMetadata(url);
      const playlistMetadataMap = {};
      for (const m of playlistMetaArray) {
        if (m.id) {
          playlistMetadataMap[m.id] = m;
        }
      }
      console.log("Got playlist metadata. Count =", playlistMetaArray.length);

      // 다운로드
      await downloadManager.startDownload(url, format, quality, speedLimit, concurrency);
      console.log("Playlist download complete!");

      // import
      await importAndRemoveDownloadedFiles(downloadManager.downloadFolder, playlistMetadataMap);
      if (window.updateUI) window.updateUI("Playlist download & import done.");
    } catch (err) {
      console.error("Download playlist error:", err);
      if (window.updateUI) window.updateUI("Playlist download failed: " + err.message);
    }
  };

  // ---------------------------------------------------
  // Subscription Functions
  // ---------------------------------------------------
  window.addSubscription = async ({ url, folderName, format, quality }) => {
    try {
      await subscriptionManager.addSubscription({ url, folderName, format, quality });
      // 로드/리턴할 필요 있으면 load 후 return
      const subs = await subscriptionManager.loadSubscriptions();
      if (window.updateUI) window.updateUI("Subscription added: " + url);
      return subs; 
    } catch (err) {
      throw err;
    }
  };

  window.removeSubscription = async (url) => {
    await subscriptionManager.removeSubscription(url);
    if (window.updateUI) window.updateUI("Subscription removed: " + url);
    const subs = await subscriptionManager.loadSubscriptions();
    return subs;
  };

  window.loadSubscriptions = async () => {
    // 그냥 subscriptions.json을 불러와서 반환
    const subs = await subscriptionManager.loadSubscriptions();
    return subs;
  };

  /**
   * checkAllSubscriptions(progressCallback)
   * progressCallback(currentIndex, totalCount, taskDesc)
   */
  window.checkAllSubscriptions = async (progressCallback) => {
    try {
      await subscriptionManager.checkAllSubscriptions((current, total, task) => {
        console.log(`Progress: ${current}/${total} : ${task}`);
        if (progressCallback) {
          progressCallback(current, total, task);
        }
      });
      if (window.updateUI) window.updateUI("All subscriptions checked.");
    } catch (e) {
      console.error("checkAllSubscriptions error:", e);
      if (window.updateUI) window.updateUI("Check subscriptions failed: " + e.message);
      throw e;
    }
  };
});

eagle.onPluginRun(() => {
  console.log("eagle.onPluginRun triggered");
});
