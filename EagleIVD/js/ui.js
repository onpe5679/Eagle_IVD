// ui.js
import { DownloadManager } from "./downloader.js";
import { SubscriptionManager } from "./subscriptionManager.js";
import { spawn } from "child_process";

let downloadManager, subscriptionManager;

export async function initializeUI(plugin) {
  const pluginPath = plugin.path;
  downloadManager = new DownloadManager(pluginPath);
  subscriptionManager = new SubscriptionManager(pluginPath, downloadManager);

  try {
    await downloadManager.initialize();
    await subscriptionManager.loadSubscriptions();
  } catch (error) {
    console.error("Failed to initialize managers:", error);
    return;
  }

  // UI 업데이트 함수
  window.updateUI = function(message) {
    const statusArea = document.getElementById("statusArea");
    if (statusArea) {
      statusArea.textContent = message;
    }
  };

  window.updateCommandPreview = function(command) {
    const commandPreviewArea = document.getElementById("commandPreviewArea");
    const commandPreview = document.getElementById("commandPreview");
    if (commandPreviewArea && commandPreview) {
      commandPreviewArea.classList.remove("hidden");
      commandPreview.textContent = command;
    }
  };

  // 구독 목록 UI 업데이트
  function updateSubscriptionListUI(subscriptions) {
    const subscriptionList = document.getElementById("subscriptionList");
    if (subscriptionList) {
      subscriptionList.innerHTML = "";
      subscriptions.forEach((subscription) => {
        const listItem = document.createElement("div");
        listItem.className = "subscription-item";
        listItem.innerHTML = `
          <div class="font-semibold">${subscription.title || "Untitled Playlist"}</div>
          <div class="text-sm text-gray-500">URL: ${subscription.url}</div>
          <div class="text-sm text-gray-500">Folder: ${subscription.folderName || "Default"} | Format: ${subscription.format} ${subscription.quality || ""}</div>
          <div class="text-sm text-gray-500">Last Check: ${subscription.lastCheck ? new Date(subscription.lastCheck).toLocaleString() : "Never"}</div>
        `;
        subscriptionList.appendChild(listItem);
      });
    }
  }

  // 단일 영상 다운로드 함수
  window.handleDownload = async (url, format, quality, speedLimit, concurrency) => {
    try {
      console.log("Handling download for single URL:", url);
      const metadata = await downloadManager.getMetadata(url);
      console.log("Metadata fetched:", metadata);
      await downloadManager.startDownload(url, format, quality, speedLimit, concurrency);
      console.log("Download complete!");
      updateUI("Download complete!");
      await importAndRemoveDownloadedFiles(downloadManager.downloadFolder, url, metadata);
    } catch (error) {
      console.error("Download failed:", error);
      updateUI(`Download failed: ${error.message}`);
    }
  };

  // 재생목록 다운로드 함수
  window.handleDownloadPlaylist = async (url, format, quality, speedLimit, concurrency) => {
    try {
      console.log("Handling download for playlist URL:", url);
      const playlistMetaArray = await downloadManager.getPlaylistMetadata(url);
      const playlistMetadataMap = {};
      playlistMetaArray.forEach((item) => {
        playlistMetadataMap[item.id] = item;
      });
      console.log(`Fetched metadata for ${playlistMetaArray.length} items in playlist.`);
      await downloadManager.startDownload(url, format, quality, speedLimit, concurrency);
      console.log("Playlist download complete!");
      updateUI("Playlist download complete!");
      await importAndRemoveDownloadedFiles(downloadManager.downloadFolder, url, playlistMetadataMap);
    } catch (error) {
      console.error("Playlist download failed:", error);
      updateUI(`Playlist download failed: ${error.message}`);
    }
  };

  window.cancelDownload = () => {
    downloadManager.cancel();
  };

  // YouTube 미리보기 함수
  window.fetchYoutubePreview = async (url) => {
    try {
      const videoId = getYoutubeVideoId(url);
      if (!videoId) throw new Error("Invalid YouTube URL");
      const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
      const title = await getYoutubeVideoTitle(url);
      updateYoutubePreviewUI(thumbnailUrl, title);
    } catch (error) {
      console.error("Error fetching YouTube preview:", error);
      updateUI("Error fetching YouTube preview");
    }
  };

  function getYoutubeVideoId(url) {
    const videoIdRegex = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/;
    const match = url.match(videoIdRegex);
    return match ? match[1] : null;
  }

  async function getYoutubeVideoTitle(url) {
    return new Promise((resolve, reject) => {
      const ytDlpProcess = spawn(downloadManager.ytDlpPath, ["--get-title", url]);
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

  // 구독 관련 함수
  window.addSubscription = async (subscriptionData) => {
    try {
      await subscriptionManager.addSubscription(subscriptionData);
      const subscriptions = await subscriptionManager.loadSubscriptions();
      updateSubscriptionListUI(subscriptions);
      updateUI(`Subscription added for: ${subscriptionData.url}`);
    } catch (error) {
      console.error("Failed to add subscription:", error);
      updateUI(`Error: ${error.message}`);
    }
  };

  window.removeSubscription = async (url) => {
    try {
      await subscriptionManager.removeSubscription(url);
      const subscriptions = await subscriptionManager.loadSubscriptions();
      updateSubscriptionListUI(subscriptions);
      updateUI(`Subscription removed for: ${url}`);
    } catch (error) {
      console.error("Failed to remove subscription:", error);
      updateUI(`Error: ${error.message}`);
    }
  };

  window.loadSubscriptions = async () => {
    const subscriptions = await subscriptionManager.loadSubscriptions();
    updateSubscriptionListUI(subscriptions);
    return subscriptions;
  };

  window.checkAllSubscriptions = async (progressCallback) => {
    try {
      await subscriptionManager.checkAllSubscriptions(progressCallback);
      updateUI("All subscriptions checked for new videos.");
    } catch (error) {
      console.error("Failed to check subscriptions:", error);
      updateUI(`Error: ${error.message}`);
    }
  };

  // (추가적으로 탭 전환 등 UI 이벤트 바인딩은 여기서 처리하시면 됩니다.)
}
