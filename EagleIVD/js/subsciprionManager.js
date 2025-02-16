// subscriptionManager.js
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import * as api from "./api.js";
import { importAndRemoveDownloadedFiles } from "./downloader.js";

export class SubscriptionManager {
  constructor(pluginPath, downloadManager) {
    this.pluginPath = pluginPath;
    this.subFile = path.join(pluginPath, "subscriptions.json");
    this.subscriptions = [];
    this.downloadManager = downloadManager;
    this.isChecking = false;
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

    try {
      const metadata = await this.downloadManager.getMetadata(url);
      if (metadata) {
        newSub.title = metadata.playlist_title || metadata.playlist || url;
        if (metadata.entries && metadata.entries.length > 0) {
          newSub.lastCheckedVideoId = metadata.entries[0].id;
        } else {
          newSub.lastCheckedVideoId = null;
        }
      }
    } catch (error) {
      console.error("Error fetching playlist metadata:", error);
      newSub.title = url;
      newSub.lastCheckedVideoId = null;
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

        const playlistId = this.downloadManager.getPlaylistId(sub.url);
        const tempFolder = path.join(
          this.downloadManager.downloadFolder,
          "subscription_" + (playlistId || "default")
        );

        try {
          await fs.mkdir(tempFolder, { recursive: true });
          console.log(`Temp folder created or already exists: ${tempFolder}`);

          if (progressCallback) {
            progressCallback(current, total, `Checking playlist: ${sub.title || sub.url}`);
          }

          const lastCheckedVideoId = sub.lastCheckedVideoId;
          const args = [
            "--ffmpeg-location",
            this.downloadManager.ffmpegPath,
            "-o",
            `${tempFolder}/%(title)s.%(ext)s`,
            "--progress",
            "--no-warnings",
            "--newline",
            "--print-json",
            ...(lastCheckedVideoId ? ["--playlist-start", lastCheckedVideoId] : []),
            sub.url,
          ];

          const { updated, metadata, latestVideoId } = await new Promise((resolve, reject) => {
            let updated = false;
            let latestVideoId = null;
            let metadata = null;
            const currentProcess = spawn(this.downloadManager.ytDlpPath, args);

            currentProcess.stdout.on("data", (data) => {
              const output = data.toString();
              console.log("yt-dlp stdout:", output);

              if (output.startsWith("{")) {
                try {
                  const item = JSON.parse(output);
                  metadata = item;
                  if (!lastCheckedVideoId) {
                    updated = true;
                    latestVideoId = item.id;
                  } else if (item.id === lastCheckedVideoId) {
                    console.log("Reached last checked video, stopping:", item.id);
                    currentProcess.kill();
                  } else if (!updated) {
                    updated = true;
                    latestVideoId = item.id;
                  }
                } catch (error) {
                  console.error("Failed to parse JSON:", error);
                  reject(new Error(`Failed to parse JSON output from yt-dlp: ${error.message}`));
                }
              }

              this.downloadManager.updateProgress(output);
            });

            currentProcess.stderr.on("data", (data) => {
              const errorOutput = data.toString();
              console.error("yt-dlp stderr:", errorOutput);
              this.downloadManager.updateStatusUI(`Error: ${errorOutput}`);
            });

            currentProcess.on("close", async (code) => {
              if (code === 0) {
                console.log(`Finished checking playlist: ${sub.title || sub.url}`);
                if (updated) {
                  await importAndRemoveDownloadedFiles(tempFolder, sub.url, metadata);
                  console.log("Imported and removed downloaded files for playlist:", sub.title);
                  resolve({ updated, metadata, latestVideoId });
                } else {
                  resolve({ updated: false, metadata: null, latestVideoId: null });
                }
              } else {
                reject(new Error(`yt-dlp process exited with code ${code} for playlist ${sub.title || sub.url}`));
              }
            });
          });

          if (updated) {
            sub.lastCheckedVideoId = latestVideoId;
            sub.lastCheck = Date.now();
            await this.saveSubscriptions();
            this.downloadManager.updateStatusUI(`Downloaded new videos from playlist ${sub.title || sub.url}`);
          } else {
            this.downloadManager.updateStatusUI(`No new videos found in playlist ${sub.title || sub.url}`);
          }
        } catch (error) {
          console.error(`Error checking for new videos in playlist ${sub.title || sub.url}:`, error);
          this.downloadManager.updateStatusUI(`Error checking playlist ${sub.title || sub.url}: ${error.message}`);
        } finally {
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
    if (this.downloadManager) {
      this.downloadManager.cancel();
    }
  }
}
