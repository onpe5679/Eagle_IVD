const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
  const subscriptionDb = require('./subscription-db'); // DB 모듈 추가

/**
 * 다운로드된 파일을 Eagle에 추가하고 정리하는 로직
 */
class SubscriptionImporter extends EventEmitter {
  /**
   * @param {function} updateStatusUI - 상태 메시지 업데이트 콜백
   * @param {boolean} prefixUploadDate - 파일명 앞에 업로드 날짜를 붙일지 여부
   */
  constructor(updateStatusUI, prefixUploadDate = true) {
    super();
    this.updateStatusUI = updateStatusUI;
    this.prefixUploadDate = prefixUploadDate;
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

  /**
   * 파일을 임포트한 후 다운로드 폴더를 정리합니다.
   * @param {string} folder - 다운로드된 파일이 있는 폴더 경로
   * @param {string} url - 원본 플레이리스트/채널 URL
   * @param {object} metadata - 플레이리스트 메타데이터
   * @param {string} customFolderName - 사용자 지정 폴더 이름
   * @param {object} videoMetadata - 각 비디오 ID별 메타데이터 매핑
   */
  async importAndRemoveDownloadedFiles(folder, url, metadata, customFolderName, videoMetadata = {}) {
    try {
      const files = await fs.readdir(folder);
      console.log("Files in directory:", files);

      // 30초 타임아웃 헬퍼
      const IMPORT_TIMEOUT_MS = 30000;
      const withTimeout = (promise) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Import timeout")), IMPORT_TIMEOUT_MS))
      ]);

      // 폴더명 결정: customFolderName 우선, 없으면 fallback
      const folderName = customFolderName && customFolderName.trim() ? 
        customFolderName : (metadata.playlist || this.getPlaylistId(url) || "Default Playlist");

      // 기존 폴더 확인 또는 생성
      let playlistFolderId = null;
      console.log(`Looking for existing folder: "${folderName}"`);
      try {
        const allFolders = await eagle.folder.getAll();
        console.log(`Total folders: ${allFolders.length}`);
        const exactMatch = allFolders.filter(f => f.name === folderName);
        if (exactMatch.length > 0) {
          playlistFolderId = exactMatch[0].id;
          console.log(`Using existing folder: "${folderName}" (ID: ${playlistFolderId})`);
        } else {
          try {
            const newFolder = await eagle.folder.create({ name: folderName });
            playlistFolderId = newFolder.id;
            console.log(`Created new folder: "${folderName}" (ID: ${playlistFolderId})`);
          } catch (createError) {
            if (createError.message.includes("already exists")) {
              const updated = await eagle.folder.getAll();
              const retry = updated.filter(f => f.name === folderName);
              if (retry.length > 0) {
                playlistFolderId = retry[0].id;
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
      } catch (err) {
        console.error("Error in folder operations:", err);
        throw err;
      }

      // 파일 추가 및 삭제
      for (const file of files) {
        if (file.endsWith(".part") || file.endsWith(".ytdl") || file.endsWith(".txt")) {
          console.log("Skipping non-video file:", file);
          continue;
        }
        const filePath = path.join(folder, file);
        try {
          const stats = await fs.stat(filePath);
          if (!stats.isFile()) continue;
          let videoId = null;
          let currentMeta = metadata;
          for (const id of Object.keys(videoMetadata)) {
            if (file.startsWith(`${id}_`)) {
              videoId = id;
              currentMeta = videoMetadata[id];
              console.log(`Extracted videoId ${videoId} from filename`);
              break;
            }
          }
          if (!videoId) {
            const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            videoId = m ? m[1] : null;
            if (videoId && videoMetadata[videoId]) currentMeta = videoMetadata[videoId];
            console.log(`Extracted videoId ${videoId} from URL`);
          }
          if (!videoId) {
            console.warn(`Could not determine videoId for file: ${file}, skipping DB update.`);
            continue; // videoId 없으면 DB 업데이트 불가
          }
          let title = path.basename(file, path.extname(file));
          if (title.startsWith(`${videoId}_`)) {
            title = title.slice(videoId.length + 1);
          }
          let displayName = title;
          if (this.prefixUploadDate && currentMeta.upload_date) {
            displayName = `${currentMeta.upload_date} ${title}`;
          }
          const fileMeta = {
            name: displayName,
            website: videoId ? `https://www.youtube.com/watch?v=${videoId}` : url,
            annotation: `Video ID: ${videoId || 'N/A'}\nUpload Date: ${currentMeta.upload_date || 'N/A'}\nViews: ${currentMeta.view_count || 'N/A'}`,
            tags: [
              `Platform: ${url.includes('youtube.com') ? 'youtube.com' : new URL(url).hostname}`,
              `Playlist: ${folderName}`,
              `Channel: ${currentMeta.uploader || 'N/A'}`
            ].filter(Boolean),
            folders: playlistFolderId ? [playlistFolderId] : []
          };
          try {
            const item = await withTimeout(eagle.item.addFromPath(filePath, fileMeta));
            console.log(`Added ${file} to Eagle`, item);
            this.emit('videoAdded', { file, metadata: fileMeta });
            // Eagle 추가 성공 시 DB 업데이트
            try {
              await subscriptionDb.markVideoAsEagleLinked(videoId);
              console.log(`[DB Update] Marked video ${videoId} as eagle_linked.`);
            } catch (dbError) {
              console.error(`[DB Update] Failed to mark video ${videoId} as eagle_linked:`, dbError);
            }
          } catch (addErr) {
            if (addErr.message === 'Import timeout') {
              console.error(`Import timeout for ${file}, skipping file.`);
            } else if (addErr.message.includes('Item already exists')) {
              console.log(`${file} already exists, adding to folder`);
              const searchURL = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
              try {
                const items = await withTimeout(eagle.item.get({ website: searchURL }));
                if (items.length) {
                  const existing = items[0];
                  const newFolders = new Set([...(existing.folders||[]), playlistFolderId]);
                  await withTimeout(eagle.item.modify(existing.id, { folders: [...newFolders] }));
                  // 중복 항목 처리 시에도 DB 업데이트
                  try {
                    await subscriptionDb.markVideoAsEagleLinked(videoId);
                    console.log(`[DB Update] Marked existing video ${videoId} as eagle_linked.`);
                  } catch (dbError) {
                    console.error(`[DB Update] Failed to mark existing video ${videoId} as eagle_linked:`, dbError);
                  }
                }
              } catch (dupErr) {
                console.error(`Error updating duplicate for ${file}:`, dupErr);
              }
            } else {
              console.error(`Error adding file ${file}:`, addErr);
            }
          }
          await fs.unlink(filePath);
          console.log(`Removed ${file} from downloads`);
        } catch (fileErr) {
          console.error(`Error processing file ${file}:`, fileErr);
        }
      }
    } catch (err) {
      console.error('Error in importAndRemoveDownloadedFiles:', err);
    }
  }
}

module.exports = SubscriptionImporter; 