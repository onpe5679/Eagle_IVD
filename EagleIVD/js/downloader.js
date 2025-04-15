// downloader.js
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import * as api from "./api.js";

export class DownloadManager {
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
              console.error(`Failed to remove temp folder: ${tempFolder}`, error);
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
            reject(new Error(`Failed to parse metadata: ${error.message}`));
          }
        } else {
          reject(new Error(`yt-dlp exited with code ${code}`));
        }
      });
    });
  }

  getPlaylistId(url) {
    const match = url.match(/list=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
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

export async function importAndRemoveDownloadedFiles(folder, url, metadata) {
    try {
      const files = await fs.readdir(folder);
      console.log("Files in directory:", files);
      let playlistFolderId = null;
      if (metadata.playlist) {
        try {
          const newFolder = await window.api.createFolder(metadata.playlist);
          playlistFolderId = newFolder.id;
        } catch (error) {
          try {
            const existingFolder = await window.api.getFolderByName(metadata.playlist);
            if (existingFolder) {
              playlistFolderId = existingFolder.id;
            }
          } catch (e) {
            console.error("Error retrieving existing folder:", e);
          }
        }
      }
    // 각 파일에 대해 Eagle에 추가하고, 추가 후 파일 삭제
    for (const file of files) {
      const filePath = path.join(folder, file);
      try {
        const fileStat = await fs.stat(filePath);
        if (fileStat.isFile()) {
          const videoTitle = path.basename(file, path.extname(file));
          const fileMetadata = {
            name: videoTitle,
            website: url,
            annotation: `Upload Date: ${metadata.upload_date || "N/A"}\nViews: ${metadata.view_count || "N/A"}`,
            tags: [
              `Platform: ${url.includes("youtube.com") || url.includes("youtu.be") ? "youtube.com" : new URL(url).hostname}`,
              `Playlist: ${metadata.playlist || "N/A"}`,
              `Channel: ${metadata.uploader || "N/A"}`,
            ],
            folders: playlistFolderId ? [playlistFolderId] : [],
          };

          try {
            const itemId = await api.addItemFromPath(filePath, fileMetadata);
            console.log(`Added ${file} to Eagle, item ID: ${itemId}`);
          } catch (addError) {
            if (addError.message.includes("Item already exists")) {
              console.log(`${file} already exists in Eagle library. Adding to folder.`);
              // eagle.item.find 대신 getItemsByUrl 사용
              const items = await api.getItemsByUrl(url);
              if (items && items.length > 0) {
                const item = items[0];
                let newFolders = item.folders || [];
                if (playlistFolderId && !newFolders.includes(playlistFolderId)) {
                  newFolders.push(playlistFolderId);
                }
                await api.modifyItem(item.id, { folders: newFolders });
                console.log(`Updated item ${item.id} to include folder ${playlistFolderId}`);
              } else {
                console.error(`Failed to find item with URL ${url}`);
              }
            } else {
              throw addError;
            }
          }
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
